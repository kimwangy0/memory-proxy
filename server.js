const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const SHEET_URL = "https://api.apispreadsheets.com/data/EZkiSWZtvfv4iWHO/";

app.get("/api/memory", async (req, res) => {
  try {
    const { topic, tag, since, q } = req.query;

    const response = await axios.get(SHEET_URL);
    const rows = response.data?.data || [];

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
