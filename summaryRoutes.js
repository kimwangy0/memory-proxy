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
const MEMORY_SHEET_ID = parseInt(process.env.MEMORY_SHEET_ID || "0", 10);

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
      header
