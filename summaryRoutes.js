const express = require("express");
const fetch = require("node-fetch");
const { google } = require("googleapis");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

const router = express.Router();

// CONFIG
const PROJECT_ID = process.env.GCP_PROJECT_ID || "your-project-id";
const SECRET_NAME = process.env.SECRET_NAME || "INOUMemoryServiceAccount";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "your-spreadsheet-id";
const RANGE_NAME = "Memory!A:F"; // includes ID column
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

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

async function updateConfirmationStatus(rowIndex, status) {
  const sheets = await getSheetsService();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Memory!F${rowIndex}`, // Column F = Confirmation Status
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });
}

// --- ROUTES ---
// Preview card
router.post("/preview", (req, res) => {
  const conversation = req.body.conversation || "";
  const card = createSummaryCard(conversation);

  pendingCards.push(card);
  lastActivityTime = Date.now();

  res.json({ summary_card: card, status: "pending" });
});

// Save card (mark confirmed)
router.post("/save", async (req, res) => {
  try {
    const row = req.body.row;
    if (!row) return res.status(400).json({ error: "Missing row data" });

    row["Confirmation Status"] = "confirmed";

    const response = await fetch("http://localhost:3000/api/memory", {
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

// Discard card
router.post("/discard", (req, res) => {
  const row = req.body.row;
  if (!row) return res.status(400).json({ error: "Missing row data" });

  pendingCards = pendingCards.filter((c) => c !== row);
  lastActivityTime = Date.now();

  res.json({ status: "discarded" });
});

// View pending
router.get("/pending", (req, res) => {
  res.json({ pendingCards });
});

// --- BACKGROUND TASKS ---
// Inactivity monitor
setInterval(() => {
  if (pendingCards.length > 0 && Date.now() - lastActivityTime >= 10 * 60 * 1000) {
    console.log("⏳ 10 minutes inactivity — cards pending confirmation.");
    console.log(pendingCards);
  }
}, 60 * 1000);

// Auto-delete stale pending rows (older than 7 days)
async function autoDeleteExpiredCards() {
  const sheets = await getSheetsService();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RANGE_NAME,
  });

  let rows = result.data.values || [];
  rows.slice(1).forEach(async (row, i) => {
    const lastUpdated = new Date(row[4]); // Column E = Last Updated
    const status = row[5]; // Column F = Confirmation Status
    const diffDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

    if (status === "pending" && diffDays > 7) {
      await updateConfirmationStatus(i + 2, "auto-deleted"); // +2 because header row
      console.log(`🗑️ Row ${i + 2} marked as auto-deleted due to inactivity`);
    }
  });
}

// Run once per day
setInterval(autoDeleteExpiredCards, 24 * 60 * 60 * 1000);

module.exports = router;
