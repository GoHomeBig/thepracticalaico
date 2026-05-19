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
const BOOK_CALL_URL = "https://calendar.app.google/SBMCxMPv4Sd8VZRW9";

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

// Email-safe color and typography tokens
const E = {
  bg: "#FBF5EA", paper: "#FFFDF8", ink: "#172033", muted: "#667085",
  muted2: "#8A93A5", line: "#E7DCCB", blue: "#2456FF", green: "#2F8F5B",
  amber: "#B45309", red: "#B91C1C",
};

function emailHeader() {
  return `<div style="font-family:Georgia,serif;font-weight:800;color:${E.ink};font-size:22px;letter-spacing:-0.025em;margin-bottom:4px;">
    Practical <span style="color:${E.blue};">AI</span> Co.
  </div>
  <div style="font-size:10px;font-weight:900;letter-spacing:0.22em;color:${E.muted};text-transform:uppercase;margin-bottom:28px;">
    Systems that run so you can lead
  </div>`;
}

function ctaRow(notionUrl) {
  const btn = (label, href, primary) => `<a href="${esc(href)}" style="display:inline-block;background:${primary ? E.blue : E.paper};color:${primary ? "white" : E.ink};text-decoration:none;padding:11px 18px;border-radius:999px;font-weight:800;font-size:13.5px;border:${primary ? "0" : "1px solid " + E.line};margin:0 6px 8px 0;">${esc(label)}</a>`;
  const buttons = [];
  if (notionUrl) buttons.push(btn("Open in Notion", notionUrl, true));
  buttons.push(btn("Open in Google Docs", "https://docs.google.com/document/u/0/", false));
  buttons.push(btn("Book a Build call", BOOK_CALL_URL, false));
  return `<div style="margin:0 0 16px;">${buttons.join("")}</div>`;
}

function execSummaryBlock(es) {
  if (!es) return "";
  const rows = [];
  if (es.biggest_bottleneck)            rows.push(`<tr><td style="padding:6px 0;font-size:14.5px;line-height:1.5;"><b style="color:${E.red};">Biggest bottleneck:</b> ${esc(es.biggest_bottleneck)}</td></tr>`);
  if (es.biggest_time_drain)            rows.push(`<tr><td style="padding:6px 0;font-size:14.5px;line-height:1.5;"><b style="color:${E.amber};">Biggest time drain:</b> ${esc(es.biggest_time_drain)}</td></tr>`);
  if (es.most_owner_dependent_step)     rows.push(`<tr><td style="padding:6px 0;font-size:14.5px;line-height:1.5;"><b style="color:${E.ink};">Most owner-dependent:</b> ${esc(es.most_owner_dependent_step)}</td></tr>`);
  if (es.most_immediate_ai_opportunity) rows.push(`<tr><td style="padding:6px 0;font-size:14.5px;line-height:1.5;"><b style="color:${E.blue};">Most immediate AI opportunity:</b> ${esc(es.most_immediate_ai_opportunity)}</td></tr>`);
  if (!rows.length) return "";
  return `<h2 style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.022em;color:${E.ink};margin:24px 0 10px;">What we heard</h2>
    <table style="width:100%;border-collapse:collapse;">${rows.join("")}</table>`;
}

function startHereBlock(fb) {
  if (!fb || !fb.title) return "";
  const impactLines = Array.isArray(fb.estimated_impact) ? fb.estimated_impact.slice(0, 4) : [];
  const impactsHtml = impactLines.length
    ? `<div style="margin-top:10px;">${impactLines.map((i) => `<div style="font-size:13.5px;color:${E.ink};margin:3px 0;">&#10003;&nbsp; ${esc(i)}</div>`).join("")}</div>`
    : "";
  return `<div style="margin:24px 0 0;padding:22px 24px;background:${E.paper};border:1px solid ${E.line};border-radius:14px;">
    <div style="font-size:10px;font-weight:900;letter-spacing:0.18em;color:${E.blue};text-transform:uppercase;margin-bottom:8px;">Where we would start</div>
    <h3 style="font-family:Georgia,serif;font-size:19px;letter-spacing:-0.02em;color:${E.ink};margin:0 0 8px;">${esc(fb.title)}</h3>
    ${fb.why_this_first ? `<p style="margin:0 0 10px;font-size:14.5px;line-height:1.55;color:${E.ink};">${esc(fb.why_this_first)}</p>` : ""}
    ${fb.what_practical_ai_would_build ? `<p style="margin:0 0 10px;font-size:13.5px;line-height:1.55;color:${E.muted};"><b style="color:${E.ink};">What we would build:</b> ${esc(fb.what_practical_ai_would_build)}</p>` : ""}
    ${impactsHtml}
  </div>`;
}

function processMapBlock(r) {
  const steps = Array.isArray(r.process_steps) ? r.process_steps : [];
  if (!steps.length) return "";
  const branchMap = {};
  (r.process_branches || []).forEach((b) => {
    const key = String(b.after_step || "");
    if (!branchMap[key]) branchMap[key] = [];
    branchMap[key].push(b);
  });
  const ideas = Array.isArray(r.automation_ideas) ? r.automation_ideas : [];
  function findAutomationFor(step) {
    const key = String(step.step_number);
    const title = (step.title || "").toLowerCase();
    for (const a of ideas) {
      const ref = String(a.recommended_process_step || "").toLowerCase();
      if (ref === key) return a;
      if (ref && title && ref.includes(title.slice(0, 12))) return a;
      if (ref && ref.includes("step " + key)) return a;
    }
    return null;
  }

  const stepsHtml = steps.map((s) => {
    const isAuto = !!s.automation_opportunity;
    const numBg = isAuto ? E.blue : E.paper;
    const numColor = isAuto ? "white" : E.ink;
    const numBorder = isAuto ? E.blue : E.line;
    const stepHtml = `<table style="width:100%;border-collapse:collapse;margin:0 0 14px;" cellpadding="0" cellspacing="0"><tr>
      <td style="width:44px;vertical-align:top;padding-top:2px;">
        <div style="width:34px;height:34px;background:${numBg};color:${numColor};border:1.5px solid ${numBorder};border-radius:50%;text-align:center;line-height:32px;font-weight:900;font-size:13px;">${esc(String(s.step_number || ""))}</div>
      </td>
      <td style="padding-left:14px;background:${E.paper};border:1px solid ${isAuto ? "rgba(36,86,255,0.30)" : E.line};border-radius:14px;padding:14px 18px;">
        ${Array.isArray(s.inputs_from) && s.inputs_from.length ? `<div style="margin-bottom:10px;padding:9px 12px;background:#F5F0E8;border-radius:8px;">
          <div style="font-size:10px;font-weight:900;color:${E.muted2};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Inputs from</div>
          <div>${s.inputs_from.map((i) => `<span style="display:inline-block;font-size:12px;padding:2px 9px;background:${E.paper};border:1px solid ${E.line};border-radius:999px;color:${E.ink};margin:2px 4px 0 0;">${esc(i)}</span>`).join("")}</div>
        </div>` : ""}
        <div style="font-weight:800;color:${E.ink};font-size:15.5px;margin-bottom:4px;line-height:1.35;">${esc(s.title || "")}</div>
        ${s.people_involved || s.tools_used ? `<div style="font-size:12.5px;color:${E.muted};margin-bottom:6px;">${[s.people_involved && "People: " + esc(s.people_involved), s.tools_used && "Tools: " + esc(s.tools_used)].filter(Boolean).join(" &middot; ")}</div>` : ""}
        ${s.description ? `<div style="font-size:14px;color:${E.ink};line-height:1.55;margin:6px 0;">${esc(s.description)}</div>` : ""}
        ${s.risk_or_friction ? `<div style="margin-top:8px;padding:9px 12px;background:rgba(180,83,9,0.06);border-left:3px solid ${E.amber};border-radius:0 8px 8px 0;font-size:13px;color:${E.ink};line-height:1.5;">${esc(s.risk_or_friction)}</div>` : ""}
        ${isAuto ? (() => {
          const idea = findAutomationFor(s);
          const label = idea ? idea.title : "Automation opportunity";
          return `<div style="margin-top:8px;padding:10px 14px;background:rgba(36,86,255,0.07);border-left:3px solid ${E.blue};border-radius:0 8px 8px 0;">
            <div style="font-size:10px;font-weight:900;color:${E.blue};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px;">Where AI can help</div>
            <div style="font-size:13.5px;color:${E.ink};">${esc(label)}</div>
          </div>`;
        })() : ""}
      </td>
    </tr></table>`;

    const branchesHtml = (branchMap[String(s.step_number)] || []).map((b) =>
      `<table style="width:100%;border-collapse:collapse;margin:0 0 14px 44px;" cellpadding="0" cellspacing="0"><tr><td style="background:rgba(180,83,9,0.04);border:1px solid rgba(180,83,9,0.22);border-radius:10px;padding:12px 16px;">
        <div style="font-size:10px;font-weight:900;color:${E.amber};letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">Decision</div>
        <div style="font-weight:800;color:${E.ink};font-size:14px;margin-bottom:10px;">${esc(b.condition || "")}</div>
        <table style="width:100%;border-collapse:collapse;"><tr>
          <td style="width:48%;background:rgba(47,143,91,0.10);border-radius:8px;padding:9px 12px;vertical-align:top;">
            <div style="font-size:10px;font-weight:900;color:${E.green};text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px;">If yes</div>
            <div style="font-size:13px;color:${E.ink};">${esc(b.yes_path || "")}</div>
          </td>
          <td style="width:4%"></td>
          <td style="width:48%;background:rgba(180,83,9,0.10);border-radius:8px;padding:9px 12px;vertical-align:top;">
            <div style="font-size:10px;font-weight:900;color:${E.amber};text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px;">If no</div>
            <div style="font-size:13px;color:${E.ink};">${esc(b.no_path || "")}</div>
          </td>
        </tr></table>
      </td></tr></table>`
    ).join("");

    return stepHtml + branchesHtml;
  }).join("");

  return `<h2 style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.022em;color:${E.ink};margin:32px 0 14px;">Your process map</h2>
    ${stepsHtml}`;
}

function opportunitiesBlock(r) {
  const items = Array.isArray(r.automation_ideas) ? r.automation_ideas : [];
  if (!items.length) return "";
  const cards = items.map((a) => {
    const diffColor = a.difficulty === "Easy" ? E.green : a.difficulty === "Advanced" ? E.amber : E.blue;
    const diffBg    = a.difficulty === "Easy" ? "rgba(47,143,91,0.10)" : a.difficulty === "Advanced" ? "rgba(180,83,9,0.10)" : "rgba(36,86,255,0.10)";
    const impacts = Array.isArray(a.estimated_impact) ? a.estimated_impact.slice(0, 4) : [];
    return `<div style="background:${E.paper};border:1px solid ${E.line};border-radius:14px;padding:16px 20px;margin-bottom:12px;">
      ${a.difficulty ? `<span style="display:inline-block;font-size:10.5px;font-weight:800;padding:3px 10px;border-radius:999px;letter-spacing:0.06em;text-transform:uppercase;background:${diffBg};color:${diffColor};margin-bottom:6px;">${esc(a.difficulty)}</span>` : ""}
      <h3 style="font-family:Georgia,serif;font-size:17px;letter-spacing:-0.022em;color:${E.ink};margin:4px 0 8px;">${esc(a.title || "")}</h3>
      ${a.plain_english_description ? `<p style="margin:0 0 8px;font-size:14px;color:${E.ink};line-height:1.55;">${esc(a.plain_english_description)}</p>` : ""}
      ${a.why_it_matters ? `<p style="margin:0 0 6px;font-size:13px;color:${E.muted};line-height:1.55;"><b style="color:${E.ink};">Why it matters:</b> ${esc(a.why_it_matters)}</p>` : ""}
      ${a.practical_ai_build_note ? `<p style="margin:0 0 6px;font-size:13px;color:${E.muted};line-height:1.55;"><b style="color:${E.ink};">What we would build:</b> ${esc(a.practical_ai_build_note)}</p>` : ""}
      ${impacts.length ? `<div style="margin-top:8px;">${impacts.map((i) => `<span style="display:inline-block;font-size:12px;padding:3px 9px;background:#F5F0E8;border:1px solid ${E.line};border-radius:999px;color:${E.ink};margin:2px 5px 2px 0;">&#10003;&nbsp; ${esc(i)}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("");
  return `<h2 style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.022em;color:${E.ink};margin:32px 0 14px;">AI opportunities</h2>${cards}`;
}

function listBlock(title, items, lineFn) {
  if (!Array.isArray(items) || !items.length) return "";
  const cards = items.map((x) =>
    `<div style="background:${E.paper};border:1px solid ${E.line};border-radius:12px;padding:14px 18px;margin-bottom:10px;">${lineFn(x)}</div>`
  ).join("");
  return `<h2 style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.022em;color:${E.ink};margin:32px 0 14px;">${esc(title)}</h2>${cards}`;
}

function sopBlock(r) {
  const items = Array.isArray(r.sop_sections) ? r.sop_sections : [];
  if (!items.length) return "";
  const sections = items.map((s) =>
    `<div style="margin-bottom:14px;">
       <h4 style="font-family:Georgia,serif;font-size:16px;letter-spacing:-0.02em;color:${E.ink};margin:0 0 4px;">${esc(s.section_title || "")}</h4>
       ${s.content ? `<p style="margin:0;font-size:14px;color:${E.ink};line-height:1.6;">${esc(s.content).replace(/\n/g, "<br/>")}</p>` : ""}
     </div>`
  ).join("");
  return `<h2 style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.022em;color:${E.ink};margin:32px 0 14px;">${esc(r.sop_title || "Full SOP")}</h2>${sections}`;
}

function dividerHr() {
  return `<hr style="border:0;border-top:1px solid ${E.line};margin:28px 0;" />`;
}

function darkCtaBlock() {
  return `<div style="background:${E.ink};color:white;border-radius:20px;padding:32px 36px;margin:32px 0 0;">
    <div style="font-size:10px;font-weight:900;letter-spacing:0.22em;color:${E.blue};text-transform:uppercase;margin-bottom:10px;">Step 2 &middot; Build</div>
    <h2 style="font-family:Georgia,serif;color:white;font-size:24px;letter-spacing:-0.025em;margin:0 0 10px;line-height:1.15;">Ready to build the first system?</h2>
    <p style="color:rgba(255,255,255,0.78);font-size:14.5px;line-height:1.6;margin:0 0 18px;">The Build call is 45 minutes. We confirm the scope, talk through the trade-offs, and start building with you.</p>
    <a href="${BOOK_CALL_URL}" style="display:inline-block;background:${E.blue};color:white;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:800;font-size:14px;">Book a Build call with Joe &rarr;</a>
  </div>`;
}

function gdocsNote(hasWord) {
  if (!hasWord) return "";
  return `<p style="margin:8px 0 0;color:${E.muted};font-size:12.5px;line-height:1.55;">Your Word version is attached. To edit in Google Docs, open <a href="https://docs.google.com/document/u/0/" style="color:${E.blue};">docs.google.com</a> and use File &rarr; Open to upload the attachment.</p>`;
}

function renderCustomerEmail(profile, r, notionUrl, hasWord) {
  const fn = esc(profile.firstName || "");
  const proc = esc(profile.processName || "your process");

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${E.bg};font-family:Helvetica,Arial,sans-serif;color:${E.ink};">
  <div style="max-width:640px;margin:0 auto;padding:36px 24px 56px;">

    ${emailHeader()}

    <p style="font-size:16px;line-height:1.55;margin:0 0 12px;">Hi ${fn},</p>
    <p style="font-size:16px;line-height:1.55;margin:0 0 20px;color:${E.ink};">
      Below is the durable copy of your ${proc} capture session. It includes the executive summary, the full process map, AI opportunities, and a draft SOP. Use it however helps most.
    </p>

    ${ctaRow(notionUrl)}
    ${gdocsNote(hasWord)}
    ${!notionUrl ? `<p style="margin:14px 0 0;color:${E.muted};font-size:13px;">The Notion page is still being set up. Joe will follow up with the link.</p>` : ""}

    ${dividerHr()}
    ${execSummaryBlock(r.executive_summary)}
    ${startHereBlock(r.recommended_first_build)}

    ${r.process_summary ? `${dividerHr()}<h2 style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.022em;color:${E.ink};margin:18px 0 8px;">Overview</h2><p style="margin:0;font-size:14.5px;line-height:1.6;color:${E.ink};">${esc(r.process_summary)}</p>` : ""}

    ${dividerHr()}
    ${processMapBlock(r)}

    ${dividerHr()}
    ${opportunitiesBlock(r)}

    ${dividerHr()}
    ${listBlock("Where work gets stuck", r.bottlenecks, (b) =>
      `<h4 style="font-family:Georgia,serif;font-size:16px;letter-spacing:-0.02em;color:${E.ink};margin:0 0 4px;">${esc(b.title || "")}</h4>
       ${b.description ? `<p style="margin:0 0 6px;font-size:14px;color:${E.ink};line-height:1.55;">${esc(b.description)}</p>` : ""}
       ${b.why_it_matters ? `<p style="margin:0;font-size:13px;color:${E.muted};line-height:1.55;"><b style="color:${E.ink};">Why it matters:</b> ${esc(b.why_it_matters)}</p>` : ""}`
    )}

    ${listBlock("Where the owner steps in", r.owner_dependencies, (d) =>
      `<h4 style="font-family:Georgia,serif;font-size:16px;letter-spacing:-0.02em;color:${E.ink};margin:0 0 4px;">${esc(d.title || "")}</h4>
       ${d.description ? `<p style="margin:0;font-size:14px;color:${E.ink};line-height:1.55;">${esc(d.description)}</p>` : ""}`
    )}

    ${listBlock("Manual work", r.manual_work, (m) =>
      `<h4 style="font-family:Georgia,serif;font-size:16px;letter-spacing:-0.02em;color:${E.ink};margin:0 0 4px;">${esc(m.title || "")}</h4>
       ${m.description ? `<p style="margin:0;font-size:14px;color:${E.ink};line-height:1.55;">${esc(m.description)}</p>` : ""}`
    )}

    ${listBlock("Tools and systems", r.tools_and_systems, (t) =>
      `<h4 style="font-family:Georgia,serif;font-size:16px;letter-spacing:-0.02em;color:${E.ink};margin:0 0 4px;">${esc(t.tool_name || "")}${t.system_role ? ` <span style="font-size:11px;font-weight:700;color:${E.muted};text-transform:uppercase;letter-spacing:0.06em;">(${esc(t.system_role.replace(/_/g, " "))})</span>` : ""}</h4>
       ${t.purpose ? `<p style="margin:0 0 4px;font-size:14px;color:${E.ink};line-height:1.55;">${esc(t.purpose)}</p>` : ""}
       ${t.used_by ? `<p style="margin:0 0 2px;font-size:12.5px;color:${E.muted};"><b style="color:${E.ink};">Used by:</b> ${esc(t.used_by)}</p>` : ""}
       ${t.pain_points ? `<p style="margin:0;font-size:12.5px;color:${E.muted};"><b style="color:${E.ink};">Pain points:</b> ${esc(t.pain_points)}</p>` : ""}`
    )}

    ${listBlock("Where systems break down", r.systems_breakdown, (b) =>
      `<h4 style="font-family:Georgia,serif;font-size:16px;letter-spacing:-0.02em;color:${E.ink};margin:0 0 4px;">${esc(b.title || "")}</h4>
       ${b.description ? `<p style="margin:0 0 6px;font-size:14px;color:${E.ink};line-height:1.55;">${esc(b.description)}</p>` : ""}
       ${b.impact ? `<p style="margin:0;font-size:13px;color:${E.muted};line-height:1.55;"><b style="color:${E.ink};">Impact:</b> ${esc(b.impact)}</p>` : ""}`
    )}

    ${dividerHr()}
    ${sopBlock(r)}

    ${darkCtaBlock()}

    <div style="font-size:12px;color:${E.muted2};border-top:1px solid ${E.line};padding-top:16px;margin-top:32px;">
      Practical AI Co. &middot; Franklin, TN &middot; <a href="mailto:${JOE_EMAIL}" style="color:${E.blue};text-decoration:none;">${JOE_EMAIL}</a>
    </div>
  </div>
  </body></html>`;

  // Plain-text fallback (much terser; the HTML version is the deliverable)
  const es = r.executive_summary || {};
  const fb = r.recommended_first_build || {};
  const text = [
    `Hi ${profile.firstName || ""},`,
    ``,
    `Below is the durable copy of your ${profile.processName || "process"} capture session.`,
    ``,
    notionUrl ? `Notion: ${notionUrl}` : `Notion page is being set up. Joe will follow up with the link.`,
    hasWord  ? `Word doc: attached. To edit in Google Docs, open docs.google.com and use File > Open.` : `Word doc: generation failed.`,
    ``,
    `WHAT WE HEARD`,
    es.biggest_bottleneck            ? `- Biggest bottleneck: ${es.biggest_bottleneck}` : null,
    es.biggest_time_drain            ? `- Biggest time drain: ${es.biggest_time_drain}` : null,
    es.most_owner_dependent_step     ? `- Most owner-dependent: ${es.most_owner_dependent_step}` : null,
    es.most_immediate_ai_opportunity ? `- Most immediate AI opportunity: ${es.most_immediate_ai_opportunity}` : null,
    ``,
    fb.title ? `WHERE WE WOULD START: ${fb.title}` : null,
    fb.why_this_first ? fb.why_this_first : null,
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
