// Vercel Serverless Function — on SOP completion:
//   1) Run an "analysis pass" through Anthropic that turns the raw structured
//      SOP into a polished customer-ready deliverable: executive summary,
//      narrative, annotated steps, observations, ranked automation
//      opportunities, suggested next moves.
//   2) Create a structured Notion page in the SOP Library DB
//      (rich blocks rendered from the analysis output).
//   3) Email the polished SOP to the client and to Joe.
//
// Env: ANTHROPIC_API_KEY, NOTION_API_KEY, RESEND_API_KEY

const Anthropic = require("@anthropic-ai/sdk");
const { Client: NotionClient } = require("@notionhq/client");
const { Resend } = require("resend");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, ShadingType, LevelFormat,
  Table, TableRow, TableCell, WidthType, convertInchesToTwip,
} = require("docx");

const SOP_LIBRARY_DB_ID = "362567cd-8712-8174-982d-ffa3a95e441c";
const JOE_EMAIL = "joe@thepracticalai.co";
const FROM = "Practical AI Co. <joe@thepracticalai.co>";
const ANALYSIS_MODEL = "claude-sonnet-4-20250514";
const ANALYSIS_MAX_TOKENS = 8192;

// ============================================================
// Analysis pass — turns raw SOP into customer-ready deliverable
// ============================================================
const ANALYSIS_SYSTEM_PROMPT = `You are a senior operator at Practical AI Co. — a small business AI shop in Franklin, TN. We help owners turn the knowledge in their heads into systems that run without them. We don't sell strategy decks. We BUILD AI Employees that take real work off the owner's plate.

A small business owner just walked us through ONE of their processes in detail. Your job: produce a polished, customer-ready document that does two things at once:

1) Shows the owner we actually understood their business (specifics, names, real details from the interview).
2) Pitches the AI Employees Practical AI Co. would hire FOR THEM — as a proposal, not a homework assignment.

This document is the artifact of the conversation. It feels like a $5,000 deliverable — warm, specific, fun, confident, plainly written. Not a consulting report. More like meeting the small team you just hired.

==========================================================
HARD RULES — VIOLATE ANY OF THESE AND THE DELIVERABLE FAILS
==========================================================

1. NO NEW SPREADSHEETS. EVER. Do not recommend the client build, maintain, or "set up" a spreadsheet, tracking sheet, manual log, paper checklist, or any other manual list. The point of Practical AI Co. is to REMOVE manual work. Every spreadsheet recommendation is a self-inflicted credibility wound. If your first instinct is "they should create a sheet to track X," propose an AI Employee that watches and remembers X instead.

2. EXISTING SPREADSHEETS ARE FINE. The client may already maintain spreadsheets. We can absolutely build AI Employees that read FROM existing sheets, write TO existing sheets, or sync data across existing sheets. We just never ask them to create a NEW one or maintain a NEW manual list.

3. NO FAKE TOOL FEATURES. Do not propose "add a custom field to [tool]" unless you have direct evidence the tool supports custom fields. Limo Anywhere does not. Most legacy industry tools don't. When a tool can't do something, acknowledge it and propose an external AI Employee that bridges the gap (watches the tool's outputs, reads its emails, scrapes its dashboards) — not a fictional feature.

4. THIS IS A PROPOSAL, NOT A TO-DO LIST. Practical AI Co. is going to BUILD these AI Employees for the client. Frame every recommendation as something WE would build, hire, or ship. NEVER tell the client to go create a tool themselves. Wording examples:
   ✓ "We'd build Quill — your follow-up specialist..."
   ✓ "We'd hire Pace to handle your scheduling — she watches..."
   ✓ "Where we'd start: ship Quill first."
   ✗ "Create a tool that..."
   ✗ "Set up an automation to..."
   ✗ "You should build..."
   ✗ "Implement a system that..."

5. AI EMPLOYEES, NOT AGENTS OR AUTOMATIONS. Use the term "AI Employee" throughout. Each one is a hire. Give each one a friendly first name + a role title. Names should hint at function — short, distinct, easy to refer to in conversation ("Quill caught a stale quote today"). Examples: Quill (writing/replies), Pace (scheduling), Tally (counting/tracking), Sage (advisor), Beacon (alerts), Sweep (cleanup), Echo (follow-ups), Drift (monitoring), Mason (building artifacts).

6. NO CONSULTING JARGON. Banned words: leverage, optimize, behavioral triggers, utilization, operationalize, pattern recognition, actionable insights, synergies, ecosystem, transformation, robust, best-in-class, scalable (as filler), machine (as metaphor for a process), ROI, double down, north star, high-leverage, unlock, at scale, drive (as a verb when a real verb exists). If a sentence sounds like a slide deck, rewrite it.

7. SELF-REVIEW BEFORE OUTPUTTING. After drafting, read your full JSON once more. Check: does any sentence suggest the client create/maintain a spreadsheet, sheet, log, list, or new manual process? Does any opportunity describe a tool feature that doesn't exist? Is any sentence framed as the client's homework instead of our build? If yes — rewrite it. Then output.

==========================================================
OUTPUT FORMAT
==========================================================

Output a single JSON block wrapped in <ANALYSIS></ANALYSIS> tags. Use this exact structure (all fields must be present):

<ANALYSIS>
{
  "executiveSummary": "2-3 sharp sentences. The essence of this process AND our POV on what to do about it. The owner should read this and feel both seen and excited.",
  "openingNote": "1 paragraph (3-5 sentences). Warm opener acknowledging what we heard. End by framing the document as: here is your process, here are the AI Employees we'd hire for you, and here is where we'd start.",
  "maturity": {
    "overall": 6,
    "documentation": 7,
    "automationReadiness": 6,
    "resilience": 4,
    "explanation": "1 sentence tying the scores to specifics from the interview."
  },
  "currentStateNarrative": "1 flowing paragraph (4-6 sentences) describing how this process runs today. Storytelling, not bullets.",
  "stepsAnnotated": [
    {
      "n": 1,
      "action": "the step, cleaned up if needed",
      "tool": "tool or system",
      "owner": "who does it today",
      "output": "what this step produces, or empty string",
      "observation": "Optional 1-line note. Only if you have something genuinely useful to say. Most steps should have empty string."
    }
  ],
  "whatsWorking": [
    "1-line SPECIFIC observation grounded in interview detail.",
    "another (2-4 total)"
  ],
  "whatsBrittle": [
    "1-line SPECIFIC observation grounded in interview detail.",
    "another (2-4 total)"
  ],
  "aiEmployees": [
    {
      "rank": 1,
      "firstName": "Quill",
      "role": "Follow-Up Specialist",
      "tagline": "1 short sentence in the AI Employee's voice OR about them. Punchy. Like a LinkedIn bio line. Examples: 'Won't let a good quote sit unanswered.' / 'Watches your inbox so you don't have to.' / 'Keeps your subs honest about their insurance.'",
      "priority": "Quick win | Strategic | Long-term",
      "whatTheyDo": "1-2 sentences. Concrete description of what this AI Employee actually does, day to day. Reference real tools and real triggers from the interview. Do NOT suggest the client create a spreadsheet.",
      "whatYouSkip": "1-2 sentences. The mental load this lifts off the owner. What they no longer have to remember, chase, track, or worry about.",
      "appliesToSteps": [3, 4, 5],
      "timeSavings": "Rough estimate like '2-3 hours/week' or 'reclaims your Monday morning'",
      "estimatedDollarValue": "Annual dollar impact. GROUND in interview specifics when possible (deal sizes, headcount, hourly rates). When grounding is thin, give a wide range labeled 'rough estimate'. NEVER fabricate specific numbers.",
      "complexity": "Low | Medium | High",
      "buildEffort": "Realistic build estimate: '1 week', '2-3 weeks', '1-2 months', '2-3 months'.",
      "tools": ["specific tools or systems this AI Employee connects to"],
      "humanInLoop": "What the owner still owns: judgment calls, approvals, exceptions."
    }
  ],
  "whereWedStart": [
    {
      "name": "Quill",
      "pitch": "1-2 sentences. Why we'd ship THIS AI Employee first. What the owner will feel different about within the first week.",
      "timeline": "Like '1-2 weeks to ship' or '3-4 weeks for the first version'"
    }
  ],
  "closingNote": "1 paragraph (2-3 sentences). Warm, confident close. We're excited to build this with them. Not salesy."
}
</ANALYSIS>

==========================================================
FIELD GUIDANCE
==========================================================

aiEmployees: 3 to 5 total. Ranked by impact. Each one references real interview details. Each one is a real build proposal, not a vague idea.

appliesToSteps: array of step numbers (matching the "n" in stepsAnnotated) that this AI Employee would take over or assist with. If the AI Employee covers the whole process, list every step. If it only touches a few, list those. Helps the visual workflow show which steps get automated by which Employee.

whereWedStart: 1 to 3 entries, picked from the aiEmployees list. Ordered by build sequence — the first one is the first thing we'd ship. Reference the AI Employee by firstName.

maturity scoring (1-10, 10 = excellent, 1 = chaos):
- documentation: how well captured outside the owner's head
- automationReadiness: how mechanical vs. judgment-heavy
- resilience: how well it runs if the owner is out for a week
- overall: holistic, don't just average

priority:
- Quick win: under 2 weeks of build, fast obvious benefit
- Strategic: 2-8 weeks, important leverage point
- Long-term: 8+ weeks, foundational

==========================================================
TONE — FRIEND OVER COFFEE, NOT CONSULTANT IN A BOARDROOM
==========================================================

You're a smart small-business operator talking to another small-business owner. The owner is busy. They've been burned by consultants. They want plain English, real specifics, and to feel like the person on the other end actually gets their business.

GOOD vs BAD examples:

BAD: "David has built a disciplined prospecting machine that leverages behavioral triggers to optimize credit utilization."
GOOD: "David finds 10 to 25 prospects every morning in 30 minutes. The system is tight. Every click is still him."

BAD: "Strategic implementation of pattern recognition across the lead qualification funnel."
GOOD: "We'd hire Quill to do the first cut for you — the obvious yes-or-no candidates flagged before you ever see them."

BAD: "Create a spreadsheet to capture client preferences."
GOOD: "We'd hire Sage to remember what every client likes — preferred driver, preferred pickup style, prior trip notes — and surface it the moment that client is in your pipeline again."

BAD: "Add a 'notification sent' field to your reservations and track in a sheet."
GOOD: "We'd hire Beacon to watch your reservations and your sent-folder, match them up, and ping you the second a reservation hasn't been confirmed in time."

Plain English test: read every sentence out loud. If it sounds like a slide deck, rewrite. If it sounds like you'd say it to a friend over coffee, ship it.

Output ONLY the JSON in <ANALYSIS></ANALYSIS> tags. No other text.`;

async function runAnalysisPass(anthropic, sop, icp) {
  const icpBlock = icp && icp.trim()
    ? "\n\nThe client also shared their Ideal Customer Profile (ICP). Use this to ground your analysis. The best automation opportunities are the ones that help this process serve THIS specific customer better — reference the ICP wherever it sharpens an observation or opportunity.\n\n--- IDEAL CUSTOMER PROFILE ---\n" + icp.trim() + "\n--- END ICP ---\n"
    : "";
  const userMessage =
    "Here is the structured SOP we just captured in an interview with this business owner.\n\n" +
    "```json\n" +
    JSON.stringify(sop, null, 2) +
    "\n```" + icpBlock + "\n\n" +
    "Produce the polished analysis document per the format in your system prompt. Think carefully — this is going to the client. Plain English only. Reference specifics from the SOP" + (icp && icp.trim() ? " and the ICP" : "") + ".";

  const response = await anthropic.messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: ANALYSIS_MAX_TOKENS,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = (response.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const match = text.match(/<ANALYSIS>([\s\S]*?)<\/ANALYSIS>/);
  if (!match) {
    throw new Error("Analysis output did not include <ANALYSIS> tags");
  }
  return JSON.parse(match[1].trim());
}

// ============================================================
// Helpers
// ============================================================
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function asArr(x) { return Array.isArray(x) ? x : []; }

function richText(content) {
  const s = String(content || "");
  // Notion rich_text rejects strings > 2000 chars per text run
  if (s.length <= 1900) return [{ type: "text", text: { content: s } }];
  const out = [];
  for (let i = 0; i < s.length; i += 1900) {
    out.push({ type: "text", text: { content: s.slice(i, i + 1900) } });
  }
  return out;
}

// ============================================================
// Notion block builder — renders the analysis as a polished doc
// ============================================================
function buildNotionBlocks({ sop, analysis }) {
  const blocks = [];

  const heading2 = (t) => ({
    object: "block", type: "heading_2",
    heading_2: { rich_text: richText(t) },
  });
  const heading3 = (t) => ({
    object: "block", type: "heading_3",
    heading_3: { rich_text: richText(t) },
  });
  const paragraph = (t, color) => ({
    object: "block", type: "paragraph",
    paragraph: { rich_text: richText(t || ""), ...(color ? { color } : {}) },
  });
  const bullet = (t) => ({
    object: "block", type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(t) },
  });
  const numbered = (t) => ({
    object: "block", type: "numbered_list_item",
    numbered_list_item: { rich_text: richText(t) },
  });
  const callout = (t, opts = {}) => ({
    object: "block", type: "callout",
    callout: {
      icon: opts.emoji ? { type: "emoji", emoji: opts.emoji } : { type: "emoji", emoji: "💡" },
      color: opts.color || "blue_background",
      rich_text: richText(t),
    },
  });
  const divider = () => ({ object: "block", type: "divider", divider: {} });

  // Executive summary (callout, top of page)
  if (analysis.executiveSummary) {
    blocks.push(callout(analysis.executiveSummary, { emoji: "🎯", color: "blue_background" }));
  }

  // Opening note
  if (analysis.openingNote) {
    blocks.push(paragraph(analysis.openingNote));
  }

  // Process maturity scorecard
  if (analysis.maturity && typeof analysis.maturity === "object") {
    const m = analysis.maturity;
    const fmt = (n) => (n == null ? "?" : `${n}/10`);
    const line1 = `Overall ${fmt(m.overall)}  ·  Documentation ${fmt(m.documentation)}  ·  Automation readiness ${fmt(m.automationReadiness)}  ·  Resilience ${fmt(m.resilience)}`;
    const explanation = m.explanation ? "\n" + m.explanation : "";
    blocks.push(callout(line1 + explanation, { emoji: "📊", color: "purple_background" }));
  }

  // Quick-facts strip
  const facts = [];
  if (sop.frequency) facts.push("Frequency: " + sop.frequency);
  if (sop.estimatedTime) facts.push("Est. time: " + sop.estimatedTime);
  if (sop.owner) facts.push("Owner: " + sop.owner);
  if (sop.backup) facts.push("Backup: " + sop.backup);
  if (facts.length) {
    blocks.push(callout(facts.join("  ·  "), { emoji: "📋", color: "gray_background" }));
  }

  // Current State
  if (analysis.currentStateNarrative) {
    blocks.push(heading2("Current state"));
    blocks.push(paragraph(analysis.currentStateNarrative));
  }

  // Trigger
  if (sop.trigger) {
    blocks.push(heading2("Trigger"));
    blocks.push(paragraph(sop.trigger));
  }

  // Dependencies
  if (asArr(sop.dependencies).length) {
    blocks.push(heading2("Dependencies"));
    asArr(sop.dependencies).forEach((d) => blocks.push(bullet(d)));
  }

  // Helper: AI Employees that cover a given step number
  const employeesForStep = (n) =>
    asArr(analysis.aiEmployees).filter((e) =>
      asArr(e.appliesToSteps).some((sN) => Number(sN) === Number(n))
    );

  // Workflow (annotated steps + AI Employee handoff chips)
  const annotatedSteps = asArr(analysis.stepsAnnotated).length
    ? asArr(analysis.stepsAnnotated)
    : asArr(sop.steps);
  if (annotatedSteps.length) {
    blocks.push(heading2("The assembly line"));
    blocks.push(paragraph(
      "Every step of your process, in order. Where an AI Employee can take over, you'll see them tagged below.",
      "gray"
    ));
    annotatedSteps.forEach((s) => {
      const action = s.action || "";
      blocks.push(numbered(action));
      const metaParts = [];
      if (s.tool) metaParts.push("Tool: " + s.tool);
      if (s.owner) metaParts.push("Owner: " + s.owner);
      if (s.output) metaParts.push("Output: " + s.output);
      if (metaParts.length) {
        blocks.push(paragraph(metaParts.join("  ·  "), "gray"));
      }
      if (s.observation && s.observation.trim()) {
        blocks.push(callout(s.observation, { emoji: "💡", color: "yellow_background" }));
      }
      asArr(s.branches).forEach((b) => {
        blocks.push(bullet("If " + (b.if || "") + "  →  " + (b.then || "")));
      });
      // AI Employee handoff chips
      const handoffs = employeesForStep(s.n);
      handoffs.forEach((e) => {
        const tag = `${e.firstName || "AI Employee"} (${e.role || "AI Employee"}) takes this`;
        blocks.push(callout(tag, { emoji: "⚡", color: "blue_background" }));
      });
    });
  }

  // Decisions
  if (asArr(sop.decisions).length) {
    blocks.push(heading2("Decision points"));
    asArr(sop.decisions).forEach((d) =>
      blocks.push(bullet("If " + (d.if || "") + "  →  " + (d.then || "")))
    );
  }

  // Failure modes
  if (asArr(sop.failureModes).length) {
    blocks.push(heading2("Failure modes & recovery"));
    asArr(sop.failureModes).forEach((f) =>
      blocks.push(bullet((f.issue || "") + "  →  " + (f.recovery || "")))
    );
  }

  // Definition of done
  if (sop.definitionOfDone) {
    blocks.push(heading2("Definition of done"));
    blocks.push(paragraph(sop.definitionOfDone));
  }

  // Strategic analysis — what's working / brittle
  if (asArr(analysis.whatsWorking).length || asArr(analysis.whatsBrittle).length) {
    blocks.push(divider());
    blocks.push(heading2("Strategic observations"));
  }
  if (asArr(analysis.whatsWorking).length) {
    blocks.push(heading3("What's working"));
    asArr(analysis.whatsWorking).forEach((x) => blocks.push(bullet(x)));
  }
  if (asArr(analysis.whatsBrittle).length) {
    blocks.push(heading3("What's brittle"));
    asArr(analysis.whatsBrittle).forEach((x) => blocks.push(bullet(x)));
  }

  // AI Employees (the headline deliverable)
  if (asArr(analysis.aiEmployees).length) {
    blocks.push(divider());
    blocks.push(heading2("Your first suggested AI Employees"));
    blocks.push(paragraph(
      "Each one is a build we'd ship for you. Names you can remember. Roles you can point at. Things you can stop doing.",
      "gray"
    ));
    asArr(analysis.aiEmployees).forEach((emp) => {
      const rank = String(emp.rank || "").padStart(2, "0");
      const priority = emp.priority ? `  ·  ${emp.priority}` : "";
      const firstName = emp.firstName || emp.name || "AI Employee";
      const role = emp.role || "";
      const heading = role
        ? `#${rank} · ${firstName} · ${role}${priority}`
        : `#${rank} · ${firstName}${priority}`;
      blocks.push(heading3(heading));
      if (emp.tagline) {
        blocks.push(callout(emp.tagline, { emoji: "💬", color: "gray_background" }));
      }
      if (emp.whatTheyDo) blocks.push(paragraph("What they do: " + emp.whatTheyDo));
      if (emp.whatYouSkip) blocks.push(paragraph("What you skip: " + emp.whatYouSkip));
      const metaFacts = [];
      if (emp.timeSavings) metaFacts.push("Time savings: " + emp.timeSavings);
      if (emp.estimatedDollarValue) metaFacts.push("Est. value: " + emp.estimatedDollarValue);
      if (emp.buildEffort) metaFacts.push("Build effort: " + emp.buildEffort);
      if (emp.complexity) metaFacts.push("Complexity: " + emp.complexity);
      if (asArr(emp.tools).length) metaFacts.push("Tools: " + asArr(emp.tools).join(", "));
      if (asArr(emp.appliesToSteps).length) metaFacts.push("Covers steps: " + asArr(emp.appliesToSteps).join(", "));
      if (metaFacts.length) blocks.push(paragraph(metaFacts.join("  ·  "), "gray"));
      if (emp.humanInLoop) blocks.push(paragraph("You still own: " + emp.humanInLoop));
    });
  }

  // Where we'd start
  if (asArr(analysis.whereWedStart).length) {
    blocks.push(divider());
    blocks.push(heading2("Where we'd start"));
    blocks.push(paragraph(
      "Our recommended build order. We don't ship them all at once — we ship one, prove it works, and roll into the next.",
      "gray"
    ));
    asArr(analysis.whereWedStart).forEach((w, i) => {
      const stepNum = i + 1;
      const heading = w.name
        ? `${stepNum}. ${w.name}` + (w.timeline ? ` · ${w.timeline}` : "")
        : `${stepNum}.`;
      blocks.push(heading3(heading));
      if (w.pitch) blocks.push(paragraph(w.pitch));
    });
  }

  // Closing
  if (analysis.closingNote) {
    blocks.push(callout(analysis.closingNote, { emoji: "🤝", color: "blue_background" }));
  }

  // Notion API max children per request is 100. Trim safely.
  return blocks.slice(0, 95);
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
    "Status": { select: { name: "Draft" } },
    "Last Updated": { date: { start: today } },
  };
}

async function createSopPage(notion, props, children) {
  return notion.pages.create({
    parent: { database_id: SOP_LIBRARY_DB_ID },
    properties: props,
    children,
  });
}

// ============================================================
// Email rendering — polished HTML
// ============================================================
function renderEmailHtml({ sop, analysis, isJoe, businessName, firstName }) {
  const wrap = (inner) => `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FBF5EA;font-family:Helvetica,Arial,sans-serif;color:#172033;">
  <div style="max-width:680px;margin:0 auto;padding:40px 24px 60px;">
    <div style="font-family:Georgia,serif;font-weight:800;color:#172033;font-size:24px;letter-spacing:-0.02em;margin-bottom:4px;">
      Practical <span style="color:#2456FF;">AI</span> Co.
    </div>
    <div style="font-size:10px;font-weight:900;letter-spacing:0.26em;color:#667085;text-transform:uppercase;margin-bottom:28px;">
      Systems that run so you can lead
    </div>
    ${inner}
    <div style="margin-top:40px;padding-top:20px;border-top:1px solid #E7DCCB;font-size:12px;color:#8A93A5;">
      Practical AI Co. &middot; Franklin, TN &middot; <a href="mailto:joe@thepracticalai.co" style="color:#2456FF;text-decoration:none;">joe@thepracticalai.co</a>
    </div>
  </div>
</body></html>`;

  const H2 = (t) => `<h2 style="font-family:Georgia,serif;font-size:22px;letter-spacing:-0.022em;color:#172033;margin:36px 0 12px;border-top:1px solid #E7DCCB;padding-top:28px;">${esc(t)}</h2>`;
  const H3 = (t) => `<h3 style="font-family:Georgia,serif;font-size:17px;letter-spacing:-0.018em;color:#172033;margin:22px 0 6px;">${esc(t)}</h3>`;
  const P = (t, opts = {}) => {
    const color = opts.muted ? "#667085" : "#172033";
    return `<p style="margin:8px 0;color:${color};line-height:1.6;font-size:15px;">${esc(t)}</p>`;
  };
  const UL = (arr) =>
    arr.length
      ? `<ul style="margin:8px 0 14px;padding-left:20px;color:#172033;">${arr.map((x) => `<li style="margin:6px 0;line-height:1.55;">${esc(x)}</li>`).join("")}</ul>`
      : "";

  const calloutBlock = (text, opts = {}) => `
    <div style="background:${opts.bg || "rgba(36,86,255,0.08)"};border-left:3px solid ${opts.border || "#2456FF"};padding:18px 22px;border-radius:8px;margin:18px 0;color:#172033;font-size:15px;line-height:1.55;">
      ${esc(text)}
    </div>`;

  const factsCallout = (() => {
    const facts = [];
    if (sop.frequency) facts.push(["Frequency", sop.frequency]);
    if (sop.estimatedTime) facts.push(["Est. time", sop.estimatedTime]);
    if (sop.owner) facts.push(["Owner", sop.owner]);
    if (sop.backup) facts.push(["Backup", sop.backup]);
    if (!facts.length) return "";
    return `<table cellpadding="10" cellspacing="0" style="margin:14px 0 28px;background:#FBF5EA;border:1px solid #E7DCCB;border-radius:10px;width:100%;border-collapse:separate;">
      <tr>${facts.map(([l, v]) => `
        <td style="font-size:13px;color:#172033;vertical-align:top;">
          <div style="font-size:10px;font-weight:900;color:#667085;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:2px;">${esc(l)}</div>
          <div style="font-weight:700;">${esc(v)}</div>
        </td>`).join("")}
      </tr>
    </table>`;
  })();

  const employeesForStepEmail = (n) =>
    asArr(analysis.aiEmployees).filter((e) =>
      asArr(e.appliesToSteps).some((sN) => Number(sN) === Number(n))
    );

  const stepsHtml = (() => {
    const steps = asArr(analysis.stepsAnnotated).length ? asArr(analysis.stepsAnnotated) : asArr(sop.steps);
    if (!steps.length) return P("(no steps captured)", { muted: true });
    return steps.map((s, i) => {
      const n = s.n || (i + 1);
      const meta = [];
      if (s.tool) meta.push("<b>Tool:</b> " + esc(s.tool));
      if (s.owner) meta.push("<b>Owner:</b> " + esc(s.owner));
      if (s.output) meta.push("<b>Output:</b> " + esc(s.output));
      const metaLine = meta.length
        ? `<div style="font-size:13px;color:#667085;margin-top:4px;">${meta.join("&nbsp; &middot; &nbsp;")}</div>`
        : "";
      const obs = s.observation && s.observation.trim()
        ? `<div style="margin-top:8px;background:rgba(255,200,40,0.10);border-left:3px solid #B45309;padding:10px 14px;border-radius:6px;font-size:14px;color:#172033;line-height:1.5;"><b>Note:</b> ${esc(s.observation)}</div>`
        : "";
      const branches = asArr(s.branches).length
        ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#667085;">${asArr(s.branches).map((b) => `<li><b>If</b> ${esc(b.if || "")} &rarr; ${esc(b.then || "")}</li>`).join("")}</ul>`
        : "";
      const handoffs = employeesForStepEmail(n);
      const handoffHtml = handoffs.length
        ? handoffs.map((e) => `<div style="margin-top:8px;display:inline-block;background:rgba(36,86,255,0.10);border-left:3px solid #2456FF;padding:8px 12px;border-radius:6px;font-size:13.5px;color:#172033;"><b>⚡ ${esc(e.firstName || "AI Employee")}</b> (${esc(e.role || "AI Employee")}) takes this</div>`).join(" ")
        : "";
      const accent = handoffs.length ? "#2456FF" : "#E7DCCB";
      return `<div style="padding:16px 18px;background:#FFFDF8;border:1px solid #E7DCCB;border-left:4px solid ${accent};border-radius:12px;margin:12px 0;">
        <div style="display:flex;gap:14px;align-items:baseline;">
          <div style="font-family:Georgia,serif;font-weight:800;color:#2456FF;font-size:18px;min-width:24px;">${n}.</div>
          <div style="font-size:15px;font-weight:700;color:#172033;line-height:1.4;">${esc(s.action || "")}</div>
        </div>
        ${metaLine}${obs}${branches}${handoffHtml}
      </div>`;
    }).join("");
  })();

  const priorityPillEmail = (priority) => {
    if (!priority) return "";
    const colorMap = {
      "Quick win": ["#2F8F5B", "rgba(47,143,91,0.10)"],
      "Strategic": ["#2456FF", "rgba(36,86,255,0.10)"],
      "Long-term": ["#B45309", "rgba(180,83,9,0.10)"],
    };
    const [color, bg] = colorMap[priority] || ["#172033", "rgba(23,32,51,0.08)"];
    return `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${bg};color:${color};font-size:10px;font-weight:900;letter-spacing:0.14em;text-transform:uppercase;margin-left:8px;vertical-align:middle;">${esc(priority)}</span>`;
  };

  const employeesHtml = (() => {
    const employees = asArr(analysis.aiEmployees);
    if (!employees.length) return "";
    return employees.map((e) => {
      const rank = String(e.rank || "").padStart(2, "0");
      const firstName = e.firstName || e.name || "AI Employee";
      const role = e.role || "";
      const facts = [];
      if (e.timeSavings) facts.push(["Time savings", e.timeSavings]);
      if (e.estimatedDollarValue) facts.push(["Est. value", e.estimatedDollarValue]);
      if (e.buildEffort) facts.push(["Build effort", e.buildEffort]);
      if (e.complexity) facts.push(["Complexity", e.complexity]);
      if (asArr(e.tools).length) facts.push(["Tools", asArr(e.tools).join(", ")]);
      if (asArr(e.appliesToSteps).length) facts.push(["Covers steps", asArr(e.appliesToSteps).join(", ")]);
      const factsHtml = facts.length
        ? `<div style="margin-top:10px;font-size:13px;color:#667085;line-height:1.7;">${facts.map(([l, v]) => `<b>${esc(l)}:</b> ${esc(v)}`).join("&nbsp; &middot; &nbsp;")}</div>`
        : "";
      const tagline = e.tagline
        ? `<div style="margin:4px 0 12px;font-style:italic;color:#667085;font-size:15px;line-height:1.5;">&ldquo;${esc(e.tagline)}&rdquo;</div>`
        : "";
      return `<div style="padding:20px 22px;background:#FFFDF8;border:1px solid #E7DCCB;border-radius:14px;margin:14px 0;">
        <div style="font-size:11px;font-weight:900;color:#2456FF;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:6px;">AI Employee #${rank}${priorityPillEmail(e.priority)}</div>
        <div style="font-family:Georgia,serif;font-size:24px;font-weight:800;color:#172033;letter-spacing:-0.022em;line-height:1.15;">${esc(firstName)}<span style="color:#667085;font-size:16px;font-weight:600;margin-left:10px;">${esc(role)}</span></div>
        ${tagline}
        ${e.whatTheyDo ? `<div style="margin-top:10px;font-size:14.5px;line-height:1.55;"><b>What they do:</b> ${esc(e.whatTheyDo)}</div>` : ""}
        ${e.whatYouSkip ? `<div style="margin-top:6px;font-size:14.5px;line-height:1.55;"><b>What you skip:</b> ${esc(e.whatYouSkip)}</div>` : ""}
        ${factsHtml}
        ${e.humanInLoop ? `<div style="margin-top:8px;font-size:14px;color:#667085;line-height:1.55;"><b>You still own:</b> ${esc(e.humanInLoop)}</div>` : ""}
      </div>`;
    }).join("");
  })();

  const whereWedStartHtml = (() => {
    const items = asArr(analysis.whereWedStart);
    if (!items.length) return "";
    return items.map((w, i) => {
      const stepNum = i + 1;
      return `<div style="padding:18px 22px;background:rgba(36,86,255,0.04);border:1px solid #E7DCCB;border-radius:14px;margin:10px 0;">
        <div style="font-size:11px;font-weight:900;color:#2456FF;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:6px;">Build ${stepNum}${w.timeline ? `&nbsp; &middot; &nbsp;${esc(w.timeline)}` : ""}</div>
        <div style="font-family:Georgia,serif;font-size:20px;font-weight:800;color:#172033;letter-spacing:-0.022em;margin-bottom:8px;">${esc(w.name || "")}</div>
        ${w.pitch ? `<div style="font-size:14.5px;color:#172033;line-height:1.55;">${esc(w.pitch)}</div>` : ""}
      </div>`;
    }).join("");
  })();

  const maturityHtml = (() => {
    const m = analysis.maturity;
    if (!m) return "";
    const cell = (label, score) => `
      <td style="vertical-align:top;padding:10px;text-align:center;">
        <div style="font-size:11px;font-weight:900;letter-spacing:0.14em;color:#8A93A5;text-transform:uppercase;margin-bottom:6px;">${esc(label)}</div>
        <div style="font-family:Georgia,serif;font-size:24px;font-weight:800;color:#172033;letter-spacing:-0.025em;line-height:1;">${score == null ? "?" : score}<span style="font-size:13px;color:#8A93A5;font-weight:600;">/10</span></div>
      </td>`;
    return `<div style="margin:24px 0 8px;border:1px solid #E7DCCB;border-radius:14px;overflow:hidden;background:rgba(36,86,255,0.04);">
      <div style="padding:12px 18px;font-size:11px;font-weight:900;letter-spacing:0.18em;text-transform:uppercase;color:#2456FF;border-bottom:1px solid #E7DCCB;">Process maturity</div>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;">
        <tr>
          ${cell("Overall", m.overall)}
          ${cell("Documentation", m.documentation)}
          ${cell("Automation Readiness", m.automationReadiness)}
          ${cell("Resilience", m.resilience)}
        </tr>
      </table>
      ${m.explanation ? `<div style="padding:6px 18px 16px;font-size:14px;color:#172033;line-height:1.55;">${esc(m.explanation)}</div>` : ""}
    </div>`;
  })();

  const greeting = isJoe
    ? P(`A new SOP just completed. Analysis below. Full record also synced to the SOP Library in Notion.`)
    : "";

  const inner = `
    <h1 style="font-family:Georgia,serif;font-size:32px;letter-spacing:-0.028em;color:#172033;margin:0 0 6px;line-height:1.12;">${esc(sop.processName || "Process")}</h1>
    <div style="color:#667085;font-size:13px;font-weight:700;margin-bottom:18px;">
      ${esc(businessName)} &middot; ${esc(firstName)} &middot; ${esc(sop.date || "")}
    </div>
    ${greeting}
    ${analysis.executiveSummary ? calloutBlock(analysis.executiveSummary, { bg: "rgba(36,86,255,0.08)", border: "#2456FF" }) : ""}
    ${analysis.openingNote ? P(analysis.openingNote) : ""}
    ${maturityHtml}
    ${factsCallout}

    ${analysis.currentStateNarrative ? H2("Current state") + P(analysis.currentStateNarrative) : ""}

    ${sop.trigger ? H2("Trigger") + P(sop.trigger) : ""}
    ${asArr(sop.dependencies).length ? H2("Dependencies") + UL(asArr(sop.dependencies)) : ""}

    ${H2("The assembly line")}
    ${P("Every step in order. Where an AI Employee would take over, you'll see them tagged.", { muted: true })}
    ${stepsHtml}

    ${asArr(sop.decisions).length ? H2("Decision points") + UL(asArr(sop.decisions).map((d) => `If ${d.if || ""} → ${d.then || ""}`)) : ""}
    ${asArr(sop.failureModes).length ? H2("Failure modes & recovery") + UL(asArr(sop.failureModes).map((f) => `${f.issue || ""} → ${f.recovery || ""}`)) : ""}
    ${sop.definitionOfDone ? H2("Definition of done") + P(sop.definitionOfDone) : ""}

    ${(asArr(analysis.whatsWorking).length || asArr(analysis.whatsBrittle).length) ? H2("What we noticed") : ""}
    ${asArr(analysis.whatsWorking).length ? H3("What's working") + UL(asArr(analysis.whatsWorking)) : ""}
    ${asArr(analysis.whatsBrittle).length ? H3("What's brittle") + UL(asArr(analysis.whatsBrittle)) : ""}

    ${asArr(analysis.aiEmployees).length ? H2("Your first suggested AI Employees") + P("Each one is a build we'd ship for you. Names you can remember, roles you can point at, things you can stop doing.", { muted: true }) + employeesHtml : ""}

    ${asArr(analysis.whereWedStart).length ? H2("Where we'd start") + P("Our recommended build order. We ship one, prove it, then roll into the next.", { muted: true }) + whereWedStartHtml : ""}

    ${analysis.closingNote ? calloutBlock(analysis.closingNote, { bg: "rgba(47,143,91,0.08)", border: "#2F8F5B" }) : ""}
  `;

  return wrap(inner);
}

// Plain-text fallback for email clients that don't render HTML
function renderPlainText({ sop, analysis }) {
  const lines = [];
  lines.push("SOP: " + (sop.processName || ""));
  lines.push("");
  if (analysis.executiveSummary) {
    lines.push(analysis.executiveSummary);
    lines.push("");
  }
  if (analysis.currentStateNarrative) {
    lines.push("CURRENT STATE");
    lines.push(analysis.currentStateNarrative);
    lines.push("");
  }
  lines.push("THE ASSEMBLY LINE");
  const employeesForStepText = (n) =>
    asArr(analysis.aiEmployees).filter((e) =>
      asArr(e.appliesToSteps).some((sN) => Number(sN) === Number(n))
    );
  const steps = asArr(analysis.stepsAnnotated).length ? asArr(analysis.stepsAnnotated) : asArr(sop.steps);
  steps.forEach((s, i) => {
    const n = s.n || (i + 1);
    lines.push("  " + n + ". " + (s.action || ""));
    const meta = [];
    if (s.tool) meta.push("Tool: " + s.tool);
    if (s.owner) meta.push("Owner: " + s.owner);
    if (s.output) meta.push("Output: " + s.output);
    if (meta.length) lines.push("       " + meta.join(" | "));
    if (s.observation && s.observation.trim()) lines.push("       Note: " + s.observation);
    const handoffs = employeesForStepText(n);
    handoffs.forEach((e) => {
      lines.push("       >> " + (e.firstName || "AI Employee") + " (" + (e.role || "AI Employee") + ") takes this");
    });
  });
  lines.push("");
  if (asArr(analysis.aiEmployees).length) {
    lines.push("YOUR FIRST SUGGESTED AI EMPLOYEES");
    asArr(analysis.aiEmployees).forEach((e) => {
      const rank = String(e.rank || "").padStart(2, "0");
      const firstName = e.firstName || e.name || "AI Employee";
      const role = e.role || "";
      lines.push("  #" + rank + " " + firstName + (role ? " - " + role : ""));
      if (e.tagline) lines.push("       \"" + e.tagline + "\"");
      if (e.whatTheyDo) lines.push("       What they do: " + e.whatTheyDo);
      if (e.whatYouSkip) lines.push("       What you skip: " + e.whatYouSkip);
      if (e.timeSavings) lines.push("       Time savings: " + e.timeSavings);
      if (e.estimatedDollarValue) lines.push("       Est. value: " + e.estimatedDollarValue);
      if (e.buildEffort) lines.push("       Build effort: " + e.buildEffort);
    });
    lines.push("");
  }
  if (asArr(analysis.whereWedStart).length) {
    lines.push("WHERE WE'D START");
    asArr(analysis.whereWedStart).forEach((w, i) => {
      lines.push("  " + (i + 1) + ". " + (w.name || "") + (w.timeline ? "  (" + w.timeline + ")" : ""));
      if (w.pitch) lines.push("       " + w.pitch);
    });
  }
  return lines.join("\n");
}

// ============================================================
// Fallback analysis (used if the analysis pass fails)
// ============================================================
function buildFallbackAnalysis(sop) {
  return {
    executiveSummary:
      `Captured a working SOP for ${sop.processName || "this process"}. Below is the workflow as documented, ready to hand off.`,
    openingNote:
      "Here's the process as we captured it together. We weren't able to run our strategic analysis pass this round, but everything you walked through is recorded faithfully below.",
    maturity: null,
    currentStateNarrative: sop.trigger || "",
    stepsAnnotated: asArr(sop.steps).map((s, i) => ({
      n: s.n || (i + 1),
      action: s.action || "",
      tool: s.tool || "",
      owner: s.owner || "",
      output: s.output || "",
      observation: "",
    })),
    whatsWorking: [],
    whatsBrittle: [],
    aiEmployees: [],
    whereWedStart: [],
    closingNote:
      "Strategic analysis pass didn't run cleanly this session. Joe will review the captured SOP and follow up with observations and automation opportunities directly.",
  };
}

// ============================================================
// .docx generation — editable artifact for the client
// ============================================================
const DOCX_BLUE = "2456FF";
const DOCX_INK = "172033";
const DOCX_MUTED = "667085";
const DOCX_CREAM = "FBF5EA";
const DOCX_LINE = "E7DCCB";
const DOCX_GREEN = "2F8F5B";
const DOCX_AMBER = "B45309";

function docxText(text, opts = {}) {
  return new TextRun({
    text: String(text || ""),
    bold: !!opts.bold,
    italics: !!opts.italics,
    size: opts.size || 22, // half-points; 22 = 11pt
    color: opts.color || DOCX_INK,
    font: opts.font || "Helvetica",
  });
}

function docxParagraph(text, opts = {}) {
  return new Paragraph({
    children: [docxText(text, opts)],
    spacing: { before: opts.before == null ? 80 : opts.before, after: opts.after == null ? 80 : opts.after },
    alignment: opts.align || AlignmentType.LEFT,
  });
}

function docxHeading(text, level, opts = {}) {
  const levelMap = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  };
  return new Paragraph({
    heading: levelMap[level] || HeadingLevel.HEADING_2,
    children: [docxText(text, {
      bold: true,
      size: level === 1 ? 48 : level === 2 ? 32 : 26,
      color: opts.color || DOCX_INK,
      font: "Georgia",
    })],
    spacing: { before: level === 1 ? 0 : 280, after: 120 },
  });
}

function docxBullet(text, level = 0) {
  return new Paragraph({
    children: [docxText(text)],
    bullet: { level },
    spacing: { before: 40, after: 40 },
  });
}

function docxNumbered(text, level = 0) {
  return new Paragraph({
    children: [docxText(text)],
    numbering: { reference: "default-numbering", level },
    spacing: { before: 40, after: 40 },
  });
}

function docxCallout(text, opts = {}) {
  const color = opts.color || DOCX_BLUE;
  return new Paragraph({
    children: [docxText(text, { italics: opts.italics, size: 22, color: DOCX_INK })],
    border: {
      left: { color, space: 6, style: BorderStyle.SINGLE, size: 24 },
    },
    indent: { left: convertInchesToTwip(0.15) },
    shading: { type: ShadingType.CLEAR, fill: opts.fill || "EEF3FF" },
    spacing: { before: 120, after: 120 },
  });
}

function docxKV(label, value) {
  return new Paragraph({
    children: [
      docxText(label + ": ", { bold: true, size: 20, color: DOCX_MUTED }),
      docxText(value || "", { size: 20, color: DOCX_INK }),
    ],
    spacing: { before: 30, after: 30 },
  });
}

function docxDivider() {
  return new Paragraph({
    children: [docxText("")],
    border: {
      bottom: { color: DOCX_LINE, space: 1, style: BorderStyle.SINGLE, size: 6 },
    },
    spacing: { before: 200, after: 200 },
  });
}

function docxSpacer(twips = 200) {
  return new Paragraph({
    children: [docxText("")],
    spacing: { before: 0, after: twips },
  });
}

async function generateSopDocx({ sop, analysis, businessName, firstName }) {
  const children = [];

  // Cover header — brand wordmark
  children.push(new Paragraph({
    children: [
      docxText("Practical ", { bold: true, size: 32, color: DOCX_INK, font: "Georgia" }),
      docxText("AI", { bold: true, size: 32, color: DOCX_BLUE, font: "Georgia" }),
      docxText(" Co.", { bold: true, size: 32, color: DOCX_INK, font: "Georgia" }),
    ],
    spacing: { before: 0, after: 60 },
  }));
  children.push(new Paragraph({
    children: [docxText("SYSTEMS THAT RUN SO YOU CAN LEAD", {
      bold: true, size: 16, color: DOCX_MUTED, font: "Helvetica",
    })],
    spacing: { before: 0, after: 480 },
  }));

  // Title
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [docxText(sop.processName || "Process", {
      bold: true, size: 56, color: DOCX_INK, font: "Georgia",
    })],
    spacing: { before: 0, after: 60 },
  }));
  children.push(new Paragraph({
    children: [docxText(
      `${businessName || ""}  ·  ${firstName || ""}  ·  ${sop.date || ""}`,
      { size: 22, color: DOCX_MUTED, bold: true }
    )],
    spacing: { before: 0, after: 320 },
  }));

  // Executive summary
  if (analysis.executiveSummary) {
    children.push(docxCallout(analysis.executiveSummary, { color: DOCX_BLUE, fill: "EEF3FF" }));
  }
  if (analysis.openingNote) {
    children.push(docxParagraph(analysis.openingNote, { after: 200 }));
  }

  // Quick facts
  const facts = [];
  if (sop.frequency) facts.push(["Frequency", sop.frequency]);
  if (sop.estimatedTime) facts.push(["Est. time", sop.estimatedTime]);
  if (sop.owner) facts.push(["Owner", sop.owner]);
  if (sop.backup) facts.push(["Backup", sop.backup]);
  if (facts.length) {
    children.push(docxHeading("At a glance", 3));
    facts.forEach(([l, v]) => children.push(docxKV(l, v)));
    children.push(docxSpacer(200));
  }

  // Maturity scorecard
  if (analysis.maturity && typeof analysis.maturity === "object") {
    const m = analysis.maturity;
    children.push(docxHeading("Process maturity", 3));
    const cellPara = (label, score) => new TableCell({
      width: { size: 25, type: WidthType.PERCENTAGE },
      margins: { top: 120, bottom: 120, left: 120, right: 120 },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [docxText(label, { bold: true, size: 16, color: DOCX_MUTED })],
          spacing: { after: 60 },
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            docxText(String(score == null ? "?" : score), { bold: true, size: 36, color: DOCX_INK, font: "Georgia" }),
            docxText("/10", { size: 20, color: DOCX_MUTED }),
          ],
        }),
      ],
    });
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: DOCX_LINE },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: DOCX_LINE },
        left: { style: BorderStyle.SINGLE, size: 4, color: DOCX_LINE },
        right: { style: BorderStyle.SINGLE, size: 4, color: DOCX_LINE },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: DOCX_LINE },
        insideVertical: { style: BorderStyle.SINGLE, size: 4, color: DOCX_LINE },
      },
      rows: [
        new TableRow({
          children: [
            cellPara("Overall", m.overall),
            cellPara("Documentation", m.documentation),
            cellPara("Automation Readiness", m.automationReadiness),
            cellPara("Resilience", m.resilience),
          ],
        }),
      ],
    }));
    if (m.explanation) {
      children.push(docxParagraph(m.explanation, { before: 120, after: 200 }));
    }
  }

  // Current state narrative
  if (analysis.currentStateNarrative) {
    children.push(docxHeading("Current state", 2));
    children.push(docxParagraph(analysis.currentStateNarrative));
  }

  // Trigger
  if (sop.trigger) {
    children.push(docxHeading("Trigger", 3));
    children.push(docxParagraph(sop.trigger));
  }

  // Dependencies
  if (asArr(sop.dependencies).length) {
    children.push(docxHeading("Dependencies", 3));
    asArr(sop.dependencies).forEach((d) => children.push(docxBullet(d)));
  }

  // Assembly line — workflow with AI Employee chips
  const employeesForStepDocx = (n) =>
    asArr(analysis.aiEmployees).filter((e) =>
      asArr(e.appliesToSteps).some((sN) => Number(sN) === Number(n))
    );
  const steps = asArr(analysis.stepsAnnotated).length
    ? asArr(analysis.stepsAnnotated)
    : asArr(sop.steps);
  if (steps.length) {
    children.push(docxHeading("The assembly line", 2));
    children.push(docxParagraph(
      "Every step in order. Where an AI Employee can take over, you'll see them tagged.",
      { italics: true, color: DOCX_MUTED, after: 160 }
    ));
    steps.forEach((s, i) => {
      const n = s.n || (i + 1);
      // Numbered action heading
      children.push(new Paragraph({
        children: [
          docxText(`Step ${n}.  `, { bold: true, size: 22, color: DOCX_BLUE, font: "Georgia" }),
          docxText(s.action || "", { bold: true, size: 22, color: DOCX_INK }),
        ],
        spacing: { before: 200, after: 60 },
      }));
      // Meta line
      const meta = [];
      if (s.tool) meta.push("Tool: " + s.tool);
      if (s.owner) meta.push("Owner: " + s.owner);
      if (s.output) meta.push("Output: " + s.output);
      if (meta.length) {
        children.push(new Paragraph({
          children: [docxText(meta.join("    ·    "), { size: 18, color: DOCX_MUTED })],
          spacing: { before: 0, after: 60 },
          indent: { left: convertInchesToTwip(0.3) },
        }));
      }
      // Observation
      if (s.observation && s.observation.trim()) {
        children.push(docxCallout("Note: " + s.observation, { color: DOCX_AMBER, fill: "FFF6E0" }));
      }
      // Branches
      asArr(s.branches).forEach((b) => {
        children.push(new Paragraph({
          children: [
            docxText("If ", { bold: true, size: 19, color: DOCX_MUTED }),
            docxText(b.if || "", { size: 19, color: DOCX_INK }),
            docxText("  →  ", { size: 19, color: DOCX_MUTED }),
            docxText(b.then || "", { size: 19, color: DOCX_INK }),
          ],
          spacing: { before: 30, after: 30 },
          indent: { left: convertInchesToTwip(0.4) },
        }));
      });
      // AI Employee handoff chips
      const handoffs = employeesForStepDocx(n);
      handoffs.forEach((e) => {
        const name = e.firstName || e.name || "AI Employee";
        const role = e.role || "AI Employee";
        children.push(docxCallout(`⚡ ${name} (${role}) takes this step`, { color: DOCX_BLUE, fill: "EEF3FF" }));
      });
    });
  }

  // Decisions
  if (asArr(sop.decisions).length) {
    children.push(docxHeading("Decision points", 2));
    asArr(sop.decisions).forEach((d) => {
      children.push(docxBullet(`If ${d.if || ""}  →  ${d.then || ""}`));
    });
  }

  // Failure modes
  if (asArr(sop.failureModes).length) {
    children.push(docxHeading("Failure modes and recovery", 2));
    asArr(sop.failureModes).forEach((f) => {
      children.push(docxBullet(`${f.issue || ""}  →  ${f.recovery || ""}`));
    });
  }

  // Definition of done
  if (sop.definitionOfDone) {
    children.push(docxHeading("Definition of done", 2));
    children.push(docxParagraph(sop.definitionOfDone));
  }

  // What we noticed
  if (asArr(analysis.whatsWorking).length || asArr(analysis.whatsBrittle).length) {
    children.push(docxDivider());
    children.push(docxHeading("What we noticed", 2));
  }
  if (asArr(analysis.whatsWorking).length) {
    children.push(docxHeading("What's working", 3, { color: DOCX_GREEN }));
    asArr(analysis.whatsWorking).forEach((x) => children.push(docxBullet(x)));
  }
  if (asArr(analysis.whatsBrittle).length) {
    children.push(docxHeading("What's brittle", 3, { color: DOCX_AMBER }));
    asArr(analysis.whatsBrittle).forEach((x) => children.push(docxBullet(x)));
  }

  // AI Employees
  if (asArr(analysis.aiEmployees).length) {
    children.push(docxDivider());
    children.push(docxHeading("Your first suggested AI Employees", 2));
    children.push(docxParagraph(
      "Each one is a build we'd ship for you. Names you can remember, roles you can point at, things you can stop doing.",
      { italics: true, color: DOCX_MUTED, after: 200 }
    ));
    asArr(analysis.aiEmployees).forEach((e) => {
      const rank = String(e.rank || "").padStart(2, "0");
      const firstName = e.firstName || e.name || "AI Employee";
      const role = e.role || "";
      // Rank tag + Name + Role on its own paragraph
      children.push(new Paragraph({
        children: [docxText(`AI EMPLOYEE #${rank}` + (e.priority ? `  ·  ${e.priority.toUpperCase()}` : ""),
          { bold: true, size: 16, color: DOCX_BLUE })],
        spacing: { before: 240, after: 60 },
      }));
      children.push(new Paragraph({
        children: [
          docxText(firstName, { bold: true, size: 32, color: DOCX_INK, font: "Georgia" }),
          ...(role ? [docxText("   " + role, { size: 22, color: DOCX_MUTED })] : []),
        ],
        spacing: { before: 0, after: 80 },
      }));
      if (e.tagline) {
        children.push(new Paragraph({
          children: [docxText(`"${e.tagline}"`, { italics: true, size: 22, color: DOCX_MUTED })],
          spacing: { before: 0, after: 120 },
        }));
      }
      if (e.whatTheyDo) children.push(docxKV("What they do", e.whatTheyDo));
      if (e.whatYouSkip) children.push(docxKV("What you skip", e.whatYouSkip));
      if (e.timeSavings) children.push(docxKV("Time savings", e.timeSavings));
      if (e.estimatedDollarValue) children.push(docxKV("Est. value", e.estimatedDollarValue));
      if (e.buildEffort) children.push(docxKV("Build effort", e.buildEffort));
      if (e.complexity) children.push(docxKV("Complexity", e.complexity));
      if (asArr(e.tools).length) children.push(docxKV("Tools", asArr(e.tools).join(", ")));
      if (asArr(e.appliesToSteps).length) children.push(docxKV("Covers steps", asArr(e.appliesToSteps).join(", ")));
      if (e.humanInLoop) children.push(docxKV("You still own", e.humanInLoop));
    });
  }

  // Where we'd start
  if (asArr(analysis.whereWedStart).length) {
    children.push(docxDivider());
    children.push(docxHeading("Where we'd start", 2));
    children.push(docxParagraph(
      "Our recommended build order. We ship one, prove it, then roll into the next.",
      { italics: true, color: DOCX_MUTED, after: 160 }
    ));
    asArr(analysis.whereWedStart).forEach((w, i) => {
      children.push(new Paragraph({
        children: [
          docxText(`Build ${i + 1}.  `, { bold: true, size: 22, color: DOCX_BLUE, font: "Georgia" }),
          docxText(w.name || "", { bold: true, size: 22, color: DOCX_INK }),
          ...(w.timeline ? [docxText("    " + w.timeline, { size: 18, color: DOCX_MUTED })] : []),
        ],
        spacing: { before: 160, after: 60 },
      }));
      if (w.pitch) children.push(docxParagraph(w.pitch, { after: 80 }));
    });
  }

  // Closing
  if (analysis.closingNote) {
    children.push(docxSpacer(200));
    children.push(docxCallout(analysis.closingNote, { color: DOCX_GREEN, fill: "EEF7EE" }));
  }

  // Footer note
  children.push(docxSpacer(400));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [docxText("Practical AI Co.  ·  Franklin, TN  ·  joe@thepracticalai.co",
      { size: 16, color: DOCX_MUTED })],
    spacing: { before: 200, after: 0 },
  }));

  const doc = new Document({
    creator: "Practical AI Co.",
    title: sop.processName || "Process",
    description: "Standard Operating Procedure generated by Practical AI Co.",
    numbering: {
      config: [{
        reference: "default-numbering",
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 360, hanging: 360 } } } },
        ],
      }],
    },
    sections: [{
      properties: {
        page: {
          margin: { top: convertInchesToTwip(0.9), bottom: convertInchesToTwip(0.9),
            left: convertInchesToTwip(0.9), right: convertInchesToTwip(0.9) },
        },
      },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

function sopDocxFilename(processName, businessName) {
  const slug = (s) => (s || "").toString().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const parts = [slug(businessName), slug(processName), "SOP"].filter(Boolean);
  return parts.join("_") + ".docx";
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
  // Optional ICP (Ideal Customer Profile). Free-form text the client pasted
  // in at intake. Used to sharpen the analysis if present. Capped to keep
  // prompt size sane.
  const icp = (body.icp || "").toString().slice(0, 6000).trim();

  if (!firstName || !businessName || !email || !sop) {
    return res.status(400).json({ error: "Missing firstName, businessName, email, or sop" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const notionKey = process.env.NOTION_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  if (!notionKey) return res.status(500).json({ error: "NOTION_API_KEY not set" });
  if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY not set" });

  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // 1. Analysis pass (graceful fallback if it fails)
  let analysis;
  let analysisError = null;
  try {
    analysis = await runAnalysisPass(anthropic, sop, icp);
  } catch (err) {
    console.error("Analysis pass failed:", err);
    analysisError = err && err.message;
    analysis = buildFallbackAnalysis(sop);
  }

  // 2. Generate the .docx artifact (fail soft — never block delivery)
  let docxBuffer = null;
  let docxError = null;
  const docxFilename = sopDocxFilename(sop.processName, businessName);
  try {
    docxBuffer = await generateSopDocx({ sop, analysis, businessName, firstName });
  } catch (err) {
    console.error("docx generation failed:", err);
    docxError = err && err.message;
  }

  // 3. Fire deliverables in parallel
  const notion = new NotionClient({ auth: notionKey });
  const resend = new Resend(resendKey);

  const notionPromise = createSopPage(
    notion,
    buildNotionProperties({ firstName, businessName, email, sop }),
    buildNotionBlocks({ sop, analysis })
  );

  const clientHtml = renderEmailHtml({ sop, analysis, isJoe: false, businessName, firstName });
  const joeHtml = renderEmailHtml({ sop, analysis, isJoe: true, businessName, firstName });
  const textBody = renderPlainText({ sop, analysis });
  const processLabel = sop.processName || "process";

  // Resend attachment — base64 content + filename
  const attachments = docxBuffer
    ? [{
        filename: docxFilename,
        content: docxBuffer.toString("base64"),
      }]
    : undefined;

  const clientEmailPromise = resend.emails.send({
    from: FROM,
    to: email,
    reply_to: JOE_EMAIL,
    subject: `Your SOP: ${processLabel} — ${businessName}`,
    html: clientHtml,
    text: textBody,
    attachments,
  });

  const joeEmailPromise = resend.emails.send({
    from: FROM,
    to: JOE_EMAIL,
    reply_to: email,
    subject: `New SOP captured: ${processLabel} — ${businessName}`,
    html: joeHtml,
    text: textBody,
    attachments,
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
    firstName, businessName, email,
    processName: sop.processName,
    analysisError, docxError,
    notion: summarize(notionResult), notionErr: reasonOf(notionResult),
    clientEmail: summarize(clientEmailResult), clientEmailErr: reasonOf(clientEmailResult),
    joeEmail: summarize(joeEmailResult), joeEmailErr: reasonOf(joeEmailResult),
  });

  return res.status(200).json({
    notion: summarize(notionResult),
    clientEmail: summarize(clientEmailResult),
    joeEmail: summarize(joeEmailResult),
    errors: {
      notion: reasonOf(notionResult),
      clientEmail: reasonOf(clientEmailResult),
      joeEmail: reasonOf(joeEmailResult),
      analysis: analysisError,
      docx: docxError,
    },
    analysis,
    docx: docxBuffer
      ? { filename: docxFilename, base64: docxBuffer.toString("base64") }
      : null,
  });
};
