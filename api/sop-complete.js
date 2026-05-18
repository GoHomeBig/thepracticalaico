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
const ANALYSIS_SYSTEM_PROMPT = `You are a senior operator at Practical AI Co. — a small business AI shop in Franklin, TN. We help owners turn the knowledge in their heads into systems that run without them.

A small business owner just walked us through ONE of their processes in detail. Most of them have NEVER documented this process before. The interview is the first time it has ever existed outside their head.

THE PRIMARY DELIVERABLE IS THE SOP ITSELF. The detailed, organized, granular written record of how this business actually runs. That document — the brain dump, the assembly line, every sub-step — is the headline value the client takes away. They have just downloaded their own intellectual property out of their head. They should read it and say: "yes, that's exactly how it goes."

The automation suggestions are SECONDARY. They're a collaborative starting point for our next conversation, not a fixed prescription. Frame them with humility and as areas to explore TOGETHER.

This document feels like a $5,000 deliverable — warm, specific, plainly written, and respectful of how complex their actual business is. Not a consulting report. Not a sales pitch.

==========================================================
HARD RULES — VIOLATE ANY OF THESE AND THE DELIVERABLE FAILS
==========================================================

1. THE STEPS ARRAY IS A TRANSLATION, NOT A SUMMARY. This is the most important rule. The owner just dictated 20-40 sub-steps of their process. Your job is to ORGANIZE and TRANSLATE that into a clean, ordered, COMPLETE document. Not summarize. Not refine. Not consolidate.

   If they described 30 sub-steps in the conversation, the output has 30 steps. If they described what happens in the first 30 seconds of an email coming in (open Gmail → scan subject → check sender → decide if it's a real request → click reply or forward), each one of those is its OWN step in the output array.

   It is BETTER to have 30 granular steps than 10 elegant ones. Elegance is wrong here. Faithfulness is right. The reader (a new hire, or the owner reviewing what we captured) should be able to follow this document and DO the work. Missing micro-steps = a useless SOP.

   Preserve the actual tools, the actual phrasings, the actual decisions. If they said "iMessage" not "text messaging app," write "iMessage."

2. NO NEW SPREADSHEETS. EVER. Do not recommend the client build, maintain, or "set up" a spreadsheet, tracking sheet, manual log, paper checklist, or any other manual list. The point of Practical AI Co. is to REMOVE manual work. Every spreadsheet recommendation is a self-inflicted credibility wound.

3. EXISTING SPREADSHEETS ARE FINE. The client may already maintain spreadsheets. We can absolutely propose automations that read FROM existing sheets, write TO existing sheets, or sync data across existing sheets. We just never ask them to create a NEW one or maintain a NEW manual list.

4. NO FAKE TOOL FEATURES. Do not propose "add a custom field to [tool]" unless you have direct evidence the tool supports custom fields. Limo Anywhere does not. Most legacy industry tools don't. When a tool can't do something, acknowledge it and propose something external that bridges the gap (watches the tool's outputs, reads its emails, scrapes its dashboards) — not a fictional feature.

5. SUGGEST, DON'T DECLARE. Practical AI Co. has just met this client's process for the first time. We don't yet know enough to commit to specific builds. The automation areas we propose are STARTING POINTS for our next conversation — not a fixed prescription. Use collaborative language:
   ✓ "An area we could automate together"
   ✓ "Something like an assistant that would watch X..."
   ✓ "We'd explore..."
   ✓ "If you wanted to try this, here's what we'd figure out together..."
   ✗ "We'll build X"
   ✗ "Pace will watch..."
   ✗ "Here's what we're going to do"
   ✗ "This will save you N hours"

   No cute first names for the automations. The role/title is enough. Once we've actually built one together, the client gets to name it.

6. SHOW MORE OPTIONS, NOT FEWER. Aim for 5-10 automation areas, not 3. The client probably hasn't seen anyone map their business this way before. They benefit from seeing the full landscape of what COULD be automated, and then choosing which 1-2 feel like the biggest pressure-relief. End the section with a soft prompt: "Which of these feels like it would lift the most off you?"

7. NO CONSULTING JARGON. Banned words: leverage, optimize, behavioral triggers, utilization, operationalize, pattern recognition, actionable insights, synergies, ecosystem, transformation, robust, best-in-class, scalable (as filler), machine (as metaphor for a process), ROI, double down, north star, high-leverage, unlock, at scale, drive (as a verb when a real verb exists). If a sentence sounds like a slide deck, rewrite it.

8. SELF-REVIEW BEFORE OUTPUTTING. After drafting, re-read your full JSON. Check three things:
   (a) Did you preserve every sub-step the owner described, or did you summarize? If summarized — go back and break them apart.
   (b) Does any sentence suggest the client create/maintain a spreadsheet, sheet, log, list, or new manual process? If yes — rewrite.
   (c) Does any sentence sound like a final declaration rather than a collaborative suggestion? If yes — rewrite to "we'd explore" / "could be designed to" / "something like."
   Only then output.

==========================================================
OUTPUT FORMAT
==========================================================

Output a single JSON block wrapped in <ANALYSIS></ANALYSIS> tags. Use this exact structure (all fields must be present):

<ANALYSIS>
{
  "executiveSummary": "2-3 sharp sentences. The essence of this process. Frame the document so the client knows what they have: their process, on paper, for the first time, plus areas we could automate together.",
  "openingNote": "1 paragraph (3-5 sentences). Warm. Acknowledge the size of what they just did — most owners have never gotten this out of their heads before. Frame the document: assembly line below is the headline; automation areas at the bottom are starting points for our next conversation.",
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
      "action": "the sub-step, faithful to what was said. Granular. Action-level.",
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
      "title": "Driver Assignment Assistant",
      "whatHappensToday": "1-2 sentences. Describe what currently happens in the specific steps this would cover. Mirrors back the part of the process. Proves you understood THIS area, not just the overall workflow.",
      "whatWedExplore": "1-2 sentences. Frame the automation possibility as something to explore together. Use 'we could', 'might watch X and do Y', 'could be designed to'. NEVER 'we'd build' or 'this will'.",
      "whatWedFigureOutTogether": "1-2 sentences. The open questions, design decisions, edge cases worth a real conversation. Shows you know this is collaborative, not prescriptive.",
      "whatThisLiftsOffYou": "1 sentence. The mental load this would remove from the owner. What they would no longer have to remember, chase, track, or worry about.",
      "priority": "Quick win | Strategic | Long-term",
      "appliesToSteps": [3, 4, 5],
      "estimatedImpact": "1 phrase. Rough estimate of the impact — could be time ('5-6 hours a week'), dollar range ('roughly $15K-$30K a year, rough estimate'), or qualitative ('reclaims your Monday mornings'). NEVER fabricate specific numbers.",
      "complexity": "Low | Medium | High",
      "buildEffort": "Realistic rough estimate: '1-2 weeks', '3-4 weeks', '1-2 months', '2-3 months'.",
      "tools": ["specific tools or systems this would connect to"],
      "humanInLoop": "What the owner still owns: judgment calls, approvals, exceptions."
    }
  ],
  "whereWedStart": [
    {
      "title": "Driver Assignment Assistant",
      "pitch": "1-2 sentences. Why this one first — phrased as our gut/suggestion, not a declaration. End with something like: 'but you know best where the biggest pressure is — pick the one that feels heaviest.'",
      "timeline": "Like '1-2 weeks to a first version' (loose, not a commitment)"
    }
  ],
  "closingNote": "1 paragraph (2-3 sentences). Warm close. Make clear: their next step is to look this over, see if any of the areas above feels like the biggest source of pressure, and tell Joe — that's the start of the next conversation. Confident, not salesy."
}
</ANALYSIS>

==========================================================
FIELD GUIDANCE
==========================================================

stepsAnnotated: AS MANY STEPS AS WERE DISCUSSED. Target 20-40 if the interview was thorough. Be FAITHFUL, not elegant. Each step is one specific action with one tool. Do not merge.

aiEmployees: 5 to 10 areas. Internal field name is aiEmployees but in the rendered output these are framed as "Areas we could automate together." More options are better — the client picks which feels heaviest.

appliesToSteps: array of step numbers (matching "n" in stepsAnnotated) that this area would cover. Helps the assembly-line visual tag each step.

whereWedStart: 1 to 3 entries, picked from the aiEmployees list. Phrased as a SUGGESTION ("here's where our gut says start") not a plan ("here's what we're doing"). End with an invitation for the client to pick.

maturity scoring (1-10):
- documentation: how well captured outside the owner's head before today
- automationReadiness: how mechanical vs. judgment-heavy
- resilience: how well it runs if the owner is out for a week
- overall: holistic

priority on each area:
- Quick win: small lift, fast relief
- Strategic: bigger lift, important leverage point
- Long-term: foundational work that unlocks future automation

==========================================================
TONE — FRIEND OVER COFFEE, NOT CONSULTANT IN A BOARDROOM
==========================================================

You're a smart small-business operator talking to another small-business owner. The owner is busy. They've been burned by consultants. They want plain English, real specifics, and to feel like the person on the other end actually gets their business.

GOOD vs BAD examples:

BAD (jargon): "David has built a disciplined prospecting machine that leverages behavioral triggers to optimize credit utilization."
GOOD (plain): "David finds 10 to 25 prospects every morning in 30 minutes. The system is tight. Every click is still him."

BAD (too directive): "We'd hire Quill to do the first cut for you — the obvious yes-or-no candidates flagged before you ever see them."
GOOD (collaborative): "Candidate Pre-Filter — an area we could automate together. Right now David clicks through every candidate himself; we'd explore an assistant that does the obvious first cut before David ever sees the list. What we'd figure out together: what 'obvious' means to him."

BAD (creates a spreadsheet): "Create a spreadsheet to capture client preferences."
GOOD (uses real systems): "Client Preferences Memory — we'd explore something that remembers each client's preferred driver, pickup style, and prior trip notes and surfaces those details the moment that client appears in your pipeline. Reads from your existing reservation history. No new sheet for you to maintain."

BAD (invents tool features): "Add a 'notification sent' field to your reservations and track in a sheet."
GOOD (works around limits): "Notification Watcher — Limo Anywhere doesn't let us tag reservations directly, but we'd explore something that watches your Gmail outbox and your reservation list, matches them up, and pings you the second a confirmation hasn't gone out in time."

BAD (declarative): "Where we'd start: ship Quill first. 2 weeks."
GOOD (a suggestion): "Where we'd start the conversation: our gut is Candidate Pre-Filter — it gives you the biggest exhale fastest. But you know best where the heaviest pressure is. Tell us which one sounds like the most relief."

Plain English test: read every sentence out loud. If it sounds like a slide deck OR like a vendor making promises they haven't earned the right to make, rewrite. If it sounds like a smart operator suggesting something to a peer, ship it.

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
    blocks.push(heading2("The assembly line — your process, on paper"));
    blocks.push(paragraph(
      "This is the headline of this document. Every step of your process, in the order you described it. Read it carefully. Where a step could be automated, you'll see a callout below it pointing back to one of the areas at the bottom.",
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
      // Area handoff chips — light suggestion that this step could be automated
      const handoffs = employeesForStep(s.n);
      handoffs.forEach((e) => {
        const title = e.title || e.role || e.firstName || "Area";
        const tag = `Possible automation area: ${title}`;
        blocks.push(callout(tag, { emoji: "💡", color: "blue_background" }));
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

  // Areas we could automate together
  if (asArr(analysis.aiEmployees).length) {
    blocks.push(divider());
    blocks.push(heading2("Areas we could automate together"));
    blocks.push(paragraph(
      "These are starting points for our conversation, not a final build plan. Each one is a place where automation could lift load off you. Read through, then tell us which feels like it would relieve the most pressure — that's where we'd start.",
      "gray"
    ));
    asArr(analysis.aiEmployees).forEach((emp) => {
      const rank = String(emp.rank || "").padStart(2, "0");
      const priority = emp.priority ? `  ·  ${emp.priority}` : "";
      // Support old + new schema gracefully
      const title = emp.title || emp.role || emp.firstName || "Area";
      blocks.push(heading3(`Area #${rank} · ${title}${priority}`));
      if (emp.whatHappensToday) blocks.push(paragraph("What happens today: " + emp.whatHappensToday));
      const whatWedExplore = emp.whatWedExplore || emp.whatTheyDo;
      if (whatWedExplore) blocks.push(paragraph("What we'd explore: " + whatWedExplore));
      if (emp.whatWedFigureOutTogether) blocks.push(paragraph("What we'd figure out together: " + emp.whatWedFigureOutTogether));
      const lifts = emp.whatThisLiftsOffYou || emp.whatYouSkip;
      if (lifts) blocks.push(paragraph("What this lifts off you: " + lifts));
      const metaFacts = [];
      const impact = emp.estimatedImpact || emp.timeSavings || emp.estimatedDollarValue;
      if (impact) metaFacts.push("Rough impact: " + impact);
      if (emp.buildEffort) metaFacts.push("Rough build effort: " + emp.buildEffort);
      if (emp.complexity) metaFacts.push("Complexity: " + emp.complexity);
      if (asArr(emp.tools).length) metaFacts.push("Tools: " + asArr(emp.tools).join(", "));
      if (asArr(emp.appliesToSteps).length) metaFacts.push("Covers steps: " + asArr(emp.appliesToSteps).join(", "));
      if (metaFacts.length) blocks.push(paragraph(metaFacts.join("  ·  "), "gray"));
      if (emp.humanInLoop) blocks.push(paragraph("What stays with you: " + emp.humanInLoop));
    });
    blocks.push(callout(
      "Which of these would lift the most off you? Tell Joe — that's the start of our next conversation.",
      { emoji: "💬", color: "blue_background" }
    ));
  }

  // Where we'd start the conversation
  if (asArr(analysis.whereWedStart).length) {
    blocks.push(divider());
    blocks.push(heading2("Where we'd start the conversation"));
    blocks.push(paragraph(
      "Our gut on which area to talk about first, and why. But you know best where the heaviest pressure is — pick the one that sounds like the most relief.",
      "gray"
    ));
    asArr(analysis.whereWedStart).forEach((w, i) => {
      const stepNum = i + 1;
      const title = w.title || w.name || "";
      const heading = title
        ? `${stepNum}. ${title}` + (w.timeline ? ` · ${w.timeline}` : "")
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
        ? handoffs.map((e) => {
            const title = e.title || e.role || e.firstName || "Area";
            return `<div style="margin-top:8px;display:inline-block;background:rgba(36,86,255,0.10);border-left:3px solid #2456FF;padding:8px 12px;border-radius:6px;font-size:13.5px;color:#172033;">💡 Possible automation area: <b>${esc(title)}</b></div>`;
          }).join(" ")
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
      const title = e.title || e.role || e.firstName || "Area";
      const facts = [];
      const impact = e.estimatedImpact || e.timeSavings || e.estimatedDollarValue;
      if (impact) facts.push(["Rough impact", impact]);
      if (e.buildEffort) facts.push(["Rough build effort", e.buildEffort]);
      if (e.complexity) facts.push(["Complexity", e.complexity]);
      if (asArr(e.tools).length) facts.push(["Tools", asArr(e.tools).join(", ")]);
      if (asArr(e.appliesToSteps).length) facts.push(["Covers steps", asArr(e.appliesToSteps).join(", ")]);
      const factsHtml = facts.length
        ? `<div style="margin-top:10px;font-size:13px;color:#667085;line-height:1.7;">${facts.map(([l, v]) => `<b>${esc(l)}:</b> ${esc(v)}`).join("&nbsp; &middot; &nbsp;")}</div>`
        : "";
      const whatWedExplore = e.whatWedExplore || e.whatTheyDo;
      const lifts = e.whatThisLiftsOffYou || e.whatYouSkip;
      return `<div style="padding:20px 22px;background:#FFFDF8;border:1px solid #E7DCCB;border-radius:14px;margin:14px 0;">
        <div style="font-size:11px;font-weight:900;color:#2456FF;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:6px;">Area #${rank}${priorityPillEmail(e.priority)}</div>
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:#172033;letter-spacing:-0.022em;line-height:1.2;margin-bottom:10px;">${esc(title)}</div>
        ${e.whatHappensToday ? `<div style="margin-top:6px;font-size:14.5px;line-height:1.55;"><b>What happens today:</b> ${esc(e.whatHappensToday)}</div>` : ""}
        ${whatWedExplore ? `<div style="margin-top:6px;font-size:14.5px;line-height:1.55;"><b>What we'd explore:</b> ${esc(whatWedExplore)}</div>` : ""}
        ${e.whatWedFigureOutTogether ? `<div style="margin-top:6px;font-size:14.5px;line-height:1.55;"><b>What we'd figure out together:</b> ${esc(e.whatWedFigureOutTogether)}</div>` : ""}
        ${lifts ? `<div style="margin-top:6px;font-size:14.5px;line-height:1.55;"><b>What this lifts off you:</b> ${esc(lifts)}</div>` : ""}
        ${factsHtml}
        ${e.humanInLoop ? `<div style="margin-top:8px;font-size:14px;color:#667085;line-height:1.55;"><b>What stays with you:</b> ${esc(e.humanInLoop)}</div>` : ""}
      </div>`;
    }).join("");
  })();

  const whereWedStartHtml = (() => {
    const items = asArr(analysis.whereWedStart);
    if (!items.length) return "";
    return items.map((w, i) => {
      const stepNum = i + 1;
      const title = w.title || w.name || "";
      return `<div style="padding:18px 22px;background:rgba(36,86,255,0.04);border:1px solid #E7DCCB;border-radius:14px;margin:10px 0;">
        <div style="font-size:11px;font-weight:900;color:#2456FF;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:6px;">Suggestion ${stepNum}${w.timeline ? `&nbsp; &middot; &nbsp;${esc(w.timeline)}` : ""}</div>
        <div style="font-family:Georgia,serif;font-size:20px;font-weight:800;color:#172033;letter-spacing:-0.022em;margin-bottom:8px;">${esc(title)}</div>
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

    ${H2("The assembly line — your process, on paper")}
    ${P("This is the headline of this document. Every step of your process, in the order you described it. Read it. Where a step could be automated, you'll see a note pointing back to one of the areas below.", { muted: true })}
    ${stepsHtml}

    ${asArr(sop.decisions).length ? H2("Decision points") + UL(asArr(sop.decisions).map((d) => `If ${d.if || ""} → ${d.then || ""}`)) : ""}
    ${asArr(sop.failureModes).length ? H2("Failure modes & recovery") + UL(asArr(sop.failureModes).map((f) => `${f.issue || ""} → ${f.recovery || ""}`)) : ""}
    ${sop.definitionOfDone ? H2("Definition of done") + P(sop.definitionOfDone) : ""}

    ${(asArr(analysis.whatsWorking).length || asArr(analysis.whatsBrittle).length) ? H2("What we noticed") : ""}
    ${asArr(analysis.whatsWorking).length ? H3("What's working") + UL(asArr(analysis.whatsWorking)) : ""}
    ${asArr(analysis.whatsBrittle).length ? H3("What's brittle") + UL(asArr(analysis.whatsBrittle)) : ""}

    ${asArr(analysis.aiEmployees).length ? H2("Areas we could automate together") + P("These are starting points for our conversation, not a final build plan. Read through and tell us which one would relieve the most pressure — that's where we'd start.", { muted: true }) + employeesHtml + calloutBlock("Which of these would lift the most off you? Tell Joe — that's the start of our next conversation.", { bg: "rgba(36,86,255,0.08)", border: "#2456FF" }) : ""}

    ${asArr(analysis.whereWedStart).length ? H2("Where we'd start the conversation") + P("Our gut on which area to discuss first. But you know best — pick the one that sounds like the most relief.", { muted: true }) + whereWedStartHtml : ""}

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
      const title = e.title || e.role || e.firstName || "Area";
      lines.push("       >> Possible automation area: " + title);
    });
  });
  lines.push("");
  if (asArr(analysis.aiEmployees).length) {
    lines.push("AREAS WE COULD AUTOMATE TOGETHER");
    lines.push("These are starting points for our conversation, not a final build plan.");
    lines.push("");
    asArr(analysis.aiEmployees).forEach((e) => {
      const rank = String(e.rank || "").padStart(2, "0");
      const title = e.title || e.role || e.firstName || "Area";
      lines.push("  Area #" + rank + ": " + title);
      if (e.whatHappensToday) lines.push("       What happens today: " + e.whatHappensToday);
      const whatWedExplore = e.whatWedExplore || e.whatTheyDo;
      if (whatWedExplore) lines.push("       What we would explore: " + whatWedExplore);
      if (e.whatWedFigureOutTogether) lines.push("       What we would figure out together: " + e.whatWedFigureOutTogether);
      const lifts = e.whatThisLiftsOffYou || e.whatYouSkip;
      if (lifts) lines.push("       What this lifts off you: " + lifts);
      const impact = e.estimatedImpact || e.timeSavings || e.estimatedDollarValue;
      if (impact) lines.push("       Rough impact: " + impact);
      if (e.buildEffort) lines.push("       Rough build effort: " + e.buildEffort);
    });
    lines.push("");
    lines.push("Which of these would lift the most off you? Tell Joe.");
    lines.push("");
  }
  if (asArr(analysis.whereWedStart).length) {
    lines.push("WHERE WE WOULD START THE CONVERSATION");
    asArr(analysis.whereWedStart).forEach((w, i) => {
      const title = w.title || w.name || "";
      lines.push("  " + (i + 1) + ". " + title + (w.timeline ? "  (" + w.timeline + ")" : ""));
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
      `Your process is on paper. Below is everything you walked us through for ${sop.processName || "this process"}, in order.`,
    openingNote:
      "Here's your process as we captured it together. You just got something out of your head that has probably never lived anywhere outside it before. Read through, mark anything that's not quite right, and tell Joe — that's the start of our next conversation.",
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
      "Our analysis pass didn't run cleanly this round, so we'll skip the automation suggestions for now. Joe will review the captured SOP and follow up directly with where we'd start.",
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
    children.push(docxHeading("The assembly line — your process, on paper", 2));
    children.push(docxParagraph(
      "This is the headline. Every step of your process, in the order you described it. Read it. Make sure it matches how things actually run. Where a step could be automated, you'll see a note below it pointing back to one of the areas at the bottom of this document.",
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
      // Area handoff chips — light suggestion that this step could be automated
      const handoffs = employeesForStepDocx(n);
      handoffs.forEach((e) => {
        const title = e.title || e.role || e.firstName || "Area";
        children.push(docxCallout(`Possible automation area: ${title}`, { color: DOCX_BLUE, fill: "EEF3FF" }));
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

  // Areas we could automate together
  if (asArr(analysis.aiEmployees).length) {
    children.push(docxDivider());
    children.push(docxHeading("Areas we could automate together", 2));
    children.push(docxParagraph(
      "These are starting points for our conversation, not a final build plan. Read through and tell us which one would relieve the most pressure — that's where we'd start.",
      { italics: true, color: DOCX_MUTED, after: 200 }
    ));
    asArr(analysis.aiEmployees).forEach((e) => {
      const rank = String(e.rank || "").padStart(2, "0");
      const title = e.title || e.role || e.firstName || "Area";
      children.push(new Paragraph({
        children: [docxText(`AREA #${rank}` + (e.priority ? `  ·  ${e.priority.toUpperCase()}` : ""),
          { bold: true, size: 16, color: DOCX_BLUE })],
        spacing: { before: 240, after: 60 },
      }));
      children.push(new Paragraph({
        children: [docxText(title, { bold: true, size: 28, color: DOCX_INK, font: "Georgia" })],
        spacing: { before: 0, after: 120 },
      }));
      if (e.whatHappensToday) children.push(docxKV("What happens today", e.whatHappensToday));
      const whatWedExplore = e.whatWedExplore || e.whatTheyDo;
      if (whatWedExplore) children.push(docxKV("What we'd explore", whatWedExplore));
      if (e.whatWedFigureOutTogether) children.push(docxKV("What we'd figure out together", e.whatWedFigureOutTogether));
      const lifts = e.whatThisLiftsOffYou || e.whatYouSkip;
      if (lifts) children.push(docxKV("What this lifts off you", lifts));
      const impact = e.estimatedImpact || e.timeSavings || e.estimatedDollarValue;
      if (impact) children.push(docxKV("Rough impact", impact));
      if (e.buildEffort) children.push(docxKV("Rough build effort", e.buildEffort));
      if (e.complexity) children.push(docxKV("Complexity", e.complexity));
      if (asArr(e.tools).length) children.push(docxKV("Tools", asArr(e.tools).join(", ")));
      if (asArr(e.appliesToSteps).length) children.push(docxKV("Covers steps", asArr(e.appliesToSteps).join(", ")));
      if (e.humanInLoop) children.push(docxKV("What stays with you", e.humanInLoop));
    });
    children.push(docxSpacer(200));
    children.push(docxCallout(
      "Which of these would lift the most off you? Tell Joe — that's the start of our next conversation.",
      { color: DOCX_BLUE, fill: "EEF3FF" }
    ));
  }

  // Where we'd start the conversation
  if (asArr(analysis.whereWedStart).length) {
    children.push(docxDivider());
    children.push(docxHeading("Where we'd start the conversation", 2));
    children.push(docxParagraph(
      "Our gut on which area to discuss first. But you know best where the heaviest pressure is — pick the one that sounds like the most relief.",
      { italics: true, color: DOCX_MUTED, after: 160 }
    ));
    asArr(analysis.whereWedStart).forEach((w, i) => {
      const title = w.title || w.name || "";
      children.push(new Paragraph({
        children: [
          docxText(`Suggestion ${i + 1}.  `, { bold: true, size: 22, color: DOCX_BLUE, font: "Georgia" }),
          docxText(title, { bold: true, size: 22, color: DOCX_INK }),
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
