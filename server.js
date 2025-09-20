const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const SHEET_URL = "https://api.apispreadsheets.com/data/EZkiSWZtvfv4iWHO/";

// Helper: Convert Excel serial date to YYYY-MM-DD
function excelDateToISO(serial) {
  if (!serial || isNaN(serial)) return null;
  const baseDate = new Date(1900, 0, 1); // Jan 1, 1900
  const converted = new Date(baseDate.getTime() + (serial - 2) * 86400000);
  return converted.toISOString().split("T")[0]; // YYYY-MM-DD
}

app.get("/api/memory", async (req, res) => {
  try {
    const { topic, tag, since, q } = req.query;

    const response = await axios.get(SHEET_URL);
    let rows = response.data?.data || [];

    // Convert Last Updated to real date
    rows = rows.map((row) => ({
      ...row,
      "Last Updated": excelDateToISO(row["Last Updated"]),
    }));

    // Filtering logic
    const filtered = rows.filter((row) => {
      let match = true;

      // Case-insensitive exact match for topic
      if (topic && row.Topics.toLowerCase() !== topic.toLowerCase()) match = false;

      // Case-insensitive substring match for tag
      if (tag && !row.Tags.toLowerCase().includes(tag.toLowerCase())) match = false;

      // Date filtering
      if (since && new Date(row["Last Updated"]) < new Date(since)) match = false;

      // Case-insensitive search across all columns
      if (q) {
        const query = q.toLowerCase();
        const values = Object.values(row).map((v) => String(v).toLowerCase());

        if (!values.some((v) => v.includes(query))) match = false;
      }

      return match;
    });

    // Send results
    res.json({ data: filtered });
  } catch (err) {
    console.error("Error fetching sheet:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Memory Proxy running at http://localhost:${PORT}/api/memory`);
});
