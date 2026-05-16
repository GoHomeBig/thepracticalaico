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

const SOP_LIBRARY_DB_ID = "362567cd-8712-8174-982d-ffa3a95e441c";
const JOE_EMAIL = "joe@thepracticalai.co";
const FROM = "Practical AI Co. <joe@thepracticalai.co>";
const ANALYSIS_MODEL = "claude-sonnet-4-20250514";
const ANALYSIS_MAX_TOKENS = 8192;

// ============================================================
// Analysis pass — turns raw SOP into customer-ready deliverable
// ============================================================
const ANALYSIS_SYSTEM_PROMPT = `You are a senior consultant at Practical AI Co., a small business AI consultancy in Franklin, TN. We help small business owners turn the knowledge in their heads into systems that run without them.

A small business owner just completed a structured interview where they walked us through ONE of their processes in detail. Your job: turn that raw data into a polished, customer-ready document that demonstrates DEEP understanding of their business and identifies the highest-value automation opportunities.

This document is the artifact of the conversation. It's what the client sees. It needs to feel like a $5,000 strategy deliverable: insightful, specific, actionable, beautifully written. Not generic. Not surface-level. Not consultant-speak.

Think hard. Read carefully. Consider:
- What's clever or counterintuitive about how this team runs this process?
- Where is the owner spending mental cycles they don't realize?
- Which steps are mechanical (ripe for automation) versus judgment-based (keep human)?
- What's brittle? What only happens because someone is paying attention?
- Which automation has the highest ROI for THIS specific business — not the obvious one?
- What can we say about this process that shows we actually understood it?

The client will be impressed by SPECIFICITY. Reference details from the interview. Quote them when it strengthens the point. Avoid generic statements that could apply to any business.

Output a single JSON block wrapped in <ANALYSIS></ANALYSIS> tags. Use this exact structure (all string fields must be present):

<ANALYSIS>
{
  "executiveSummary": "2-3 sharp sentences capturing the essence of this process AND Practical AI Co.'s POV on it. The owner should read this and feel understood.",
  "openingNote": "1 paragraph (3-5 sentences). Warm opener that acknowledges what we heard and frames what this document contains. Builds trust.",
  "maturity": {
    "overall": 6,
    "documentation": 7,
    "automationReadiness": 6,
    "resilience": 4,
    "explanation": "1 sentence tying the scores to specific things you observed in the interview."
  },
  "currentStateNarrative": "1 flowing paragraph (4-6 sentences) describing how this process runs today. Storytelling, not bullets. Show you listened.",
  "stepsAnnotated": [
    {
      "n": 1,
      "action": "the step, cleaned up if needed",
      "tool": "tool or system",
      "owner": "who does it",
      "output": "what this step produces, or empty string",
      "observation": "Optional 1-line strategic note specific to this step. Only include if there's something insightful to say. Most steps will have empty string here."
    }
  ],
  "whatsWorking": [
    "1-line SPECIFIC observation about something this team does well. Reference a detail.",
    "another (2-4 total)"
  ],
  "whatsBrittle": [
    "1-line SPECIFIC observation about a fragile point. Reference a detail.",
    "another (2-4 total)"
  ],
  "automationOpportunities": [
    {
      "rank": 1,
      "name": "Punchy 3-5 word name",
      "priority": "Quick win | Strategic | Long-term",
      "whatItDoes": "1-2 sentences. What gets automated, in concrete terms.",
      "whyItMatters": "1-2 sentences. Why THIS business benefits specifically. Reference the interview.",
      "timeSavings": "Rough estimate like '2-3 hours/week' or 'reclaims your Monday morning' or 'roughly 1 hour per customer'",
      "estimatedDollarValue": "Annual dollar impact of the savings or upside. GROUND in what the owner told you (headcount, hourly rates, deal sizes, customer counts) when possible. If you do not have grounding for a specific number, give a wide range and label it rough, like 'roughly $8K-$15K/year (rough estimate)'. NEVER fabricate specific numbers.",
      "complexity": "Low | Medium | High",
      "buildEffort": "Realistic build estimate, like '1 week', '2-3 weeks', '1-2 months', or '2-3 months'. Multi-system integrations take longer than they look.",
      "tools": ["tool name", "tool name"],
      "humanInLoop": "What the owner still owns: judgment calls, approvals, edge cases that should NOT be automated"
    }
  ],
  "suggestedNextMoves": [
    "A concrete, specific action the owner could take THIS WEEK (not 'consider' or 'evaluate' — a real action)",
    "Second action",
    "Third action (3 total max)"
  ],
  "closingNote": "1 paragraph (2-3 sentences). Motivate without being salesy. Reaffirm POV. Confident."
}
</ANALYSIS>

Scoring guidance for maturity (1-10, where 10 is excellent, 1 is chaos):
- documentation: How well is the process captured outside the owner's head? 10 = full SOP exists and is current. 1 = only one person knows.
- automationReadiness: How mechanical vs. judgment-heavy is this process? 10 = mostly automatable rules. 1 = requires constant human judgment.
- resilience: How well does the process survive if the owner is unavailable? 10 = runs without the owner for a week. 1 = halts in hours.
- overall: Holistic read on the process maturity. Don't just average the three.

Priority guidance for opportunities:
- Quick win: under 2 weeks of build effort, fast obvious ROI, low risk.
- Strategic: 2-8 weeks of build, important leverage, may need owner buy-in.
- Long-term: 8+ weeks or foundational work that unlocks future automation.

Rules:
- 3 to 5 automation opportunities. Ranked by leverage. NOT 10. Be selective.
- Each opportunity must reference specific details from this process.
- Avoid consulting jargon. Be sharp, direct, specific.
- Tone: smart operator, warm, confident.
- Every sentence earns its place. Cut what doesn't.
- Output ONLY the JSON in tags. No other text.`;

async function runAnalysisPass(anthropic, sop) {
  const userMessage =
    "Here is the structured SOP we just captured in an interview with this business owner.\n\n" +
    "```json\n" +
    JSON.stringify(sop, null, 2) +
    "\n```\n\n" +
    "Produce the polished analysis document per the format in your system prompt. Think carefully — this is going to the client.";

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

  // Workflow (annotated steps)
  const annotatedSteps = asArr(analysis.stepsAnnotated).length
    ? asArr(analysis.stepsAnnotated)
    : asArr(sop.steps);
  if (annotatedSteps.length) {
    blocks.push(heading2("Workflow"));
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

  // Automation opportunities (the headline deliverable)
  if (asArr(analysis.automationOpportunities).length) {
    blocks.push(divider());
    blocks.push(heading2("Automation opportunities"));
    blocks.push(paragraph(
      "Ranked by leverage for this business. Each one references specifics we heard in the interview.",
      "gray"
    ));
    asArr(analysis.automationOpportunities).forEach((opp) => {
      const rank = String(opp.rank || "").padStart(2, "0");
      const priority = opp.priority ? `  ·  ${opp.priority}` : "";
      blocks.push(heading3(`${rank} · ${opp.name || "Opportunity"}${priority}`));
      if (opp.whatItDoes) blocks.push(paragraph(opp.whatItDoes));
      const metaFacts = [];
      if (opp.timeSavings) metaFacts.push("Time savings: " + opp.timeSavings);
      if (opp.estimatedDollarValue) metaFacts.push("Est. value: " + opp.estimatedDollarValue);
      if (opp.buildEffort) metaFacts.push("Build effort: " + opp.buildEffort);
      if (opp.complexity) metaFacts.push("Complexity: " + opp.complexity);
      if (asArr(opp.tools).length) metaFacts.push("Tools: " + asArr(opp.tools).join(", "));
      if (metaFacts.length) blocks.push(paragraph(metaFacts.join("  ·  "), "gray"));
      if (opp.whyItMatters) blocks.push(paragraph("Why it matters: " + opp.whyItMatters));
      if (opp.humanInLoop) blocks.push(paragraph("Human in loop: " + opp.humanInLoop));
    });
  }

  // Suggested next moves
  if (asArr(analysis.suggestedNextMoves).length) {
    blocks.push(divider());
    blocks.push(heading2("Suggested next moves"));
    asArr(analysis.suggestedNextMoves).forEach((m) => blocks.push(numbered(m)));
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
      return `<div style="padding:16px 18px;background:#FFFDF8;border:1px solid #E7DCCB;border-radius:12px;margin:12px 0;">
        <div style="display:flex;gap:14px;align-items:baseline;">
          <div style="font-family:Georgia,serif;font-weight:800;color:#2456FF;font-size:18px;min-width:24px;">${n}.</div>
          <div style="font-size:15px;font-weight:700;color:#172033;line-height:1.4;">${esc(s.action || "")}</div>
        </div>
        ${metaLine}${obs}${branches}
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

  const opportunitiesHtml = (() => {
    const opps = asArr(analysis.automationOpportunities);
    if (!opps.length) return "";
    return opps.map((o) => {
      const rank = String(o.rank || "").padStart(2, "0");
      const facts = [];
      if (o.timeSavings) facts.push(["Time savings", o.timeSavings]);
      if (o.estimatedDollarValue) facts.push(["Est. value", o.estimatedDollarValue]);
      if (o.buildEffort) facts.push(["Build effort", o.buildEffort]);
      if (o.complexity) facts.push(["Complexity", o.complexity]);
      if (asArr(o.tools).length) facts.push(["Tools", asArr(o.tools).join(", ")]);
      const factsHtml = facts.length
        ? `<div style="margin-top:8px;font-size:13px;color:#667085;line-height:1.7;">${facts.map(([l, v]) => `<b>${esc(l)}:</b> ${esc(v)}`).join("&nbsp; &middot; &nbsp;")}</div>`
        : "";
      return `<div style="padding:20px 22px;background:#FFFDF8;border:1px solid #E7DCCB;border-radius:14px;margin:14px 0;">
        <div style="font-size:11px;font-weight:900;color:#2456FF;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:8px;">Opportunity ${rank}${priorityPillEmail(o.priority)}</div>
        <div style="font-family:Georgia,serif;font-size:20px;font-weight:800;color:#172033;letter-spacing:-0.022em;margin-bottom:10px;">${esc(o.name || "")}</div>
        ${o.whatItDoes ? P(o.whatItDoes) : ""}
        ${factsHtml}
        ${o.whyItMatters ? `<div style="margin-top:10px;font-size:14.5px;line-height:1.55;"><b>Why it matters:</b> ${esc(o.whyItMatters)}</div>` : ""}
        ${o.humanInLoop ? `<div style="margin-top:6px;font-size:14px;color:#667085;line-height:1.55;"><b>Human in loop:</b> ${esc(o.humanInLoop)}</div>` : ""}
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

    ${H2("Workflow")}
    ${stepsHtml}

    ${asArr(sop.decisions).length ? H2("Decision points") + UL(asArr(sop.decisions).map((d) => `If ${d.if || ""} → ${d.then || ""}`)) : ""}
    ${asArr(sop.failureModes).length ? H2("Failure modes & recovery") + UL(asArr(sop.failureModes).map((f) => `${f.issue || ""} → ${f.recovery || ""}`)) : ""}
    ${sop.definitionOfDone ? H2("Definition of done") + P(sop.definitionOfDone) : ""}

    ${(asArr(analysis.whatsWorking).length || asArr(analysis.whatsBrittle).length) ? H2("Strategic observations") : ""}
    ${asArr(analysis.whatsWorking).length ? H3("What's working") + UL(asArr(analysis.whatsWorking)) : ""}
    ${asArr(analysis.whatsBrittle).length ? H3("What's brittle") + UL(asArr(analysis.whatsBrittle)) : ""}

    ${asArr(analysis.automationOpportunities).length ? H2("Automation opportunities") + P("Ranked by leverage for this business. Each one references specifics we heard in the interview.", { muted: true }) + opportunitiesHtml : ""}

    ${asArr(analysis.suggestedNextMoves).length ? H2("Suggested next moves") + `<ol style="margin:10px 0 14px;padding-left:22px;color:#172033;">${asArr(analysis.suggestedNextMoves).map((m) => `<li style="margin:8px 0;line-height:1.55;">${esc(m)}</li>`).join("")}</ol>` : ""}

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
  lines.push("WORKFLOW");
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
  });
  lines.push("");
  if (asArr(analysis.automationOpportunities).length) {
    lines.push("AUTOMATION OPPORTUNITIES");
    asArr(analysis.automationOpportunities).forEach((o) => {
      const rank = String(o.rank || "").padStart(2, "0");
      lines.push("  " + rank + ". " + (o.name || ""));
      if (o.whatItDoes) lines.push("       " + o.whatItDoes);
      if (o.timeSavings) lines.push("       Time savings: " + o.timeSavings);
    });
    lines.push("");
  }
  if (asArr(analysis.suggestedNextMoves).length) {
    lines.push("NEXT MOVES");
    asArr(analysis.suggestedNextMoves).forEach((m, i) => lines.push("  " + (i + 1) + ". " + m));
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
    automationOpportunities: [],
    suggestedNextMoves: [],
    closingNote:
      "Strategic analysis pass didn't run cleanly this session. Joe will review the captured SOP and follow up with observations and automation opportunities directly.",
  };
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
    analysis = await runAnalysisPass(anthropic, sop);
  } catch (err) {
    console.error("Analysis pass failed:", err);
    analysisError = err && err.message;
    analysis = buildFallbackAnalysis(sop);
  }

  // 2. Build deliverables in parallel
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
    firstName, businessName, email,
    processName: sop.processName,
    analysisError,
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
    },
    analysis,
  });
};
