const express = require("express");
const router = express.Router();

let pendingCards = [];
let lastActivityTime = Date.now();

// Inactivity monitor (runs every minute)
setInterval(() => {
  if (pendingCards.length > 0 && Date.now() - lastActivityTime >= 10 * 60 * 1000) {
    console.log("⏳ 10 minutes of inactivity — pending summary cards:");
    console.log(pendingCards);
    // 👉 Here you could push a notification, or auto-save if desired
  }
}, 60 * 1000);

// --- Helpers ---
function createSummaryCard(conversationText) {
  return {
    Topics: "Workflow Automation",
    Tags: "schema, workflow, validation",
    "key facts": conversationText || "Default key facts placeholder",
    "Last Updated": new Date().toISOString(),
  };
}

// --- Routes ---
// 1. Preview: generate summary card
router.post("/preview", (req, res) => {
  const conversation = req.body.conversation || "";
  const card = createSummaryCard(conversation);

  pendingCards.push(card);
  lastActivityTime = Date.now();

  res.json({ summary_card: card, status: "pending" });
});

// 2. Save: finalize card and push to spreadsheet via /api/memory
router.post("/save", async (req, res) => {
  try {
    const row = req.body.row;
    if (!row) return res.status(400).json({ error: "Missing row data" });

    // Forward request to your existing /api/memory (proxy to Sheets)
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

// 3. Discard: remove from pending
router.post("/discard", (req, res) => {
  const row = req.body.row;
  if (!row) return res.status(400).json({ error: "Missing row data" });

  pendingCards = pendingCards.filter((c) => c !== row);
  lastActivityTime = Date.now();

  res.json({ status: "discarded" });
});

// 4. Get all pending (for review)
router.get("/pending", (req, res) => {
  res.json({ pendingCards });
});

module.exports = router;
