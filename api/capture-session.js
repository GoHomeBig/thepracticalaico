// Vercel Serverless Function. GET-by-slug endpoint for the permanent
// /capture/results/{slug} page.
//
// GET /api/capture-session?slug=...
//
// - Returns 200 with the session row on success
// - Returns 404 if the slug isn't found
// - Returns 400 if no slug is provided
// - Never lists multiple sessions, never accepts writes

const { readSessionBySlug } = require("./_lib/supabase");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let slug = "";
  try {
    // Vercel populates req.query, local node http does not.
    if (req.query && req.query.slug) {
      slug = String(req.query.slug);
    } else {
      const url = new URL(req.url, "http://placeholder");
      slug = url.searchParams.get("slug") || "";
    }
  } catch (_) { slug = ""; }
  slug = slug.trim();

  if (!slug) return res.status(400).json({ error: "Missing slug" });
  if (slug.length > 120 || !/^[a-z0-9-]+$/i.test(slug)) {
    return res.status(400).json({ error: "Invalid slug" });
  }

  try {
    const row = await readSessionBySlug(slug);
    if (!row) return res.status(404).json({ error: "Session not found" });
    // Cache for a minute at the edge — sessions are immutable once created.
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).json({ session: row });
  } catch (err) {
    console.error("capture-session error:", err);
    if (err.code === "SUPABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Results storage is not configured" });
    }
    return res.status(500).json({ error: err.message || "Read failed" });
  }
};
