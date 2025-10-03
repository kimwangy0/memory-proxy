// ✅ DELETE /api/memory → hard delete by ID (accepts body or query param)
app.delete("/api/memory", express.json(), async (req, res) => {
  try {
    // Accept ID from body or query string
    const ID = req.body?.ID || req.query?.ID;
    if (!ID) {
      return res.status(400).json({ error: "Missing required field: ID" });
    }

    const sheets = await getSheetsService();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
    });

    let rows = result.data.values || [];
    let targetRowIndex = -1;

    // Find row with matching ID
    rows.slice(1).forEach((row, i) => {
      if (row[0] == ID) targetRowIndex = i + 1; // +1 for header offset (zero-based indexing)
    });

    if (targetRowIndex === -1) {
      return res.status(404).json({ error: `Row with ID ${ID} not found` });
    }

    // Perform hard delete
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: MEMORY_SHEET_ID,
                dimension: "ROWS",
                startIndex: targetRowIndex,
                endIndex: targetRowIndex + 1,
              },
            },
          },
        ],
      },
    });

    res.json({ success: true, message: `Row hard deleted: ID ${ID}` });
  } catch (err) {
    console.error("❌ Error deleting row:", err.message);
    res.status(500).json({ error: "Failed to hard delete row", details: err.message });
  }
});
