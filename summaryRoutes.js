const express = require("express");
const { google } = require("googleapis");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

// Use dynamic import for node-fetch (since v3 is ESM-only)
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const router = express.Router();

// CONFIG
const PROJECT_ID = process.env.GCP_PROJECT_ID || "your-project-id";
const SECRET_NAME = process.env.SECRET_NAME || "INOUMemoryServiceAccount";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "your-spreadsheet-id";
const RANGE_NAME = "Memory!A:F";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const MEMORY_SHEET_ID = parseInt(process.env.MEMORY_SHEET_ID || "0", 10);

// ✅ API base URL (local or deployed)
const MEMORY_API_URL = process.env.MEMORY_API_URL || "http://localhost:3000/api/memory";

function getSecretManagerClient() {
  const decoded = Buffer.from(
    process.env.GOOGLE_APPLICATION_CREDENTIALS_B64,
    "base64"
  ).toString("utf8");
  const smCreds = JSON.parse(decoded);
  return new SecretManagerServiceClient({ credentials: smCreds });
}

const secretClient = getSecretManagerClient();

async function getServiceAccountCredentials() {
  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest`,
  });
  return JSON.parse(version.payload.data.toString("utf8"));
}

async function getSheetsService() {
  const creds = await getServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: SCOPES,
  });
  return google.sheets({ version: "v4", auth });
}

// --- Local memory queue ---
let pendingCards = [];
let lastActivityTime = Date.now();

// --- Helpers ---
function createSummaryCard(conversationText) {
  return {
    Topics: "Workflow Automation",
    Tags: "schema, workflow, validation",
    "key facts": conversationText || "Default key facts placeholder",
    "Last Updated": new Date().toISOString(),
    "Confirmation Status": "pending",
  };
}

// --- ROUTES ---
router.post("/preview", (req, res) => {
  const conversation = req.body.conversation || "";
  const card = createSummaryCard(conversation);
  pendingCards.push(card);
  lastActivityTime = Date.now();
  res.json({ summary_card: card, status: "pending" });
});

router.post("/save", async (req, res) => {
  try {
    const row = req.body.row;
    if (!row) return res.status(400).json({ error: "Missing row data" });

    row["Confirmation Status"] = "confirmed";

    const response = await fetch(`${MEMORY_API_URL}`, {
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

router.post("/discard", (req, res) => {
  const row = req.body.row;
  if (!row) return res.status(400).json({ error: "Missing row data" });

  pendingCards = pendingCards.filter((c) => c !== row);
  lastActivityTime = Date.now();

  res.json({ status: "discarded" });
});

router.get("/pending", (req, res) => {
  res.json({ pendingCards });
});

// --- AUTO-HARD DELETE STALE PENDING ROWS ---
async function autoDeleteExpiredCards() {
  const sheets = await getSheetsService();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RANGE_NAME,
  });

  let rows = result.data.values || [];
  rows.slice(1).forEach(async (row, i) => {
    const lastUpdated = new Date(row[4]);
    const status = row[5];
    const diffDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

    if (status === "pending" && diffDays > 7) {
      const rowIndex = i + 1; // +1 offset for header
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId: MEMORY_SHEET_ID,
                    dimension: "ROWS",
                    startIndex: rowIndex,
                    endIndex: rowIndex + 1,
                  },
                },
              },
            ],
          },
        });
        console.log(`🗑️ Row ${i + 2} hard deleted due to inactivity`);
      } catch (err) {
        console.error(`❌ Failed to hard delete row ${i + 2}:`, err.message);
      }
    }
  });
}

setInterval(autoDeleteExpiredCards, 24 * 60 * 60 * 1000);

module.exports = router;
