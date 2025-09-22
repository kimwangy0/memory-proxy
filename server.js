const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const SHEET_URL = "https://api.apispreadsheets.com/data/EZkiSWZtvfv4iWHO/";

app.use(express.json()); // parse JSON request bodies

// Helper: Convert Excel serial date to YYYY-MM-DD
function excelDateToISO(serial) {
  if (!serial || isNaN(serial)) return null;
  const baseDate = new Date(1900, 0, 1); // Jan 1, 1900
  const converted = new Date(baseDate.getTime() + (serial - 2) * 86400000);
  return converted.toISOString().split("T")[0]; // YYYY-MM-DD
}

// ✅ GET /api/memory → fetch + filter data
app.get("/api/memory", async (req, res) => {
  try {
    const { topic, tag, since, q } = req.query;

    const response = await axios.get(SHEET_URL);
    let rows = response.data?.data || [];

    rows = rows.map((row) => ({
      ...row,
      "Last Updated": excelDateToISO(row["Last Updated"]),
    }));

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
    console.error("❌ Error fetching sheet:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ POST /api/memory → add a new row
app.post("/api/memory", async (req, res) => {
  try {
    let rowData = req.body;

    // 🔑 Normalize structure
    if (rowData.data && !Array.isArray(rowData.data)) {
      rowData = rowData.data; // unwrap object
    } else if (rowData.data && Array.isArray(rowData.data)) {
      rowData = rowData.data[0]; // unwrap array
    }

    // Always enforce correct structure: { data: [ { ... } ] }
    const payload = { data: [rowData] };

    // Log outgoing payload
    console.log("📤 Payload being sent to API Spreadsheets:", JSON.stringify(payload, null, 2));

    const response = await axios.post(SHEET_URL, payload);

    // Log API response
    console.log("✅ API Spreadsheets Response:", response.data);

    res.json({
      success: true,
      message: "Row added successfully",
      sentPayload: payload,
      apiResponse: response.data,
    });
  } catch (err) {
    console.error("❌ Error adding row:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to add row" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Memory Proxy running at http://localhost:${PORT}/api/memory`);
});
