// Vercel Serverless Function. On-demand export for /capture results.
//
// POST /api/capture-export
//   body: { profile, results, format: "notion" | "docx" }
//
// Notion response: { url }
// Docx response:   binary .docx with appropriate headers

const { pushToNotion, buildDocxBuffer, docxFilename } = require("./_lib/sop-builders");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const profile = body.profile || {};
  const results = body.results || null;
  const format  = String(body.format || "").toLowerCase();

  if (!results || !profile.processName) {
    return res.status(400).json({ error: "Missing results or profile" });
  }

  try {
    if (format === "notion") {
      const out = await pushToNotion({ profile, results });
      return res.status(200).json({ url: out.url });
    }
    if (format === "docx") {
      const buffer = await buildDocxBuffer(profile, results);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${docxFilename(profile)}"`);
      res.setHeader("Content-Length", buffer.length);
      return res.status(200).send(buffer);
    }
    return res.status(400).json({ error: "Unknown format. Use 'notion' or 'docx'." });
  } catch (err) {
    console.error("capture-export error:", err);
    return res.status(500).json({ error: err.message || "Export failed" });
  }
};
