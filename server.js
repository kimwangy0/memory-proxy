// server.js

const express = require("express");
const { google } = require("googleapis");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const dayjs = require("dayjs");

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG: Spreadsheet + GCP
const PROJECT_ID = process.env.GCP_PROJECT_ID || "your-project-id";
const SECRET_NAME = process.env.SECRET_NAME || "INOUMemoryServiceAccount";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "your-spreadsheet-id";
const RANGE_NAME = "Memory!A:F"; // includes ID column
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// ⚠️ Replace with your Memory sheet’s gid (#gid=xxxxx in the URL)
const MEMORY_SHEET_ID = parseInt(process.env.MEMORY_SHEET_ID || "0", 10);

// 🔑 Secret Manager client
function getSecretManagerClient() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_B64) {
    throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_B64 env var");
  }
  const decoded = Buffer.from(
    process.env.GOOGLE_APPLICATION_CREDENTIALS_B64,
    "base64"
  ).toString("utf8");
  const smCreds = JSON.parse(decoded);
  return new SecretManagerServiceClient({ credentials: smCreds });
}

const secretClient = getSecretManagerClient();

// 🔑 Fetch creds
async function getServiceAccountCredentials() {
  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest`,
  });
  return JSON.parse(version.payload.data.toString("utf8"));
}

// 🔑 Sheets API client
async function getSheetsService() {
  const creds = await getServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: SCOPES,
  });
  return google.sheets({ version: "v4", auth });
}

/**
 * 🧹 Auto-clean pending rows older than 7 days
 */
async function cleanupOldPending() {
  let deletedIDs = [];
  try {
    const sheets = await getSheetsService();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
    });

    const rows = result.data.values || [];
    const headers = ["ID", "Topics", "Tags", "key facts", "Last Updated", "Confirmation Status"];
    const now = dayjs();

    // loop through rows (skip header row)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowObj = {};
      headers.forEach((h, j) => (rowObj[h] = row[j] || ""));

      if (rowObj["Confirmation Status"] === "pending") {
        const lastUpdated = dayjs(rowObj["Last Updated"]);
        if (now.diff(lastUpdated, "day") >= 7) {
          // delete this row
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
              requests: [
                {
                  deleteDimension: {
                    range: {
                      sheetId: MEMORY_SHEET_ID,
                      dimension: "ROWS",
                      startIndex: i,     // 0-based index (header row = 0)
                      endIndex: i + 1,
                    },
                  },
                },
              ],
            },
          });
          deletedIDs.push(rowObj.ID);
          console.log(`🧹 Auto-deleted row ID ${rowObj.ID} (older than 7 days, still pending)`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Error during cleanup:", err.message);
  }
  return deletedIDs;
}

// ✅ Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Memory Proxy (Google Sheets)",
    timestamp: new Date().toISOString(),
  });
});

// ✅ Manual cleanup endpoint
app.delete("/api/memory/cleanup", async (req, res) => {
  const deletedIDs = await cleanupOldPending();
  res.json({
    success: true,
    message: `Cleanup completed. Deleted ${deletedIDs.length} rows.`,
    deletedIDs,
  });
});

// ✅ GET /api/memory
app.get("/api/memory", async (req, res) => {
  try {
    const { topic, tag, since, q } = req.query;
    const sheets = await getSheetsService();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
    });

    let rows = result.data.values || [];
    const headers = ["ID", "Topics", "Tags", "key facts", "Last Updated", "Confirmation Status"];

    rows = rows.slice(1).map((row) => {
      let obj = {};
      headers.forEach((h, i) => (obj[h] = row[i] || ""));
      return obj;
    });

    const filtered = rows.filter((row) => {
      let match = true;
      if (topic && row.Topics.toLowerCase() !== topic.toLowerCase()) match = false;
      if (tag && !row.Tags.toLowerCase().includes(tag.toLowerCase())) match = false;
      if (since && new Date(row["Last Updated"]) < new Date(since)) match = false;
      if (q) {
        const query = q.toLowerCase();
        const values = Object.values(row).map((v) => String(v).toLowerCase());
        if (!values.some((v) => v.includes(query))) match = false;
      }
      return match;
    });

    res.json({ data: filtered });
  } catch (err) {
    console.error("❌ Error fetching sheet:", err.message);
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

// ✅ POST /api/memory (add new row with unique ID)
app.post("/api/memory", express.json(), async (req, res) => {
  try {
    let rowData = req.body;
    if (rowData.data && !Array.isArray(rowData.data)) {
      rowData = rowData.data;
    } else if (rowData.data && Array.isArray(rowData.data)) {
      rowData = rowData.data[0];
    }

    if (!rowData.Topics || !rowData.Tags || !rowData["key facts"]) {
      return res.status(400).json({
        error: "Missing required fields: Topics, Tags, key facts",
      });
    }

    const sheets = await getSheetsService();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
    });

    let rows = result.data.values || [];
    let maxID = 0;
    rows.slice(1).forEach((row) => {
      const idVal = parseInt(row[0]);
      if (!isNaN(idVal) && idVal > maxID) maxID = idVal;
    });
    const nextID = maxID + 1;

    const newRow = [
      nextID,
      rowData.Topics,
      rowData.Tags,
      rowData["key facts"],
      new Date().toISOString().slice(0, 10),
      rowData["Confirmation Status"] || "pending",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] },
    });

    res.json({ success: true, message: "Row added successfully", sentPayload: newRow });
  } catch (err) {
    console.error("❌ Error adding row:", err.message);
    res.status(500).json({ error: "Failed to add row", details: err.message });
  }
});

// ✅ PUT /api/memory → update Confirmation Status by ID
app.put("/api/memory", express.json(), async (req, res) => {
  try {
    const { ID, ConfirmationStatus } = req.body;
    if (!ID || !ConfirmationStatus) {
      return res.status(400).json({
        error: "Missing required fields: ID and ConfirmationStatus",
      });
    }

    const sheets = await getSheetsService();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
    });

    let rows = result.data.values || [];
    let targetRowIndex = -1;

    rows.slice(1).forEach((row, i) => {
      if (row[0] == ID) {
        targetRowIndex = i + 2; // +2 = account for header row
      }
    });

    if (targetRowIndex === -1) {
      return res.status(404).json({ error: `Row with ID ${ID} not found (it may have been deleted)` });
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Memory!F${targetRowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[ConfirmationStatus]] },
    });

    res.json({
      success: true,
      message: `Row updated: ID ${ID}`,
      ConfirmationStatus,
    });
  } catch (err) {
    console.error("❌ Error updating row:", err.message);
    res.status(500).json({ error: "Failed to update row", details: err.message });
  }
});

// ✅ DELETE /api/memory → hard delete by ID
app.delete("/api/memory", express.json(), async (req, res) => {
  try {
    const ID = req.body?.ID || req.query?.ID;
    if (!ID) return res.status(400).json({ error: "Missing required field: ID" });

    const sheets = await getSheetsService();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
    });

    let rows = result.data.values || [];
    let targetRowIndex = -1;

    rows.slice(1).forEach((row, i) => {
      if (row[0] == ID) targetRowIndex = i + 1; // +1 for zero-based index offset
    });

    if (targetRowIndex === -1) {
      return res.status(404).json({ error: `Row with ID ${ID} not found` });
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: MEMORY_SHEET_ID,
                dimension: "ROWS",
                startIndex: targetRowIndex,
                endIndex: targetRowIndex + 1,
              },
            },
          },
        ],
      },
    });

    res.json({ success: true, message: `Row hard deleted: ID ${ID}` });
  } catch (err) {
    console.error("❌ Error deleting row:", err.message);
    res.status(500).json({ error: "Failed to hard delete row", details: err.message });
  }
});

// ✅ POST /api/memory/summary → auto-generate a summary row
app.post("/api/memory/summary", express.json(), async (req, res) => {
  try {
    let summary = req.body;

    if (!summary.Topics || !summary["key facts"]) {
      return res.status(400).json({
        error: "Missing required fields: Topics and key facts",
      });
    }

    const sheets = await getSheetsService();

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
    });

    let rows = result.data.values || [];
    let maxID = 0;
    rows.slice(1).forEach((row) => {
      const idVal = parseInt(row[0]);
      if (!isNaN(idVal) && idVal > maxID) maxID = idVal;
    });
    const nextID = maxID + 1;

    const newRow = [
      nextID,
      summary.Topics,
      summary.Tags || "",
      summary["key facts"],
      new Date().toISOString().slice(0, 10),
      summary["Confirmation Status"] || "pending",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] },
    });

    res.json({
      success: true,
      message: "Auto-summary row added successfully",
      sentPayload: newRow,
    });
  } catch (err) {
    console.error("❌ Error adding auto-summary:", err.message);
    res.status(500).json({ error: "Failed to add auto-summary row", details: err.message });
  }
});

// ✅ Start server + run cleanup once on startup
app.listen(PORT, async () => {
  console.log(`🚀 Memory Proxy running at http://localhost:${PORT}/api/memory`);
  console.log(`🚀 Auto-Summary available at http://localhost:${PORT}/api/memory/summary`);
  console.log(`🚀 Manual Cleanup available at http://localhost:${PORT}/api/memory/cleanup`);

  console.log("🧹 Running startup cleanup of old pending rows...");
  await cleanupOldPending();
});
