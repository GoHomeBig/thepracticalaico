// Vercel Serverless Function. One-off admin backfill endpoint.
// Accepts a pre-built profile + results JSON and saves it to Supabase
// the same way /api/capture-complete would. No Claude call, no emails.
// Use only for honest reconstruction of sessions whose original
// generation predates Supabase persistence.
//
// POST /api/capture-admin-insert
//   Headers: Authorization: Bearer <ADMIN_PASSWORD>
//   Body: { profile: {...}, results: {...}, notionUrl?: string, metadata?: object }
//
// Returns: { slug, resultsUrl, created_at }
//
// Security:
// - Admin-only (Bearer ADMIN_PASSWORD)
// - Does not generate; only stores
// - Does not send emails
// - Does not push to Notion (notion_url is just stored if provided)

const crypto = require("crypto");
const { saveSession, buildResultsUrl } = require("./_lib/supabase");

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a == null ? "" : a), "utf8");
  const bb = Buffer.from(String(b == null ? "" : b), "utf8");
  if (ab.length !== bb.length) {
    const dummy = Buffer.alloc(bb.length);
    try { crypto.timingSafeEqual(dummy, bb); } catch (_) {}
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function getBearer(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h) return "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).json({ error: "Admin not configured" });
  const provided = getBearer(req);
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const profile = body.profile || {};
  const results = body.results || null;
  const notionUrl = body.notionUrl || null;

  if (!profile.businessName || !profile.processName) {
    return res.status(400).json({ error: "Missing profile.businessName or profile.processName" });
  }
  if (!results || typeof results !== "object") {
    return res.status(400).json({ error: "Missing or invalid results JSON" });
  }

  try {
    const saved = await saveSession({
      profile,
      results,
      notionUrl,
      notionError: null,
      emailStatus: "backfilled",
    });
    return res.status(200).json({
      slug: saved.slug,
      resultsUrl: buildResultsUrl(req, saved.slug),
      created_at: saved.created_at,
      backfilled: true,
    });
  } catch (err) {
    console.error("capture-admin-insert error:", err);
    if (err.code === "SUPABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Results storage is not configured" });
    }
    return res.status(500).json({ error: err.message || "Backfill failed" });
  }
};
