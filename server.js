const express = require("express");
const { google } = require("googleapis");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG: Spreadsheet + GCP
const PROJECT_ID = process.env.GCP_PROJECT_ID || "your-project-id";
const SECRET_NAME = process.env.SECRET_NAME || "INOUMemoryServiceAccount";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "your-spreadsheet-id";
const RANGE_NAME = "Memory!A:F"; // now includes ID column
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// 🔑 Load GCP service account creds for Secret Manager access
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

// 🔑 Fetch service account creds (for Sheets) from Secret Manager
async function getServiceAccountCredentials() {
  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest`,
  });
  return JSON.parse(version.payload.data.toString("utf8"));
}

// 🔑 Build Sheets API client
async function getSheetsService() {
  const creds = await getServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: SCOPES,
  });
  return google.sheets({ version: "v4", auth });
}

// ✅ Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Memory Proxy (Google Sheets)",
    timestamp: new Date().toISOString(),
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
    const headers = [
      "ID",
      "Topics",
      "Tags",
      "key facts",
      "Last Updated",
      "Confirmation Status",
    ];

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

// ✅ POST /api/memory
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

    const rowCount = result.data.values ? result.data.values.length : 1;
    const nextID = rowCount; // assign sequential ID

    const newRow = [
      nextID, // ID in Column A
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
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Memory!F${parseInt(ID) + 1}`, // F = Confirmation Status col
      valueInputOption: "RAW",
      requestBody: { values: [[ConfirmationStatus]] },
    });

    res.json({ success: true, message: `Row updated: ID ${ID}`, ConfirmationStatus });
  } catch (err) {
    console.error("❌ Error updating row:", err.message);
    res.status(500).json({ error: "Failed to update row", details: err.message });
  }
});

// ✅ DELETE /api/memory → delete by ID
app.delete("/api/memory", express.json(), async (req, res) => {
  try {
    const { ID } = req.body;
    if (!ID) return res.status(400).json({ error: "Missing required field: ID" });

    const sheets = await getSheetsService();
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `Memory!A${parseInt(ID) + 1}:F${parseInt(ID) + 1}`,
    });

    res.json({ success: true, message: `Row deleted: ID ${ID}` });
  } catch (err) {
    console.error("❌ Error deleting row:", err.message);
    res.status(500).json({ error: "Failed to delete row", details: err.message });
  }
});

// ✅ Mount summary routes
const summaryRoutes = require("./summaryRoutes");
app.use("/api/summary", summaryRoutes);

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Memory Proxy running at http://localhost:${PORT}/api/memory`);
  console.log(`🚀 Summary Routes available at http://localhost:${PORT}/api/summary`);
});
