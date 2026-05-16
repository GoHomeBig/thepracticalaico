// Vercel Serverless Function — fires the three completion side-effects:
//   1) Create a Notion row in the Discovery database
//   2) Email the captured document to the client
//   3) Email the same document to Joe
//
// Env: NOTION_API_KEY, RESEND_API_KEY

const { Client: NotionClient } = require("@notionhq/client");
const { Resend } = require("resend");

const NOTION_DB_ID = "41707d89-4890-4670-b59c-fafc78d3f1e2";
const JOE_EMAIL = "joe@thepracticalai.co";
const FROM = "Practical AI Co. <joe@thepracticalai.co>";

// ============================================================
// Helpers
// ============================================================
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function asList(arr) {
  if (!Array.isArray(arr) || !arr.length) return ["(none captured)"];
  return arr.map(String);
}

// ------- Plain-text rendering (for Notion Notes + email fallback) -----
function renderDocumentText(doc) {
  const cj = doc.customerJourney || {};
  const rt = doc.repetitiveTasks || {};
  const ok = doc.onlyIKnow || {};
  const opps = doc.topAutomationOpportunities || [];

  const ul = (arr) => asList(arr).map((x) => "  • " + x).join("\n");
  const para = (s) => (s ? s : "(none captured)");

  return [
    `READY Record · ${doc.businessName || ""}`,
    `${doc.clientName || ""} · ${doc.date || ""}`,
    doc.industry ? `Industry: ${doc.industry}` : "",
    "",
    "── CUSTOMER JOURNEY ──",
    "",
    "Lead sources:",
    ul(cj.leadSources),
    "",
    "First contact:",
    para(cj.firstContact),
    "",
    "Qualification:",
    para(cj.qualification),
    "",
    "Fulfillment:",
    ul(cj.fulfillment),
    "",
    "Aftercare:",
    para(cj.aftercare),
    "",
    "Common exceptions:",
    ul(cj.commonExceptions),
    "",
    "── REPETITIVE TASKS ──",
    "",
    "Weekly:",
    ul(rt.weekly),
    "",
    "Manual that should be automatic:",
    ul(rt.manualThatShouldBeAuto),
    "",
    "Would stop on vacation:",
    ul(rt.wouldStopIfVacation),
    "",
    "── ONLY-I-KNOW LIST ──",
    "",
    "Would break with a new hire:",
    ul(ok.wouldBreakWithNewHire),
    "",
    "Owner judgment calls:",
    ul(ok.judgmentCalls),
    "",
    "Hidden standards:",
    ul(ok.hiddenStandards),
    "",
    "Week-one wrong moves:",
    ul(ok.weekOneWrongMoves),
    "",
    "── TOP AUTOMATION OPPORTUNITIES ──",
    "",
    ul(opps),
    "",
  ].filter(Boolean).join("\n");
}

// ------- HTML email rendering -----
function renderEmailHtml(doc, isJoe) {
  const cj = doc.customerJourney || {};
  const rt = doc.repetitiveTasks || {};
  const ok = doc.onlyIKnow || {};
  const opps = doc.topAutomationOpportunities || [];

  const ulHtml = (arr) =>
    "<ul style=\"margin:6px 0 14px;padding-left:20px;color:#172033;\">" +
    asList(arr).map((x) => "<li style=\"margin:4px 0;\">" + esc(x) + "</li>").join("") +
    "</ul>";
  const paraHtml = (s) =>
    "<p style=\"margin:6px 0 14px;color:#172033;\">" + esc(s || "(none captured)") + "</p>";
  const h4 = (s) =>
    "<h4 style=\"font-size:12px;text-transform:uppercase;letter-spacing:0.14em;color:#2456FF;margin:16px 0 4px;font-weight:800;font-family:Helvetica,Arial,sans-serif;\">" +
    esc(s) +
    "</h4>";
  const sectionDivider =
    "<hr style=\"border:0;border-top:1px solid #E7DCCB;margin:28px 0;\" />";

  const greeting = isJoe
    ? "<p style=\"margin:0 0 18px;\">A new READY Record session just wrapped up. The full extraction is below.</p>"
    : `<p style="margin:0 0 18px;">Here's the full Business Process Document we captured together. Joe will be in touch within 24 hours to walk through your top automation opportunities.</p>`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FBF5EA;font-family:Helvetica,Arial,sans-serif;color:#172033;">
  <div style="max-width:680px;margin:0 auto;padding:32px 24px;">
    <div style="font-family:Georgia,serif;font-weight:800;color:#172033;font-size:24px;letter-spacing:-0.02em;margin-bottom:4px;">
      Practical <span style="color:#2456FF;">AI</span> Co.
    </div>
    <div style="font-size:10px;font-weight:900;letter-spacing:0.26em;color:#667085;text-transform:uppercase;margin-bottom:28px;">
      Systems that run so you can lead
    </div>

    <h1 style="font-family:Georgia,serif;font-size:26px;letter-spacing:-0.025em;color:#172033;margin:0 0 6px;">
      ${esc(doc.businessName || "")}
    </h1>
    <div style="color:#667085;font-size:13px;font-weight:700;margin-bottom:24px;">
      ${esc(doc.clientName || "")} · ${esc(doc.date || "")}${doc.industry ? " · " + esc(doc.industry) : ""}
    </div>

    ${greeting}

    ${sectionDivider}
    <h3 style="font-family:Georgia,serif;font-size:20px;margin:0 0 4px;">Customer Journey</h3>
    ${h4("Lead sources")}${ulHtml(cj.leadSources)}
    ${h4("First contact")}${paraHtml(cj.firstContact)}
    ${h4("Qualification")}${paraHtml(cj.qualification)}
    ${h4("Fulfillment")}${ulHtml(cj.fulfillment)}
    ${h4("Aftercare")}${paraHtml(cj.aftercare)}
    ${h4("Common exceptions")}${ulHtml(cj.commonExceptions)}

    ${sectionDivider}
    <h3 style="font-family:Georgia,serif;font-size:20px;margin:0 0 4px;">Repetitive Tasks</h3>
    ${h4("Weekly")}${ulHtml(rt.weekly)}
    ${h4("Manual that should be automatic")}${ulHtml(rt.manualThatShouldBeAuto)}
    ${h4("Would stop on vacation")}${ulHtml(rt.wouldStopIfVacation)}

    ${sectionDivider}
    <h3 style="font-family:Georgia,serif;font-size:20px;margin:0 0 4px;">Only-I-Know List</h3>
    ${h4("Would break with a new hire")}${ulHtml(ok.wouldBreakWithNewHire)}
    ${h4("Owner judgment calls")}${ulHtml(ok.judgmentCalls)}
    ${h4("Hidden standards")}${ulHtml(ok.hiddenStandards)}
    ${h4("Week-one wrong moves")}${ulHtml(ok.weekOneWrongMoves)}

    ${sectionDivider}
    <h3 style="font-family:Georgia,serif;font-size:20px;margin:0 0 4px;">Top Automation Opportunities</h3>
    ${ulHtml(opps)}

    <div style="margin-top:36px;padding-top:18px;border-top:1px solid #E7DCCB;font-size:12px;color:#8A93A5;">
      Practical AI Co. · Franklin, TN · <a href="mailto:joe@thepracticalai.co" style="color:#2456FF;text-decoration:none;">joe@thepracticalai.co</a>
    </div>
  </div>
</body></html>`;
}

// ============================================================
// Notion row builder
// ============================================================
function buildNotionProperties({ firstName, businessName, doc }) {
  const today = new Date().toISOString().split("T")[0];
  const industry = (doc && doc.industry) ? String(doc.industry) : "";
  const notesFull = renderDocumentText(doc);
  // Notion rich_text fields cap at 2000 chars per text run; split into chunks.
  const notesChunks = [];
  for (let i = 0; i < notesFull.length; i += 1900) {
    notesChunks.push(notesFull.slice(i, i + 1900));
  }
  return {
    "Client Name": { title: [{ text: { content: firstName } }] },
    "Business": { rich_text: [{ text: { content: businessName } }] },
    "Industry": { rich_text: [{ text: { content: industry } }] },
    "Status": { status: { name: "Discovery" } },
    "Discovery Date": { date: { start: today } },
    "Notes": { rich_text: notesChunks.map((c) => ({ text: { content: c } })) },
    "Hours Invested": { number: 0 },
  };
}

// Fallback: same shape but with Status as `select` (in case the DB uses select, not status)
function buildNotionPropertiesWithSelect(base) {
  return Object.assign({}, base, {
    "Status": { select: { name: "Discovery" } },
  });
}

async function createNotionRow(notion, props) {
  return notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties: props,
  });
}

// ============================================================
// Handler
// ============================================================
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

  const firstName = (body.firstName || "").toString().trim();
  const businessName = (body.businessName || "").toString().trim();
  const email = (body.email || "").toString().trim();
  const doc = body.doc;

  if (!firstName || !businessName || !email || !doc) {
    return res.status(400).json({ error: "Missing firstName, businessName, email, or doc" });
  }

  const notionKey = process.env.NOTION_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY is not set" });
  if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY is not set" });

  const notion = new NotionClient({ auth: notionKey });
  const resend = new Resend(resendKey);

  const notionProps = buildNotionProperties({ firstName, businessName, doc });

  // Notion: try `status` shape first, fall back to `select` if the DB uses an old select property
  const notionPromise = createNotionRow(notion, notionProps).catch(async (err) => {
    const msg = (err && err.message) || "";
    if (/status/i.test(msg) && /select/i.test(msg)) {
      return createNotionRow(notion, buildNotionPropertiesWithSelect(notionProps));
    }
    throw err;
  });

  const clientHtml = renderEmailHtml(doc, false);
  const joeHtml = renderEmailHtml(doc, true);
  const clientText = renderDocumentText(doc);

  const clientEmailPromise = resend.emails.send({
    from: FROM,
    to: email,
    reply_to: JOE_EMAIL,
    subject: `Your Business Process Document — ${businessName}`,
    html: clientHtml,
    text: clientText,
  });

  const joeEmailPromise = resend.emails.send({
    from: FROM,
    to: JOE_EMAIL,
    reply_to: email,
    subject: `New READY Record Session Complete — ${businessName}`,
    html: joeHtml,
    text: clientText,
  });

  const [notionResult, clientEmailResult, joeEmailResult] = await Promise.allSettled([
    notionPromise,
    clientEmailPromise,
    joeEmailPromise,
  ]);

  const summarize = (r) => (r.status === "fulfilled" ? "fulfilled" : "rejected");
  const reasonOf = (r) => {
    if (r.status === "fulfilled") return null;
    const e = r.reason;
    if (!e) return "unknown";
    return e.message || (typeof e === "string" ? e : "unknown");
  };

  // Log details for Joe's server logs
  console.log("READY Record complete:", {
    firstName,
    businessName,
    email,
    notion: summarize(notionResult),
    notionErr: reasonOf(notionResult),
    clientEmail: summarize(clientEmailResult),
    clientEmailErr: reasonOf(clientEmailResult),
    joeEmail: summarize(joeEmailResult),
    joeEmailErr: reasonOf(joeEmailResult),
  });

  return res.status(200).json({
    notion: summarize(notionResult),
    clientEmail: summarize(clientEmailResult),
    joeEmail: summarize(joeEmailResult),
    errors: {
      notion: reasonOf(notionResult),
      clientEmail: reasonOf(clientEmailResult),
      joeEmail: reasonOf(joeEmailResult),
    },
  });
};
