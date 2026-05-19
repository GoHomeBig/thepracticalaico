// Vercel Serverless Function. Final structured generation for /capture.
//
// Receives the full interview transcript and does, in sequence:
//   1. Claude generates the structured results JSON.
//   2. In parallel: push to Notion + generate Word document (fail-soft).
//   3. Send customer email + Joe email (Word attached if available).
//   4. Return everything (including any soft errors) to the frontend.

const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const { pushToNotion, buildDocxBuffer, docxFilename } = require("./_lib/sop-builders");

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 16000;
const FROM = "Practical AI Co. <joe@thepracticalai.co>";
const JOE_EMAIL = "joe@thepracticalai.co";
const BOOK_CALL_URL = "https://calendar.app.google/SnmSbP7hZCprCZ9B7";

const SYSTEM_PROMPT = `You are a practical business process mapper for small businesses, working on behalf of Practical AI Co.

Your job is to turn a messy conversational explanation of one business workflow into a clear, structured operational picture: a process map, an SOP draft, bottleneck and systems analysis, owner-dependency analysis, and a small list of practical AI automation opportunities.

VOICE RULES
- Do not use corporate jargon.
- Do not sound like a consultant.
- Do not make the owner feel disorganized or behind. This is normal small-business reality.
- Never use em dashes anywhere. Use periods, commas, parentheses, or simple hyphens.
- Plain English. Warm. Specific. Grounded in what the owner actually said.

ANALYTICAL RULES
- Infer workflow structure from the conversation.
- Identify alternate paths, conditional flows, merge points, edge cases, handoffs.
- Identify operational friction, duplicated work, owner dependency.
- Identify where humans bridge disconnected systems manually.
- Identify shadow systems (the unofficial workflow the team actually relies on).
- Identify the system of record for each piece of information.
- Be specific. Use the owner's actual words and examples when you can.

AUTOMATION OPPORTUNITIES
- Practical, achievable, and progressive. Avoid futuristic complexity unless clearly appropriate.
- Phrased in "we" language. ("We would build a lightweight intake summary..." not "You should implement...").
- Each opportunity's practical_ai_build_note must make it clear that Practical AI Co. would build this with the owner.
- estimated_impact must be 2 to 4 SHORT, scannable items. Each item is a single phrase that a small business owner would care about. They buy time, clarity, reduced stress, and operational visibility. They do not buy AI.
  Good impact items: "~6 hours/month saved", "Faster Monday response", "Fewer cold weekend leads", "Owner unblocked from quote reviews".
  Bad impact items: "Improved ROI through optimized lead processing workflows".

EXECUTIVE SUMMARY (required)
- One sentence for each of the four fields. These will appear at the very top of the deliverable, so they must be sharp.
- biggest_bottleneck: the specific place this process most consistently slows down or breaks.
- biggest_time_drain: the activity in this process that eats the most owner or team time.
- most_owner_dependent_step: where the business cannot move without the owner personally being involved.
- most_immediate_ai_opportunity: the single sharpest place AI can help first.

OUTPUT FORMAT
Return ONLY valid JSON wrapped in <RESULTS></RESULTS> tags. No other text before or after the tags. Use this exact shape:

<RESULTS>
{
  "executive_summary": {
    "biggest_bottleneck":             "one sentence",
    "biggest_time_drain":             "one sentence",
    "most_owner_dependent_step":      "one sentence",
    "most_immediate_ai_opportunity":  "one sentence"
  },
  "process_summary": "2 to 4 sentence warm summary of how the process actually runs today",
  "process_steps": [
    {
      "step_number": 1,
      "title": "short action title",
      "description": "1 to 2 sentence plain English description of what happens in this step",
      "people_involved": "who does this step (role or name)",
      "tools_used": "tool names involved in this step, comma separated, or empty string if none",
      "inputs_from": ["optional list of upstream sources that feed into this step, if it is a merge point"],
      "risk_or_friction": "what tends to go wrong or slow down here, or empty string",
      "automation_opportunity": false
    }
  ],
  "process_branches": [
    {
      "after_step": 3,
      "condition": "the question or condition that creates the branch",
      "yes_path": "what happens if yes",
      "no_path": "what happens if no"
    }
  ],
  "bottlenecks": [
    { "title": "short name", "description": "1 to 2 sentence description", "why_it_matters": "why this hurts the business in practice" }
  ],
  "owner_dependencies": [
    { "title": "short name", "description": "where the owner has to step in" }
  ],
  "manual_work": [
    { "title": "short name", "description": "what is being done manually today" }
  ],
  "tools_and_systems": [
    {
      "tool_name": "actual tool name",
      "purpose": "what it is used for in this process",
      "used_by": "who uses it",
      "pain_points": "specific friction, or empty string",
      "system_role": "source_of_truth | communication | scheduling | finance | operations | shadow_system"
    }
  ],
  "systems_breakdown": [
    { "title": "short name", "description": "where the tools fail to connect or where information is manually bridged", "impact": "what this costs in time or accuracy" }
  ],
  "sop_title": "clear title for the SOP",
  "sop_sections": [
    { "section_title": "section heading", "content": "section body in plain English" }
  ],
  "automation_ideas": [
    {
      "title": "short opportunity name",
      "plain_english_description": "what the automation would do, in plain English",
      "why_it_matters": "the specific operational pain this removes",
      "difficulty": "Easy | Medium | Advanced",
      "recommended_process_step": "the step title or step number this connects to",
      "practical_ai_build_note": "what Practical AI Co. would build with the owner, in we language",
      "estimated_impact": ["2 to 4 short impact phrases like '~6 hours/month saved' or 'Faster Monday response'"]
    }
  ],
  "recommended_first_build": {
    "title": "the chosen first build",
    "why_this_first": "why this is the right starting point for this specific business",
    "what_practical_ai_would_build": "specific description of what we would build together",
    "estimated_impact": ["2 to 4 short impact phrases, same format as above"]
  }
}
</RESULTS>

GUIDANCE
- process_steps: 5 to 12 steps. Each step is a single concrete action.
- automation_opportunity on a step is true only when an automation idea actually targets that step.
- process_branches: only include real branches the owner mentioned. Empty array is fine.
- inputs_from on a step: only fill for genuine merge points where work arrives from multiple upstream sources. Otherwise leave empty.
- tools_and_systems: include every tool you can reasonably extract. Be honest about shadow systems.
- automation_ideas: 3 to 6 opportunities. Quality over quantity. Order by impact, highest first.
- recommended_first_build: pick one. Highest impact, lowest friction.
- sop_sections: 4 to 8 clean sections (Purpose, When to use, Roles, Inputs, Steps, Handoffs, Common issues, Done when).
- executive_summary: REQUIRED. All four fields. One sentence each. Sharp and specific.

Output ONLY the JSON in <RESULTS></RESULTS> tags. No commentary.`;

// ============================================================
// Email rendering
// ============================================================
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function renderCustomerEmail(profile, r, notionUrl, hasWord) {
  const fn = esc(profile.firstName || "");
  const proc = esc(profile.processName || "your process");
  const es = r.executive_summary || {};
  const fb = r.recommended_first_build || {};
  const impactLines = Array.isArray(fb.estimated_impact) ? fb.estimated_impact.slice(0, 4) : [];

  const notionBlock = notionUrl
    ? `<p style="margin:18px 0;"><a href="${esc(notionUrl)}" style="display:inline-block;background:#2456FF;color:white;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:800;font-size:14px;">Open your process map in Notion &rarr;</a></p>`
    : `<p style="margin:18px 0;color:#667085;font-size:14px;">The Notion page is still being set up. Joe will send the link separately.</p>`;

  const wordNote = hasWord
    ? `<p style="margin:6px 0 0;color:#667085;font-size:13px;">A Word version of your full process map is attached to this email.</p>`
    : ``;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FBF5EA;font-family:Helvetica,Arial,sans-serif;color:#172033;">
  <div style="max-width:600px;margin:0 auto;padding:36px 24px 56px;">

    <div style="font-family:Georgia,serif;font-weight:800;color:#172033;font-size:22px;letter-spacing:-0.025em;margin-bottom:4px;">
      Practical <span style="color:#2456FF;">AI</span> Co.
    </div>
    <div style="font-size:10px;font-weight:900;letter-spacing:0.22em;color:#667085;text-transform:uppercase;margin-bottom:30px;">
      Systems that run so you can lead
    </div>

    <p style="font-size:16px;line-height:1.55;margin:0 0 14px;">Hi ${fn},</p>
    <p style="font-size:16px;line-height:1.55;margin:0 0 22px;">
      Thanks for walking us through your ${proc} process. Below is the short version of what we heard. Your full process map is in Notion and attached as a Word document.
    </p>

    <h2 style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.022em;color:#172033;margin:24px 0 10px;">What we heard</h2>
    <table style="width:100%;border-collapse:collapse;">
      ${es.biggest_bottleneck            ? `<tr><td style="padding:6px 0;font-size:14.5px;line-height:1.5;"><b style="color:#B91C1C;">Biggest bottleneck:</b> ${esc(es.biggest_bottleneck)}</td></tr>` : ""}
      ${es.biggest_time_drain            ? `<tr><td style="padding:6px 0;font-size:14.5px;line-height:1.5;"><b style="color:#B45309;">Biggest time drain:</b> ${esc(es.biggest_time_drain)}</td></tr>` : ""}
      ${es.most_owner_dependent_step     ? `<tr><td style="padding:6px 0;font-size:14.5px;line-height:1.5;"><b style="color:#172033;">Most owner-dependent:</b> ${esc(es.most_owner_dependent_step)}</td></tr>` : ""}
      ${es.most_immediate_ai_opportunity ? `<tr><td style="padding:6px 0;font-size:14.5px;line-height:1.5;"><b style="color:#2456FF;">Most immediate AI opportunity:</b> ${esc(es.most_immediate_ai_opportunity)}</td></tr>` : ""}
    </table>

    ${fb.title ? `
    <div style="margin:30px 0 0;padding:22px 24px;background:#FFFDF8;border:1px solid #E7DCCB;border-radius:14px;">
      <div style="font-size:10px;font-weight:900;letter-spacing:0.18em;color:#2456FF;text-transform:uppercase;margin-bottom:8px;">Where we would start</div>
      <h3 style="font-family:Georgia,serif;font-size:19px;letter-spacing:-0.02em;color:#172033;margin:0 0 8px;">${esc(fb.title)}</h3>
      ${fb.why_this_first ? `<p style="margin:0 0 10px;font-size:14.5px;line-height:1.55;">${esc(fb.why_this_first)}</p>` : ""}
      ${impactLines.length ? `
        <div style="margin-top:10px;">
          ${impactLines.map((i) => `<div style="font-size:13.5px;color:#172033;margin:3px 0;">&#10003;&nbsp; ${esc(i)}</div>`).join("")}
        </div>` : ""}
    </div>` : ""}

    ${notionBlock}
    ${wordNote}

    <hr style="border:0;border-top:1px solid #E7DCCB;margin:32px 0 22px;" />

    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">When you are ready, the next step is a 45-minute Build call to scope the first system together.</p>
    <p style="margin:0 0 30px;"><a href="${BOOK_CALL_URL}" style="display:inline-block;background:#2456FF;color:white;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:800;font-size:14px;">Book a Build call with Joe &rarr;</a></p>

    <div style="font-size:12px;color:#8A93A5;border-top:1px solid #E7DCCB;padding-top:16px;">
      Practical AI Co. &middot; Franklin, TN &middot; <a href="mailto:${JOE_EMAIL}" style="color:#2456FF;text-decoration:none;">${JOE_EMAIL}</a>
    </div>
  </div>
  </body></html>`;

  const text = [
    `Hi ${profile.firstName || ""},`,
    ``,
    `Thanks for walking us through your ${profile.processName || "process"}. Below is the short version of what we heard.`,
    ``,
    `WHAT WE HEARD`,
    es.biggest_bottleneck            ? `- Biggest bottleneck: ${es.biggest_bottleneck}` : null,
    es.biggest_time_drain            ? `- Biggest time drain: ${es.biggest_time_drain}` : null,
    es.most_owner_dependent_step     ? `- Most owner-dependent: ${es.most_owner_dependent_step}` : null,
    es.most_immediate_ai_opportunity ? `- Most immediate AI opportunity: ${es.most_immediate_ai_opportunity}` : null,
    ``,
    fb.title ? `WHERE WE WOULD START` : null,
    fb.title ? `${fb.title}${fb.why_this_first ? "\n" + fb.why_this_first : ""}` : null,
    ``,
    notionUrl ? `Notion page: ${notionUrl}` : `The Notion page is being set up. Joe will share separately.`,
    hasWord  ? `A Word version is attached.` : `Word document will follow.`,
    ``,
    `Book a Build call with Joe: ${BOOK_CALL_URL}`,
    ``,
    `Practical AI Co.`,
  ].filter((l) => l !== null).join("\n");

  return { html, text };
}

function renderJoeEmail(profile, r, notionUrl, hasWord) {
  const es = r.executive_summary || {};
  const fb = r.recommended_first_build || {};
  const topBottlenecks = (r.bottlenecks || []).slice(0, 3);
  const topOpps        = (r.automation_ideas || []).slice(0, 3);
  const impactLines    = Array.isArray(fb.estimated_impact) ? fb.estimated_impact.slice(0, 4) : [];

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FBF5EA;font-family:Helvetica,Arial,sans-serif;color:#172033;">
  <div style="max-width:640px;margin:0 auto;padding:32px 24px 50px;">

    <div style="font-size:10px;font-weight:900;letter-spacing:0.22em;color:#2456FF;text-transform:uppercase;margin-bottom:10px;">New capture session</div>
    <h1 style="font-family:Georgia,serif;font-size:24px;letter-spacing:-0.025em;color:#172033;margin:0 0 6px;">${esc(profile.businessName || "")}</h1>
    <div style="color:#667085;font-size:13.5px;margin-bottom:24px;">${esc(profile.processName || "")} &middot; ${esc(profile.firstName || "")} &middot; <a href="mailto:${esc(profile.email || "")}" style="color:#2456FF;text-decoration:none;">${esc(profile.email || "")}</a></div>

    <h2 style="font-family:Georgia,serif;font-size:18px;color:#172033;margin:24px 0 8px;">Executive summary</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
      ${es.biggest_bottleneck            ? `<tr><td style="padding:5px 0;font-size:14px;line-height:1.5;"><b style="color:#B91C1C;">Bottleneck:</b> ${esc(es.biggest_bottleneck)}</td></tr>` : ""}
      ${es.biggest_time_drain            ? `<tr><td style="padding:5px 0;font-size:14px;line-height:1.5;"><b style="color:#B45309;">Time drain:</b> ${esc(es.biggest_time_drain)}</td></tr>` : ""}
      ${es.most_owner_dependent_step     ? `<tr><td style="padding:5px 0;font-size:14px;line-height:1.5;"><b style="color:#172033;">Owner-dependent:</b> ${esc(es.most_owner_dependent_step)}</td></tr>` : ""}
      ${es.most_immediate_ai_opportunity ? `<tr><td style="padding:5px 0;font-size:14px;line-height:1.5;"><b style="color:#2456FF;">AI opportunity:</b> ${esc(es.most_immediate_ai_opportunity)}</td></tr>` : ""}
    </table>

    ${fb.title ? `
    <div style="margin:22px 0 0;padding:18px 22px;background:#FFFDF8;border:1px solid #E7DCCB;border-radius:12px;">
      <div style="font-size:10px;font-weight:900;letter-spacing:0.18em;color:#2456FF;text-transform:uppercase;margin-bottom:6px;">Recommended first build</div>
      <h3 style="font-family:Georgia,serif;font-size:17px;letter-spacing:-0.02em;color:#172033;margin:0 0 6px;">${esc(fb.title)}</h3>
      ${fb.why_this_first ? `<p style="margin:0 0 8px;font-size:13.5px;line-height:1.55;color:#172033;">${esc(fb.why_this_first)}</p>` : ""}
      ${fb.what_practical_ai_would_build ? `<p style="margin:0 0 8px;font-size:13.5px;line-height:1.55;color:#172033;"><b>What we'd build:</b> ${esc(fb.what_practical_ai_would_build)}</p>` : ""}
      ${impactLines.length ? `<div>${impactLines.map((i) => `<div style="font-size:13px;color:#172033;margin:2px 0;">&#10003;&nbsp; ${esc(i)}</div>`).join("")}</div>` : ""}
    </div>` : ""}

    ${topBottlenecks.length ? `
    <h2 style="font-family:Georgia,serif;font-size:18px;color:#172033;margin:28px 0 8px;">Top bottlenecks</h2>
    ${topBottlenecks.map((b) => `
      <div style="padding:10px 0;border-bottom:1px solid #E7DCCB;">
        <div style="font-weight:800;font-size:14.5px;color:#172033;margin-bottom:2px;">${esc(b.title || "")}</div>
        ${b.description ? `<div style="font-size:13.5px;color:#172033;line-height:1.5;">${esc(b.description)}</div>` : ""}
        ${b.why_it_matters ? `<div style="font-size:13px;color:#667085;line-height:1.5;margin-top:3px;"><b>Why it matters:</b> ${esc(b.why_it_matters)}</div>` : ""}
      </div>`).join("")}` : ""}

    ${topOpps.length ? `
    <h2 style="font-family:Georgia,serif;font-size:18px;color:#172033;margin:28px 0 8px;">Top AI opportunities</h2>
    ${topOpps.map((a) => `
      <div style="padding:10px 0;border-bottom:1px solid #E7DCCB;">
        <div style="font-weight:800;font-size:14.5px;color:#172033;">${esc(a.title || "")}${a.difficulty ? ` <span style="font-size:11px;color:#2456FF;background:rgba(36,86,255,0.10);padding:2px 8px;border-radius:999px;font-weight:700;margin-left:6px;">${esc(a.difficulty)}</span>` : ""}</div>
        ${a.plain_english_description ? `<div style="font-size:13.5px;color:#172033;line-height:1.5;margin-top:3px;">${esc(a.plain_english_description)}</div>` : ""}
        ${Array.isArray(a.estimated_impact) && a.estimated_impact.length ? `<div style="margin-top:5px;">${a.estimated_impact.slice(0, 3).map((i) => `<span style="font-size:12px;color:#172033;background:#F5F0E8;padding:2px 8px;border-radius:6px;margin-right:6px;display:inline-block;margin-top:3px;">${esc(i)}</span>`).join("")}</div>` : ""}
      </div>`).join("")}` : ""}

    <hr style="border:0;border-top:1px solid #E7DCCB;margin:30px 0 18px;" />
    <p style="margin:0 0 6px;font-size:13.5px;color:#172033;">${notionUrl ? `<b>Notion:</b> <a href="${esc(notionUrl)}" style="color:#2456FF;">${esc(notionUrl)}</a>` : `<b>Notion:</b> push failed, full Word attached.`}</p>
    <p style="margin:0;font-size:13.5px;color:#172033;">${hasWord ? `<b>Word doc:</b> attached to this email.` : `<b>Word doc:</b> generation failed, Notion has the full content.`}</p>

    <div style="margin-top:30px;font-size:11.5px;color:#8A93A5;">
      Talking points for the Build call: confirm the bottleneck, walk the first-build scope, confirm budget and timeline.
    </div>
  </div>
  </body></html>`;

  const text = [
    `New capture session: ${profile.businessName || ""}`,
    `${profile.processName || ""} | ${profile.firstName || ""} | ${profile.email || ""}`,
    ``,
    `EXECUTIVE SUMMARY`,
    es.biggest_bottleneck            ? `- Bottleneck: ${es.biggest_bottleneck}` : null,
    es.biggest_time_drain            ? `- Time drain: ${es.biggest_time_drain}` : null,
    es.most_owner_dependent_step     ? `- Owner-dependent: ${es.most_owner_dependent_step}` : null,
    es.most_immediate_ai_opportunity ? `- AI opportunity: ${es.most_immediate_ai_opportunity}` : null,
    ``,
    fb.title ? `RECOMMENDED FIRST BUILD: ${fb.title}` : null,
    fb.why_this_first ? fb.why_this_first : null,
    ``,
    notionUrl ? `Notion: ${notionUrl}` : `Notion: push failed`,
    hasWord  ? `Word doc: attached` : `Word doc: generation failed`,
  ].filter((l) => l !== null).join("\n");

  return { html, text };
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

  const profile = body.profile || {};
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];

  if (!profile.processName || conversation.length === 0) {
    return res.status(400).json({ error: "Missing process name or conversation" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const anthropic = new Anthropic({ apiKey });

  const transcript = conversation
    .filter((m) => m && (m.role === "assistant" || m.role === "user") && m.content)
    .map((m) => `${m.role === "assistant" ? "Interviewer" : "Owner"}: ${m.content}`)
    .join("\n\n");

  const userMessage =
    `Here is the discovery session for one business workflow.\n\n` +
    `Owner: ${profile.firstName || ""}\n` +
    `Business: ${profile.businessName || ""}\n` +
    `Process: ${profile.processName}\n\n` +
    `INTERVIEW TRANSCRIPT:\n\n${transcript}\n\n` +
    `Generate the structured results per your system prompt. Output ONLY the JSON in <RESULTS></RESULTS> tags. Do not use em dashes anywhere.`;

  // 1. Generate the JSON
  let results;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const match = text.match(/<RESULTS>([\s\S]*?)<\/RESULTS>/);
    if (!match) {
      const stop = response.stop_reason || "unknown";
      const head = text.slice(0, 400).replace(/\n/g, " ");
      return res.status(500).json({ error: `Generation missing tags. stop=${stop}. head: ${head}` });
    }
    results = JSON.parse(match[1].trim());
  } catch (err) {
    console.error("capture-complete generation error:", err);
    return res.status(500).json({ error: err.message || "Generation failed" });
  }

  // 2. Notion + Word in parallel (fail soft)
  const [notionSettled, wordSettled] = await Promise.allSettled([
    pushToNotion({ profile, results }),
    buildDocxBuffer(profile, results),
  ]).then((settled) => settled);

  const notionUrl   = notionSettled.status === "fulfilled" ? notionSettled.value.url : null;
  const notionError = notionSettled.status === "rejected"  ? (notionSettled.reason && notionSettled.reason.message) || "Notion push failed" : null;
  const wordBuffer  = wordSettled.status   === "fulfilled" ? wordSettled.value : null;
  const wordError   = wordSettled.status   === "rejected"  ? (wordSettled.reason && wordSettled.reason.message) || "Word generation failed" : null;
  if (notionError) console.error("Notion push failed:", notionError);
  if (wordError)   console.error("Word generation failed:", wordError);

  // 3. Emails (fail soft per recipient)
  let customerEmailError = null;
  let joeEmailError = null;
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && profile.email) {
    const resend = new Resend(resendKey);
    const filename = docxFilename(profile);
    const attachments = wordBuffer
      ? [{ filename, content: wordBuffer.toString("base64") }]
      : [];

    const customerEmail = renderCustomerEmail(profile, results, notionUrl, !!wordBuffer);
    const joeEmail      = renderJoeEmail(profile, results, notionUrl, !!wordBuffer);

    const [c, j] = await Promise.allSettled([
      resend.emails.send({
        from: FROM,
        to: profile.email,
        reply_to: JOE_EMAIL,
        subject: `Your process map + AI opportunities: ${profile.processName}`,
        html: customerEmail.html,
        text: customerEmail.text,
        attachments,
      }),
      resend.emails.send({
        from: FROM,
        to: JOE_EMAIL,
        reply_to: profile.email,
        subject: `New capture: ${profile.businessName || ""} (${profile.processName})`,
        html: joeEmail.html,
        text: joeEmail.text,
        attachments,
      }),
    ]);
    if (c.status === "rejected") customerEmailError = (c.reason && c.reason.message) || "Customer email failed";
    if (j.status === "rejected") joeEmailError      = (j.reason && j.reason.message) || "Joe email failed";
    if (customerEmailError) console.error("Customer email failed:", customerEmailError);
    if (joeEmailError)      console.error("Joe email failed:", joeEmailError);
  } else if (!resendKey) {
    customerEmailError = "RESEND_API_KEY not configured";
    joeEmailError      = "RESEND_API_KEY not configured";
  } else if (!profile.email) {
    customerEmailError = "No customer email on profile";
  }

  return res.status(200).json({
    results,
    notionUrl,
    emailSent: !customerEmailError,
    errors: {
      notion: notionError,
      word: wordError,
      customerEmail: customerEmailError,
      joeEmail: joeEmailError,
    },
  });
};
