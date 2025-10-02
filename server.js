const express = require("express");
const { google } = require("googleapis");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIG: Spreadsheet + GCP
const PROJECT_ID = process.env.GCP_PROJECT_ID || "your-project-id";
const SECRET_NAME = process.env.SECRET_NAME || "INOUMemoryServiceAccount";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "your-spreadsheet-id";
const RANGE_NAME = "Memory!A:D";
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

// ✅ GET /api/memory → fetch + filter data
app.get("/api/memory", async (req, res) => {
  try {
    const { topic, tag, since, q } = req.query;

    const sheets = await getSheetsService();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
    });

    let rows = result.data.values || [];
    const headers = ["Topics", "Tags", "key facts", "Last Updated"];

    rows = rows.slice(1).map((row) => {
      let obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] || "";
      });
      return obj;
    });

    // Apply filters
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

// ✅ POST /api/memory → add a new row
app.post("/api/memory", express.json(), async (req, res) => {
  try {
    let rowData = req.body;

    // Normalize nested structures
    if (rowData.data && !Array.isArray(rowData.data)) {
      rowData = rowData.data;
    } else if (rowData.data && Array.isArray(rowData.data)) {
      rowData = rowData.data[0];
    }

    // 🔑 Validation
    if (!rowData.Topics || !rowData.Tags || !rowData["key facts"]) {
      return res.status(400).json({
        error: "Missing required fields: Topics, Tags, key facts",
      });
    }

    const newRow = [
      rowData.Topics,
      rowData.Tags,
      rowData["key facts"],
      new Date().toISOString().slice(0, 10),
    ];

    const sheets = await getSheetsService();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] },
    });

    res.json({
      success: true,
      message: "Row added successfully",
      sentPayload: newRow,
    });
  } catch (err) {
    console.error("❌ Error adding row:", err.message);
    res.status(500).json({ error: "Failed to add row", details: err.message });
  }
});

/* ==========================================================
   SUMMARY CARD WORKFLOW (Preview → Save → Discard → Pending)
   ========================================================== */

let pendingCards = [];
let lastActivityTime = Date.now();

// Inactivity monitor (runs every 1 min)
setInterval(() => {
  if (pendingCards.length > 0 && Date.now() - lastActivityTime >= 10 * 60 * 1000) {
    console.log("⏳ 10 minutes of inactivity — pending summary cards:");
    console.log(pendingCards);
    // 👉 You could auto-save here if desired
  }
}, 60 * 1000);

function createSummaryCard(conversationText) {
  return {
    Topics: "Workflow Automation",
    Tags: "schema, workflow, validation",
    "key facts": conversationText || "Default key facts placeholder",
    "Last Updated": new Date().toISOString(),
  };
}

// 🔹 Preview
app.post("/api/summary/preview", express.json(), (req, res) => {
  const conversation = req.body.conversation || "";
  const card = createSummaryCard(conversation);

  pendingCards.push(card);
  lastActivityTime = Date.now();

  res.json({ summary_card: card, status: "pending" });
});

// 🔹 Save (commits to Sheets)
app.post("/api/summary/save", express.json(), async (req, res) => {
  try {
    const row = req.body.row;
    if (!row) return res.status(400).json({ error: "Missing row data" });

    const response = await fetch(`http://localhost:${PORT}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: row }),
    });

    if (response.ok) {
      pendingCards = pendingCards.filter((c) => c !== row);
      lastActivityTime = Date.now();
      res.json({ status: "saved", row });
    } else {
      const errText = await response.text();
      res.status(500).json({ error: "Failed to save row", details: errText });
    }
  } catch (err) {
    res.status(500).json({ error: "Unexpected error", details: err.message });
  }
});

// 🔹 Discard
app.post("/api/summary/discard", express.json(), (req, res) => {
  const row = req.body.row;
  if (!row) return res.status(400).json({ error: "Missing row data" });

  pendingCards = pendingCards.filter((c) => c !== row);
  lastActivityTime = Date.now();

  res.json({ status: "discarded" });
});

// 🔹 View pending
app.get("/api/summary/pending", (req, res) => {
  res.json({ pendingCards });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Memory Proxy running at http://localhost:${PORT}/api/memory`);
  console.log(`🚀 Summary Routes available at http://localhost:${PORT}/api/summary`);
});
