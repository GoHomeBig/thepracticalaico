// Vercel Serverless Function — on SOP completion:
//   1) Create a structured Notion page in the SOP Library DB
//      (metadata as properties + a beautifully-formatted body of blocks)
//   2) Email the SOP to the client
//   3) Email the SOP to Joe
//
// Env: NOTION_API_KEY, RESEND_API_KEY

const { Client: NotionClient } = require("@notionhq/client");
const { Resend } = require("resend");

// TODO: Paste the SOP Library database ID here once Joe creates it in Notion.
// Same UUID format as the Discovery DB. Until set, Notion writes will fail
// gracefully and the emails will still send.
const SOP_LIBRARY_DB_ID = "TODO-PASTE-SOP-LIBRARY-DB-ID";

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
  if (!Array.isArray(arr) || !arr.length) return [];
  return arr.map(String);
}

function asArr(x) { return Array.isArray(x) ? x : []; }

// ------- Plain-text rendering (email fallback) -----
function renderSopText(sop) {
  const lines = [];
  lines.push("SOP: " + (sop.processName || ""));
  lines.push((sop.client && sop.client.businessName) || "");
  lines.push((sop.client && sop.client.firstName) || "");
  lines.push("Date: " + (sop.date || ""));
  lines.push("");
  if (sop.frequency) lines.push("Frequency: " + sop.frequency);
  if (sop.estimatedTime) lines.push("Estimated time: " + sop.estimatedTime);
  if (sop.owner) lines.push("Owner: " + sop.owner);
  if (sop.backup) lines.push("Backup: " + sop.backup);
  lines.push("");
  lines.push("TRIGGER");
  lines.push(sop.trigger || "(none captured)");
  lines.push("");
  lines.push("DEPENDENCIES");
  asList(sop.dependencies).forEach((d) => lines.push("  • " + d));
  if (!asList(sop.dependencies).length) lines.push("  (none captured)");
  lines.push("");
  lines.push("STEPS");
  asArr(sop.steps).forEach((s, i) => {
    const n = s.n || (i + 1);
    lines.push(`  ${n}. ${s.action || ""}`);
    const meta = [];
    if (s.tool) meta.push("Tool: " + s.tool);
    if (s.owner) meta.push("Owner: " + s.owner);
    if (s.output) meta.push("Output: " + s.output);
    if (meta.length) lines.push("       " + meta.join(" | "));
    asArr(s.branches).forEach((b) => lines.push("       If " + (b.if || "") + " -> " + (b.then || "")));
  });
  lines.push("");
  lines.push("DECISIONS");
  asArr(sop.decisions).forEach((d) => lines.push("  • If " + (d.if || "") + " -> " + (d.then || "")));
  if (!asArr(sop.decisions).length) lines.push("  (none captured)");
  lines.push("");
  lines.push("FAILURE MODES");
  asArr(sop.failureModes).forEach((f) => lines.push("  • " + (f.issue || "") + " -> " + (f.recovery || "")));
  if (!asArr(sop.failureModes).length) lines.push("  (none captured)");
  lines.push("");
  lines.push("DEFINITION OF DONE");
  lines.push(sop.definitionOfDone || "(none captured)");
  return lines.join("\n");
}

// ------- HTML email rendering -----
function renderEmailHtml(sop, isJoe) {
  const ulHtml = (arr) =>
    asList(arr).length
      ? "<ul style=\"margin:6px 0 14px;padding-left:20px;color:#172033;\">" +
        asList(arr).map((x) => "<li style=\"margin:4px 0;\">" + esc(x) + "</li>").join("") +
        "</ul>"
      : "<p style=\"margin:6px 0 14px;color:#8A93A5;font-style:italic;\">(none captured)</p>";

  const paraHtml = (s) =>
    "<p style=\"margin:6px 0 14px;color:#172033;\">" + esc(s || "(none captured)") + "</p>";

  const stepsHtml = asArr(sop.steps).length
    ? asArr(sop.steps).map((s, i) => {
        const n = s.n || (i + 1);
        const meta = [];
        if (s.tool) meta.push("<b>Tool:</b> " + esc(s.tool));
        if (s.owner) meta.push("<b>Owner:</b> " + esc(s.owner));
        if (s.output) meta.push("<b>Output:</b> " + esc(s.output));
        const metaLine = meta.length
          ? `<div style="font-size:13px;color:#667085;margin-top:4px;">${meta.join("&nbsp; &middot; &nbsp;")}</div>`
          : "";
        const branches = asArr(s.branches).length
          ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#667085;">` +
            asArr(s.branches).map((b) => `<li><b>If</b> ${esc(b.if || "")} &rarr; ${esc(b.then || "")}</li>`).join("") +
            "</ul>"
          : "";
        return `<div style="padding:14px 16px;background:#FBF5EA;border:1px solid #E7DCCB;border-radius:12px;margin:10px 0;">
          <div style="display:flex;gap:12px;align-items:baseline;">
            <div style="font-family:Georgia,serif;font-weight:800;color:#2456FF;font-size:17px;min-width:22px;">${n}.</div>
            <div style="font-size:15px;font-weight:700;color:#172033;line-height:1.4;">${esc(s.action || "")}</div>
          </div>
          ${metaLine}${branches}
        </div>`;
      }).join("")
    : "<p style=\"color:#8A93A5;font-style:italic;\">(no steps captured)</p>";

  const decisionsHtml = asArr(sop.decisions).length
    ? `<ul style="margin:6px 0 14px;padding-left:20px;color:#172033;">` +
      asArr(sop.decisions).map((d) => `<li><b>If</b> ${esc(d.if || "")} &rarr; ${esc(d.then || "")}</li>`).join("") +
      "</ul>"
    : "<p style=\"color:#8A93A5;font-style:italic;\">(none captured)</p>";

  const failuresHtml = asArr(sop.failureModes).length
    ? `<ul style="margin:6px 0 14px;padding-left:20px;color:#172033;">` +
      asArr(sop.failureModes).map((f) => `<li><b>${esc(f.issue || "")}</b> &rarr; ${esc(f.recovery || "")}</li>`).join("") +
      "</ul>"
    : "<p style=\"color:#8A93A5;font-style:italic;\">(none captured)</p>";

  const summaryGrid = [
    { lbl: "Frequency", val: sop.frequency },
    { lbl: "Est. time", val: sop.estimatedTime },
    { lbl: "Owner", val: sop.owner },
    { lbl: "Backup", val: sop.backup },
  ].filter((x) => x.val);

  const summaryHtml = summaryGrid.length
    ? `<table cellpadding="10" cellspacing="0" style="margin:18px 0 24px;background:#FBF5EA;border:1px solid #E7DCCB;border-radius:12px;width:100%;border-collapse:separate;">
        <tr>${summaryGrid.map((x) => `
          <td style="font-size:13px;color:#172033;vertical-align:top;">
            <div style="font-size:10px;font-weight:900;color:#667085;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:2px;">${esc(x.lbl)}</div>
            <div style="font-weight:700;">${esc(x.val)}</div>
          </td>`).join("")}
        </tr>
      </table>`
    : "";

  const greeting = isJoe
    ? `<p style="margin:0 0 18px;">A new SOP just got captured. Full document below, also synced to the SOP Library in Notion.</p>`
    : `<p style="margin:0 0 18px;">Here's the SOP we just captured together. It's also saved to your SOP Library in Notion. Print, share, or hand it to your next hire.</p>`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FBF5EA;font-family:Helvetica,Arial,sans-serif;color:#172033;">
  <div style="max-width:680px;margin:0 auto;padding:32px 24px;">
    <div style="font-family:Georgia,serif;font-weight:800;color:#172033;font-size:24px;letter-spacing:-0.02em;margin-bottom:4px;">
      Practical <span style="color:#2456FF;">AI</span> Co.
    </div>
    <div style="font-size:10px;font-weight:900;letter-spacing:0.26em;color:#667085;text-transform:uppercase;margin-bottom:28px;">
      Systems that run so you can lead
    </div>

    <h1 style="font-family:Georgia,serif;font-size:30px;letter-spacing:-0.025em;color:#172033;margin:0 0 6px;line-height:1.15;">
      ${esc(sop.processName || "Process")}
    </h1>
    <div style="color:#667085;font-size:13px;font-weight:700;margin-bottom:18px;">
      ${esc((sop.client && sop.client.businessName) || "")} &middot;
      ${esc((sop.client && sop.client.firstName) || "")} &middot;
      ${esc(sop.date || "")}
    </div>
    ${greeting}
    ${summaryHtml}

    <hr style="border:0;border-top:1px solid #E7DCCB;margin:20px 0;" />
    <h3 style="font-family:Georgia,serif;font-size:18px;margin:14px 0 4px;">Trigger</h3>
    ${paraHtml(sop.trigger)}

    <h3 style="font-family:Georgia,serif;font-size:18px;margin:18px 0 4px;">Dependencies</h3>
    ${ulHtml(sop.dependencies)}

    <h3 style="font-family:Georgia,serif;font-size:18px;margin:18px 0 4px;">Steps</h3>
    ${stepsHtml}

    <h3 style="font-family:Georgia,serif;font-size:18px;margin:18px 0 4px;">Decisions</h3>
    ${decisionsHtml}

    <h3 style="font-family:Georgia,serif;font-size:18px;margin:18px 0 4px;">Failure modes</h3>
    ${failuresHtml}

    <h3 style="font-family:Georgia,serif;font-size:18px;margin:18px 0 4px;">Definition of done</h3>
    ${paraHtml(sop.definitionOfDone)}

    <div style="margin-top:36px;padding-top:18px;border-top:1px solid #E7DCCB;font-size:12px;color:#8A93A5;">
      Practical AI Co. &middot; Franklin, TN &middot; <a href="mailto:joe@thepracticalai.co" style="color:#2456FF;text-decoration:none;">joe@thepracticalai.co</a>
    </div>
  </div>
</body></html>`;
}

// ============================================================
// Notion: properties + body blocks
// ============================================================
function richText(s) {
  return [{ type: "text", text: { content: String(s || "") } }];
}

function buildNotionProperties({ firstName, businessName, email, sop }) {
  const today = new Date().toISOString().split("T")[0];
  return {
    "Process Name": { title: richText(sop.processName || "Untitled Process") },
    "Client": { rich_text: richText(firstName) },
    "Business": { rich_text: richText(businessName) },
    "Email": { email: email || null },
    "Frequency": sop.frequency ? { select: { name: String(sop.frequency) } } : { select: null },
    "Owner": { rich_text: richText(sop.owner || "") },
    "Backup": { rich_text: richText(sop.backup || "") },
    "Estimated Time": { rich_text: richText(sop.estimatedTime || "") },
    "Status": { status: { name: "Draft" } },
    "Last Updated": { date: { start: today } },
  };
}

// Build Notion block children for the SOP body
function buildNotionBlocks(sop) {
  const blocks = [];
  const heading = (t) => ({
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: richText(t) },
  });
  const paragraph = (t) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richText(t || "(none captured)") },
  });
  const bullet = (t) => ({
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(t) },
  });
  const numbered = (t) => ({
    object: "block",
    type: "numbered_list_item",
    numbered_list_item: { rich_text: richText(t) },
  });

  // Summary header
  const summary = [];
  if (sop.frequency) summary.push("Frequency: " + sop.frequency);
  if (sop.estimatedTime) summary.push("Est. time: " + sop.estimatedTime);
  if (sop.owner) summary.push("Owner: " + sop.owner);
  if (sop.backup) summary.push("Backup: " + sop.backup);
  if (summary.length) {
    blocks.push({
      object: "block",
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "📋" },
        color: "blue_background",
        rich_text: richText(summary.join("  ·  ")),
      },
    });
  }

  blocks.push(heading("Trigger"));
  blocks.push(paragraph(sop.trigger));

  blocks.push(heading("Dependencies"));
  if (asList(sop.dependencies).length) {
    asList(sop.dependencies).forEach((d) => blocks.push(bullet(d)));
  } else {
    blocks.push(paragraph("(none captured)"));
  }

  blocks.push(heading("Steps"));
  if (asArr(sop.steps).length) {
    asArr(sop.steps).forEach((s) => {
      const action = s.action || "";
      blocks.push(numbered(action));
      const metaParts = [];
      if (s.tool) metaParts.push("Tool: " + s.tool);
      if (s.owner) metaParts.push("Owner: " + s.owner);
      if (s.output) metaParts.push("Output: " + s.output);
      if (metaParts.length) blocks.push(paragraph(metaParts.join("  ·  ")));
      asArr(s.branches).forEach((b) => {
        blocks.push(bullet("If " + (b.if || "") + "  →  " + (b.then || "")));
      });
    });
  } else {
    blocks.push(paragraph("(no steps captured)"));
  }

  blocks.push(heading("Decisions"));
  if (asArr(sop.decisions).length) {
    asArr(sop.decisions).forEach((d) =>
      blocks.push(bullet("If " + (d.if || "") + "  →  " + (d.then || "")))
    );
  } else {
    blocks.push(paragraph("(none captured)"));
  }

  blocks.push(heading("Failure modes"));
  if (asArr(sop.failureModes).length) {
    asArr(sop.failureModes).forEach((f) =>
      blocks.push(bullet((f.issue || "") + "  →  " + (f.recovery || "")))
    );
  } else {
    blocks.push(paragraph("(none captured)"));
  }

  blocks.push(heading("Definition of done"));
  blocks.push(paragraph(sop.definitionOfDone));

  // Notion API caps children per request at 100; we'll stay well under.
  return blocks.slice(0, 95);
}

async function createSopPage(notion, props, children) {
  return notion.pages.create({
    parent: { database_id: SOP_LIBRARY_DB_ID },
    properties: props,
    children: children,
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
  const sop = body.sop;

  if (!firstName || !businessName || !email || !sop) {
    return res.status(400).json({ error: "Missing firstName, businessName, email, or sop" });
  }

  const notionKey = process.env.NOTION_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY is not set" });
  if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY is not set" });

  // Notion page write
  let notionPromise;
  if (SOP_LIBRARY_DB_ID && !SOP_LIBRARY_DB_ID.startsWith("TODO")) {
    const notion = new NotionClient({ auth: notionKey });
    const props = buildNotionProperties({ firstName, businessName, email, sop });
    const blocks = buildNotionBlocks(sop);
    notionPromise = createSopPage(notion, props, blocks).catch(async (err) => {
      // If Status is a Select rather than Status type, fall back
      const msg = (err && err.message) || "";
      if (/status/i.test(msg) && /select/i.test(msg)) {
        const fallbackProps = Object.assign({}, props, {
          Status: { select: { name: "Draft" } },
        });
        return createSopPage(notion, fallbackProps, blocks);
      }
      throw err;
    });
  } else {
    notionPromise = Promise.reject(new Error("SOP_LIBRARY_DB_ID not configured yet"));
  }

  const resend = new Resend(resendKey);
  const clientHtml = renderEmailHtml(sop, false);
  const joeHtml = renderEmailHtml(sop, true);
  const textBody = renderSopText(sop);
  const processLabel = sop.processName || "process";

  const clientEmailPromise = resend.emails.send({
    from: FROM,
    to: email,
    reply_to: JOE_EMAIL,
    subject: `Your SOP: ${processLabel} — ${businessName}`,
    html: clientHtml,
    text: textBody,
  });

  const joeEmailPromise = resend.emails.send({
    from: FROM,
    to: JOE_EMAIL,
    reply_to: email,
    subject: `New SOP captured: ${processLabel} — ${businessName}`,
    html: joeHtml,
    text: textBody,
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

  console.log("SOP complete:", {
    firstName,
    businessName,
    email,
    processName: sop.processName,
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
