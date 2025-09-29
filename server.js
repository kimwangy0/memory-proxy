const express = require("express");
const { google } = require("googleapis");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

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
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env var");
  }
  const smCreds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
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

    // Convert rows → objects with headers
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
    if (rowData.data && !Array.isArr
