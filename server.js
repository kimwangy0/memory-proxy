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

      if (topic && row.Topics !== topic) match = false;
      if (tag && !row.Tags.toLowerCase().includes(tag.toLowerCase())) match = false;
      if (since && new Date(row["Last Updated"]) < new Date(since)) match = false;
      if (q && !row["key facts"].toLowerCase().includes(q.toLowerCase())) match = false;

      return match;
    });

    res.json({ data: filtered });
  } catch (err) {
    console.error("Error fetching sheet:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Memory Proxy running at http://localhost:${PORT}/api/memory`);
});
