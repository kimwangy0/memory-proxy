import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const API_URL = "https://memory-proxy-6o36.onrender.com/api/memory";

// In-memory storage
let pendingCards = [];
let lastActivityTime = Date.now();

// Check inactivity every 1 min
setInterval(() => {
  if (pendingCards.length > 0 && Date.now() - lastActivityTime >= 10 * 60 * 1000) {
    console.log("⏳ Inactivity detected — summary cards pending review.");
    // At this point you can notify the user via your frontend/console
    // or auto-save them if that’s your workflow.
  }
}, 60 * 1000);

// --- Helpers ---
function createSummaryCard(conversationText) {
  return {
    Topics: "Workflow Automation",
    Tags: "schema, workflow, validation",
    "key facts": "Schema improvements include IDs, structured tags, validation rules, and versioning.",
    "Last Updated": new Date().toISOString()
  };
}

async function addRowToSpreadsheet(row) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: row })
  });
  return res.ok;
}

// --- Routes ---
// 1. Preview: generate summary card
app.post("/preview", (req, res) => {
  const conversation = req.body.conversation || "";
  const card = createSummaryCard(conversation);

  pendingCards.push(card);
  lastActivityTime = Date.now();

  res.json({ summary_card: card, status: "pending" });
});

// 2. Save: commit summary card
app.post("/save", async (req, res) => {
  const row = req.body.row;

  const success = await addRowToSpreadsheet(row);
  if (success) {
    // remove from pending
    pendingCards = pendingCards.filter(c => c !== row);
    lastActivityTime = Date.now();
    res.json({ status: "saved", row });
  } else {
    res.status(500).json({ status: "failed" });
  }
});

// 3. Discard
app.post("/discard", (req, res) => {
  const row = req.body.row;

  pendingCards = pendingCards.filter(c => c !== row);
  lastActivityTime = Date.now();

  res.json({ status: "discarded" });
});

// 4. Retrieve pending (optional endpoint)
app.get("/pending", (req, res) => {
  res.json({ pendingCards });
});

// --- Start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
