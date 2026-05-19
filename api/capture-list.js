// Vercel Serverless Function. Lists saved /capture sessions for the
// private /admin/captures page. Returns a small link directory only,
// never the full results_json.
//
// GET /api/capture-list
//   Headers: Authorization: Bearer <ADMIN_PASSWORD>
//
// Returns 401 on missing / wrong password.
// Returns 503 if ADMIN_PASSWORD or Supabase isn't configured.

const crypto = require("crypto");
const { listSessions, publicBaseUrl } = require("./_lib/supabase");

// Constant-time equality on UTF-8 strings, returning false safely on
// length mismatch without short-circuiting (still does the compare to
// keep timing predictable).
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a == null ? "" : a), "utf8");
  const bb = Buffer.from(String(b == null ? "" : b), "utf8");
  if (ab.length !== bb.length) {
    // Do a dummy compare so failure timing matches success timing.
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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).json({ error: "Admin not configured" });

  const provided = getBearer(req);
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    // Generic error so we don't help a probe figure out the shape.
    return res.status(401).json({ error: "Invalid credentials" });
  }

  try {
    const sessions = await listSessions({ limit: 250 });
    const base = publicBaseUrl(req);
    const rows = sessions.map((s) => ({
      slug:          s.slug,
      business_name: s.business_name,
      process_name:  s.process_name,
      client_name:   s.client_name,
      client_email:  s.client_email,
      notion_url:    s.notion_url || null,
      notion_status: s.notion_status || null,
      email_status:  s.email_status || null,
      created_at:    s.created_at,
      results_url:   base + "/capture/results/" + s.slug,
    }));
    // Don't cache — this is a private listing.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ count: rows.length, sessions: rows });
  } catch (err) {
    console.error("capture-list error:", err);
    if (err.code === "SUPABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Results storage is not configured" });
    }
    return res.status(500).json({ error: err.message || "List failed" });
  }
};
