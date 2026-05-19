// Server-side Supabase helpers for /capture session persistence.
// Uses the service-role key, which bypasses RLS. NEVER expose this client
// or the key to the browser.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   PUBLIC_BASE_URL (defaults to https://thepracticalai.co)

const crypto = require("crypto");

let _client = null;
function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const err = new Error("Supabase not configured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    err.code = "SUPABASE_NOT_CONFIGURED";
    throw err;
  }
  // Lazy require so missing dependency doesn't blow up unrelated endpoints.
  const { createClient } = require("@supabase/supabase-js");
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// ============================================================
// Slug generation
// ============================================================
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function randomSuffix(bytes) {
  return crypto.randomBytes(bytes || 3).toString("hex");
}

// Build "business-process-abc123". Long, readable, non-guessable for V1.
function generateSlug(businessName, processName) {
  const business = slugify(businessName) || "business";
  const proc     = slugify(processName)  || "process";
  const suffix   = randomSuffix(3); // 6 hex chars = 16M+ combos
  return `${business}-${proc}-${suffix}`.slice(0, 96);
}

// ============================================================
// Save / read
// ============================================================
async function saveSession({ profile, results, notionUrl, notionError, emailStatus }) {
  const client = getClient();
  // Try up to 3 times in case of slug collision (extremely unlikely with 6 hex).
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = generateSlug(profile.businessName, profile.processName);
    const row = {
      slug,
      client_name:   profile.firstName    || null,
      client_email:  profile.email        || null,
      business_name: profile.businessName || null,
      process_name:  profile.processName  || null,
      results_json:  results,
      notion_url:    notionUrl || null,
      docx_url:      null, // reserved for V2
      notion_status: notionError ? "failed" : (notionUrl ? "pushed" : "not_configured"),
      email_status:  emailStatus || null,
      metadata:      null,
    };
    const { data, error } = await client
      .from("capture_sessions")
      .insert(row)
      .select("id, slug, created_at")
      .single();
    if (!error) return data;
    // 23505 = unique_violation (slug collision). Anything else, surface.
    if (error.code !== "23505") {
      const e = new Error("Supabase insert failed: " + error.message);
      e.code = "SUPABASE_INSERT_FAILED";
      e.details = error;
      throw e;
    }
    // else: collision, loop and try a different suffix
  }
  const e = new Error("Could not produce a unique slug after 3 attempts");
  e.code = "SUPABASE_SLUG_COLLISION";
  throw e;
}

async function listSessions(opts) {
  const limit = (opts && opts.limit) || 200;
  const client = getClient();
  // Deliberately exclude results_json. This endpoint is a link directory only.
  // The full report stays behind the per-slug URL.
  const { data, error } = await client
    .from("capture_sessions")
    .select("slug, business_name, process_name, client_name, client_email, notion_url, notion_status, email_status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    const e = new Error("Supabase list failed: " + error.message);
    e.code = "SUPABASE_LIST_FAILED";
    e.details = error;
    throw e;
  }
  return data || [];
}

async function readSessionBySlug(slug) {
  if (!slug || typeof slug !== "string") return null;
  const client = getClient();
  const { data, error } = await client
    .from("capture_sessions")
    .select("slug, client_name, client_email, business_name, process_name, results_json, notion_url, docx_url, notion_status, email_status, created_at")
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    const e = new Error("Supabase read failed: " + error.message);
    e.code = "SUPABASE_READ_FAILED";
    e.details = error;
    throw e;
  }
  return data || null;
}

// ============================================================
// URL building
// ============================================================
function publicBaseUrl(req) {
  const fromEnv = process.env.PUBLIC_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  // Fall back to the incoming request host. Useful for preview deploys.
  if (req && req.headers && req.headers.host) {
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    return `${proto}://${req.headers.host}`;
  }
  return "https://thepracticalai.co";
}

function buildResultsUrl(req, slug) {
  return `${publicBaseUrl(req)}/capture/results/${slug}`;
}

module.exports = {
  saveSession,
  readSessionBySlug,
  listSessions,
  generateSlug,
  buildResultsUrl,
  publicBaseUrl,
};
