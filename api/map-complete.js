// Vercel Serverless Function. Final generation pass for /map.
//
// Triggered after the client has finished all selected workflow interviews.
// Does three things in sequence:
//   1) ONE Anthropic call that returns BOTH deliverables as structured JSON
//      (Deliverable 1: Process Documentation in Markdown / Deliverable 2:
//      Practical AI Game Plan in Markdown + structured data).
//   2) Creates a Notion page in the SOP Library DB containing the
//      Process Documentation Markdown as a sub-page block tree.
//   3) Emails both the client and Joe with the deliverables attached
//      as text and inline.
//
// Cost control: ONE Anthropic call per session for the final generation.
// Workflow summaries from the interview are reused as input. Conversation
// transcripts are passed only as supporting context.
//
// Env: ANTHROPIC_API_KEY, NOTION_API_KEY, RESEND_API_KEY

const Anthropic = require("@anthropic-ai/sdk");
const { Client: NotionClient } = require("@notionhq/client");
const { Resend } = require("resend");

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 16000;
const SOP_LIBRARY_DB_ID = "362567cd-8712-8174-982d-ffa3a95e441c";
const JOE_EMAIL = "joe@thepracticalai.co";
const FROM = "Practical AI Co. <joe@thepracticalai.co>";

// ============================================================
// Generation system prompt (per Joe's spec)
// ============================================================
const SYSTEM_PROMPT = `You are the discovery and process documentation engine for Practical AI Co.

Practical AI Co. helps small business owners document how their business actually works, then identify practical AI and automation opportunities. You are now in the FINAL GENERATION step. The client has completed a guided interview about one or more of their workflows. Your job is to turn the interview into two polished deliverables.

==========================================================
IMPORTANT RULES
==========================================================

- Process documentation comes first. Automation recommendations are based on the documented process.
- Do not recommend automation before understanding the workflow.
- Use plain English. Be warm, clear, practical.
- Do not shame the business owner.
- Do not use jargon.
- DO NOT USE EM DASHES anywhere. Use periods, commas, colons, parentheses, or simple hyphens instead.
- Do not overpromise.
- Do not recommend automating everything.
- If information is missing, label it as an open question.
- If you make an assumption, clearly label it as an assumption.
- Practical AI Co. is the guide and build partner. Do not make it sound like the client has to build the recommendations alone.
- Use phrases like "what we can build with you", "where we would start", "the first system we would recommend building together". Avoid "you should build", "implement on your own", "your team should automate this".

==========================================================
OUTPUT FORMAT
==========================================================

Output a single JSON object wrapped in <DELIVERABLES></DELIVERABLES> tags. The JSON has this exact shape:

<DELIVERABLES>
{
  "sopMarkdown": "string containing Deliverable 1 in clean Markdown, see format below",
  "gameplanMarkdown": "string containing Deliverable 2 in clean Markdown, see format below",
  "gameplanData": {
    "whatWeHeard": "the warm summary paragraph from the game plan",
    "bottlenecks": [{ "category": "Getting Customers | Following Up | Delivering the Work | Communicating with Customers | Running the Business", "note": "1 to 2 sentences specific to this client" }],
    "topThreeOpportunities": [
      {
        "name": "short name",
        "process": "which workflow this connects to",
        "whatItDoes": "1 to 2 sentences",
        "whyItMatters": "1 to 2 sentences",
        "toolsLikelyInvolved": ["tool", "tool"],
        "difficulty": "Low | Medium | High",
        "impact": "Low | Medium | High",
        "confidence": "Low | Medium | High",
        "suggestedFirstStep": "the first concrete action Practical AI Co. would take, written in first-person plural. WE take this step, not the client. Example: 'We would connect to your ServiceTitan account and map the current lead routing rules' or 'We would draft the Monday morning triage logic and walk through it with you.' Never assign research or homework to the client."
      }
    ],
    "bestFirstBuild": {
      "name": "the chosen first build",
      "whyFirst": "why this one comes first",
      "whatItSolves": "the pain it removes",
      "whatPaicWillBuild": "what Practical AI Co. would build with the client",
      "whatsIncluded": "what would be in the first version",
      "successLooksLike": "what success looks like in plain words"
    },
    "whatNotToAutomateYet": "one honest recommendation",
    "thirtyDayPlan": {
      "week1": "what we do together in week 1",
      "week2": "what we build in week 2",
      "week3": "what we test with real work in week 3",
      "week4": "what we refine and hand off in week 4"
    },
    "recommendedNextStep": "the recommended next step with Practical AI Co. (review the documentation, confirm open questions, scope the first build)"
  },
  "sopData": {
    "businessOverview": "2 to 3 sentence plain-English summary of the business",
    "workflows": [
      {
        "name": "workflow name matching the SOP",
        "atAGlance": {
          "purpose": "short phrase: what this workflow is designed to accomplish",
          "owner": "primary role who owns this workflow",
          "trigger": "what starts this workflow",
          "time": "rough estimate of time per occurrence, or omit if unknown",
          "tools": ["specific tool name", "specific tool name"],
          "output": "what this workflow produces when done correctly",
          "successMetric": "how you know this workflow went well"
        },
        "steps": [
          {
            "number": 1,
            "title": "Short action title (or a yes/no question for decision steps)",
            "whatToDo": "1 to 2 sentences describing the action. For decision steps, describe what the owner must determine.",
            "doneWhen": "the completion condition for this step",
            "owner": "role or name",
            "tool": "tool, location, or method used",
            "automatable": true,
            "automationNote": "what Practical AI Co. could build here, in we language. null if not automatable.",
            "isDecision": false,
            "ifYes": null,
            "ifNo": null
          }
        ],
        "qualityChecks": ["check 1", "check 2"],
        "commonMistakes": ["mistake or pitfall 1", "mistake or pitfall 2"]
      }
    ]
  }
}
</DELIVERABLES>

IMPORTANT rules for sopData:
- steps should be card-length, not document-length. Full detail lives in sopMarkdown.
- isDecision: true for any step that requires a yes/no choice that changes what happens next. Title must be phrased as a question for decision steps.
- ifYes and ifNo describe the two paths for decision steps (null for non-decision steps).
- automatable: true only when AI or automation could genuinely reduce human effort on this specific step.
- automationNote must use we language: "we would...", "we could build...", "where we'd start...". Never "you should" or "the client should".
- Include 8 to 20 steps per workflow. Fewer is fine for simpler workflows.
- qualityChecks: 3 to 5 items. commonMistakes: 2 to 4 items.

==========================================================
DELIVERABLE 1: HERE'S YOUR FIRST PROCESS, MAPPED OUT
==========================================================

The sopMarkdown field contains a complete, Notion-ready Markdown document with this exact structure:

# Business Process Documentation

## Business Overview
A 3 to 5 sentence summary of: business name, industry, team size, primary customer type, core services, current tools, main operational pain points.

## Workflow Index
A Markdown table with these columns:
| Workflow | Owner | Trigger | Tools | Pain Level | Automation Potential | Documentation Completeness |

One row per workflow they walked through. Pain Level, Automation Potential, and Documentation Completeness are each one of: Low / Medium / High.

## SOP: [Workflow Name]

For EACH workflow they walked through, include a full SOP with this structure (replace [Workflow Name] with the actual workflow name):

### Purpose
What this workflow is designed to accomplish (2 to 3 sentences).

### When This Process Starts
The trigger.

### When This Process Ends
The completion point.

### Owner
Who owns this workflow.

### People Involved
Roles or names of others.

### Tools and Systems Used
A bulleted list. Be specific: name actual tools (Gmail, ServiceTitan, QuickBooks, iMessage, a Google Sheet).

### Inputs Needed
A bulleted list of required information, documents, customer details, forms, approvals.

### Step-by-Step Process
A numbered list. PRESERVE EVERY SUB-STEP the owner described. Do not summarize. Do not consolidate. Aim for 15 to 30+ steps per workflow if the interview produced that much detail.

Each step should follow this format:
**Step N: [Action]**
- Owner: who does it
- Tool: which tool or location
- Output: what this step produces
- Notes: optional one-liner if there's something important

### Decision Points
Bulleted list. Each one: "If X then Y" or "When X, the owner has to decide Y".

### Handoffs
Bulleted list. Who passes what to whom, where the handoff happens, what confirms the next person has what they need.

### Exceptions and Edge Cases
Bulleted list. Common situations that don't follow the normal path.

### Quality Standards
What "done right" looks like.

### Current Bottlenecks
Bulleted list. Where the process slows, breaks, or depends too much on memory.

### Risks
Bulleted list. What can go wrong if the process isn't followed.

### Improvement Opportunities
NON-AI process improvements first. Bulleted list.

### AI and Automation Opportunities
Practical places where AI or automation could help. Bulleted list. Phrase each one as something Practical AI Co. could build with the client.

### Open Questions
Bulleted list of anything still unclear. Use phrases like "(open question, to confirm with Joe)".

==========================================================
DELIVERABLE 2: YOUR PRACTICAL AI GAME PLAN
==========================================================

The gameplanMarkdown field contains a Notion-ready Markdown document with this exact structure:

# Your Practical AI Game Plan

## What We Heard
A warm, accurate summary paragraph of the business and its operational reality. The client should feel understood. 4 to 6 sentences.

## Where Work Is Getting Stuck
3 to 5 bottlenecks. For each one:

### [Bottleneck category: Getting Customers / Following Up / Delivering the Work / Communicating with Customers / Running the Business]
1 to 2 sentences describing what's stuck for this specific client.

Only include the categories that are relevant. You don't need to use all of them.

## Top 3 AI Opportunities

For each opportunity (exactly 3):

### Opportunity 1: [Name]
**Process:** Which workflow this connects to
**What it does:** 1 to 2 sentences in plain English
**Why it matters:** 1 to 2 sentences about why this is right for THIS business
**Tools likely involved:** brief list
**Difficulty:** Low / Medium / High
**Impact:** Low / Medium / High
**Confidence:** Low / Medium / High
**Suggested first step:** What Practical AI Co. would do first

## Best First Build
**The chosen build:** [Name]

**Why this comes first:** 2 to 3 sentences.

**What it solves:** the specific pain it removes.

**What we'd build together:** what Practical AI Co. would build with the client. Use "we" language.

**What's included in the first version:** brief list of what gets shipped.

**What success looks like:** plain words describing the change the owner will feel.

## What We Would Not Automate Yet
One honest paragraph. Pick something that genuinely shouldn't be automated yet (probably requires judgment, isn't documented enough, or volume is too low). This builds trust.

## Suggested 30-Day Plan
- **Week 1:** Finalize process map and SOP. [add what else is appropriate]
- **Week 2:** Build first automation. [add what else]
- **Week 3:** Test with real work. [add what else]
- **Week 4:** Train the team and refine. [add what else]

## Recommended Next Step
End with a clear recommendation that Practical AI Co. reviews the documentation, confirms open questions, and scopes the first build. Include the call to action: "Reply to this email or book another time with Joe to scope the first build together."

==========================================================

Output ONLY the JSON in <DELIVERABLES></DELIVERABLES> tags. No other text before or after.`;

// ============================================================
// Generate the deliverables
// ============================================================
async function generateDeliverables(anthropic, payload) {
  const { profile, workflows } = payload;

  // Build a user message containing all the input
  const workflowsBlock = workflows.map((w, i) => {
    const lines = [];
    lines.push(`---`);
    lines.push(`WORKFLOW ${i + 1}: ${w.label}`);
    lines.push(``);
    if (w.summary) {
      lines.push(`Summary (confirmed by the client):`);
      lines.push(w.summary);
      lines.push(``);
    }
    if (Array.isArray(w.conversation) && w.conversation.length) {
      lines.push(`Full interview transcript:`);
      w.conversation.forEach((m) => {
        const role = m.role === "assistant" ? "Practical AI Co." : "Client";
        lines.push(`${role}: ${(m.content || "").toString()}`);
      });
    }
    return lines.join("\n");
  }).join("\n\n");

  const profileBlock = [
    profile.businessName ? `Business: ${profile.businessName}` : "",
    profile.industry ? `Industry: ${profile.industry}` : "",
    profile.teamSize ? `Team size: ${profile.teamSize}` : "",
    profile.customerType ? `Main customer: ${profile.customerType}` : "",
    profile.services ? `Services/products: ${profile.services}` : "",
    profile.tools ? `Tools used today: ${profile.tools}` : "",
    profile.firstName ? `Owner first name: ${profile.firstName}` : "",
    profile.role ? `Owner role: ${profile.role}` : "",
    profile.headache ? `Biggest operational headache: ${profile.headache}` : "",
  ].filter(Boolean).join("\n");

  const userMessage = `Here is the discovery session input for the business owner. Generate both deliverables per your system prompt.

CLIENT PROFILE:
${profileBlock}

WORKFLOWS:

${workflowsBlock}

Generate the two deliverables. Output ONLY the JSON wrapped in <DELIVERABLES></DELIVERABLES> tags. Remember: NO em dashes anywhere.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = (response.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const match = text.match(/<DELIVERABLES>([\s\S]*?)<\/DELIVERABLES>/);
  if (!match) throw new Error("Generation output missing <DELIVERABLES> tags");
  return JSON.parse(match[1].trim());
}

// ============================================================
// Notion page creation
// ============================================================
function richText(content) {
  const s = String(content || "");
  if (s.length <= 1900) return [{ type: "text", text: { content: s } }];
  const out = [];
  for (let i = 0; i < s.length; i += 1900) {
    out.push({ type: "text", text: { content: s.slice(i, i + 1900) } });
  }
  return out;
}

// Convert generated Markdown into Notion blocks.
// Supports: # ## ### #### headings, bulleted (-), numbered (1.), bold (**), italic (*),
// horizontal divider (---), and plain paragraphs.
function markdownToNotionBlocks(md) {
  const lines = String(md || "").split("\n");
  const blocks = [];
  let paraBuffer = [];

  const flushParagraph = () => {
    if (paraBuffer.length === 0) return;
    const text = paraBuffer.join(" ").trim();
    if (text) {
      blocks.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: parseInlineMarkdown(text) },
      });
    }
    paraBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === "") {
      flushParagraph();
      continue;
    }
    if (line === "---") {
      flushParagraph();
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }
    let m;
    if ((m = line.match(/^####\s+(.+)$/))) {
      flushParagraph();
      blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: parseInlineMarkdown(m[1]) } });
    } else if ((m = line.match(/^###\s+(.+)$/))) {
      flushParagraph();
      blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: parseInlineMarkdown(m[1]) } });
    } else if ((m = line.match(/^##\s+(.+)$/))) {
      flushParagraph();
      blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: parseInlineMarkdown(m[1]) } });
    } else if ((m = line.match(/^#\s+(.+)$/))) {
      flushParagraph();
      blocks.push({ object: "block", type: "heading_1", heading_1: { rich_text: parseInlineMarkdown(m[1]) } });
    } else if ((m = line.match(/^[-*]\s+(.+)$/))) {
      flushParagraph();
      blocks.push({
        object: "block", type: "bulleted_list_item",
        bulleted_list_item: { rich_text: parseInlineMarkdown(m[1]) },
      });
    } else if ((m = line.match(/^\d+\.\s+(.+)$/))) {
      flushParagraph();
      blocks.push({
        object: "block", type: "numbered_list_item",
        numbered_list_item: { rich_text: parseInlineMarkdown(m[1]) },
      });
    } else if (line.startsWith("|")) {
      // Skip Markdown tables for now (Notion table block is complex);
      // dump as a paragraph instead. The full Markdown is also attached to email.
      flushParagraph();
      blocks.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: parseInlineMarkdown(line) },
      });
    } else {
      paraBuffer.push(line);
    }
  }
  flushParagraph();

  // Notion API caps children per request at 100
  return blocks.slice(0, 99);
}

// Parse **bold** and *italic* into Notion rich_text annotations
function parseInlineMarkdown(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) {
      out.push({ type: "text", text: { content: text.slice(lastIdx, m.index) } });
    }
    if (m[1] !== undefined) {
      out.push({
        type: "text",
        text: { content: m[1] },
        annotations: { bold: true },
      });
    } else if (m[2] !== undefined) {
      out.push({
        type: "text",
        text: { content: m[2] },
        annotations: { italic: true },
      });
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) {
    out.push({ type: "text", text: { content: text.slice(lastIdx) } });
  }
  // Notion rich_text item max content length is 2000; if any item exceeds, split.
  const safe = [];
  for (const item of out) {
    const content = item.text && item.text.content ? String(item.text.content) : "";
    if (content.length <= 1900) {
      safe.push(item);
    } else {
      for (let i = 0; i < content.length; i += 1900) {
        safe.push(Object.assign({}, item, {
          text: { content: content.slice(i, i + 1900) },
        }));
      }
    }
  }
  return safe.length ? safe : [{ type: "text", text: { content: text } }];
}

async function createNotionPage(notion, { profile, sopMarkdown }) {
  const today = new Date().toISOString().split("T")[0];
  const pageTitle = (profile.businessName || "Process Map") + " " + today;
  const properties = {
    "Process Name": { title: richText(pageTitle) },
    "Client": { rich_text: richText(profile.firstName || "") },
    "Business": { rich_text: richText(profile.businessName || "") },
    "Email": { email: profile.email || null },
    "Status": { select: { name: "Draft" } },
    "Last Updated": { date: { start: today } },
  };
  const children = markdownToNotionBlocks(sopMarkdown);
  const page = await notion.pages.create({
    parent: { database_id: SOP_LIBRARY_DB_ID },
    properties,
    children,
  });
  return { id: page.id, url: page.url };
}

// ============================================================
// Email rendering
// ============================================================
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function renderEmailHtml({ profile, notionUrl, gameplanMarkdown, sopData, isJoe }) {
  const gameplanHtml = gameplanMarkdown ? markdownToInlineHtml(gameplanMarkdown) : "";
  const sopHtml = sopData ? renderSopEmailHtml(sopData) : "";
  const notionBlock = notionUrl
    ? `<p style="margin:16px 0;"><a href="${esc(notionUrl)}" style="display:inline-block;background:#2456FF;color:white;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:800;font-size:14px;">Open your process in Notion &rarr;</a></p>`
    : `<p style="margin:16px 0;color:#667085;font-size:14px;">Your full process map is attached. Joe will share the Notion link directly.</p>`;
  const greeting = isJoe
    ? `<p>A new client just completed a process mapping session. Their deliverables are below.</p>`
    : `<p>You just mapped out how your business runs. Below is your process documentation and your Practical AI Game Plan.</p>`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FBF5EA;font-family:Helvetica,Arial,sans-serif;color:#172033;">
  <div style="max-width:680px;margin:0 auto;padding:36px 24px 60px;">
    <div style="font-family:Georgia,serif;font-weight:800;color:#172033;font-size:24px;letter-spacing:-0.02em;margin-bottom:4px;">
      Practical <span style="color:#2456FF;">AI</span> Co.
    </div>
    <div style="font-size:10px;font-weight:900;letter-spacing:0.26em;color:#667085;text-transform:uppercase;margin-bottom:28px;">
      Systems that run so you can lead
    </div>
    <h1 style="font-family:Georgia,serif;font-size:28px;letter-spacing:-0.025em;color:#172033;margin:0 0 6px;line-height:1.15;">
      ${esc(profile.businessName || "Your process map")}
    </h1>
    <div style="color:#667085;font-size:13px;font-weight:700;margin-bottom:22px;">
      Prepared by Practical AI Co. for ${esc(profile.firstName || "")} &middot; ${esc(new Date().toISOString().split("T")[0])}
    </div>
    ${greeting}
    ${notionBlock}
    ${sopHtml ? `
    <hr style="border:0;border-top:1px solid #E7DCCB;margin:24px 0;" />
    <h2 style="font-family:Georgia,serif;font-size:22px;letter-spacing:-0.022em;color:#172033;margin:0 0 16px;">Your Process, Mapped Out</h2>
    ${sopHtml}` : ""}
    <hr style="border:0;border-top:1px solid #E7DCCB;margin:32px 0;" />
    <h2 style="font-family:Georgia,serif;font-size:22px;letter-spacing:-0.022em;color:#172033;margin:0 0 12px;">Your Practical AI Game Plan</h2>
    ${gameplanHtml || '<p style="color:#667085;font-style:italic;">(Game plan attached as Markdown.)</p>'}
    <hr style="border:0;border-top:1px solid #E7DCCB;margin:30px 0 18px;" />
    <p style="margin:0 0 4px;font-size:14px;color:#667085;">Ready to turn this into a working system?</p>
    <p style="margin:0;"><a href="https://calendar.app.google/SnmSbP7hZCprCZ9B7" style="color:#2456FF;text-decoration:none;font-weight:800;">Book time with Joe to scope the first build &rarr;</a></p>
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #E7DCCB;font-size:12px;color:#8A93A5;">
      Practical AI Co. &middot; Franklin, TN &middot; <a href="mailto:joe@thepracticalai.co" style="color:#2456FF;text-decoration:none;">joe@thepracticalai.co</a>
    </div>
  </div>
</body></html>`;
}

// Tiny inline markdown to HTML for the email body (h1-h4, ul, p, bold, italic)
function markdownToInlineHtml(md) {
  const lines = String(md || "").split("\n");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>");

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { closeList(); continue; }
    let m;
    if ((m = t.match(/^####?\s+(.+)$/))) {
      closeList();
      html += `<h4 style="font-family:Georgia,serif;font-size:17px;letter-spacing:-0.018em;color:#172033;margin:18px 0 6px;">${inline(m[1])}</h4>`;
    } else if ((m = t.match(/^###\s+(.+)$/))) {
      closeList();
      html += `<h3 style="font-family:Georgia,serif;font-size:19px;letter-spacing:-0.02em;color:#172033;margin:22px 0 8px;">${inline(m[1])}</h3>`;
    } else if ((m = t.match(/^##\s+(.+)$/))) {
      closeList();
      html += `<h2 style="font-family:Georgia,serif;font-size:22px;letter-spacing:-0.022em;color:#172033;margin:28px 0 10px;">${inline(m[1])}</h2>`;
    } else if ((m = t.match(/^#\s+(.+)$/))) {
      closeList();
      html += `<h1 style="font-family:Georgia,serif;font-size:26px;letter-spacing:-0.025em;color:#172033;margin:24px 0 12px;">${inline(m[1])}</h1>`;
    } else if ((m = t.match(/^[-*]\s+(.+)$/))) {
      if (!inList) { html += `<ul style="margin:6px 0 14px;padding-left:20px;color:#172033;">`; inList = true; }
      html += `<li style="margin:6px 0;line-height:1.55;">${inline(m[1])}</li>`;
    } else {
      closeList();
      html += `<p style="margin:8px 0;line-height:1.6;color:#172033;font-size:15px;">${inline(t)}</p>`;
    }
  }
  closeList();
  return html;
}

// ============================================================
// SOP visual renderer (table-based for email safety)
// ============================================================
function renderSopEmailHtml(sopData) {
  if (!sopData || !Array.isArray(sopData.workflows) || !sopData.workflows.length) return "";

  let html = "";

  if (sopData.businessOverview) {
    html += `<p style="margin:0 0 24px;line-height:1.6;color:#172033;font-size:15px;">${esc(sopData.businessOverview)}</p>`;
  }

  for (const workflow of sopData.workflows) {
    html += `<h3 style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.02em;color:#172033;margin:32px 0 14px;padding-top:24px;border-top:2px solid #E7DCCB;">${esc(workflow.name || "")}</h3>`;

    // At a Glance
    const ag = workflow.atAGlance || {};
    const glanceItems = [
      { label: "Purpose",        value: ag.purpose },
      { label: "Owner",          value: ag.owner },
      { label: "Trigger",        value: ag.trigger },
      { label: "Tools",          value: Array.isArray(ag.tools) ? ag.tools.join(", ") : ag.tools },
      { label: "Output",         value: ag.output },
      { label: "Success Metric", value: ag.successMetric },
    ].filter((i) => i.value);

    if (glanceItems.length) {
      const pairs = [];
      for (let i = 0; i < glanceItems.length; i += 2) pairs.push([glanceItems[i], glanceItems[i + 1]]);
      html += `<table style="width:100%;border-collapse:collapse;margin:0 0 20px;" cellpadding="0" cellspacing="0"><tr><td style="background:#F5F0E8;border-radius:14px;padding:16px 20px;"><table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0">`;
      html += pairs.map(([l, r]) => `<tr>
        <td style="width:48%;vertical-align:top;padding:0 12px 12px 0;">
          <div style="font-size:10px;font-weight:900;color:#8A93A5;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:3px;">${esc(l.label)}</div>
          <div style="font-size:13px;color:#172033;line-height:1.4;">${esc(l.value || "")}</div>
        </td>
        <td style="width:4%;"></td>
        <td style="width:48%;vertical-align:top;padding:0 0 12px 0;">
          ${r ? `<div style="font-size:10px;font-weight:900;color:#8A93A5;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:3px;">${esc(r.label)}</div><div style="font-size:13px;color:#172033;line-height:1.4;">${esc(r.value || "")}</div>` : ""}
        </td>
      </tr>`).join("");
      html += `</table></td></tr></table>`;
    }

    // Steps
    for (const step of (workflow.steps || [])) {
      const dec = step.isDecision;
      const numBg  = dec ? "#B45309" : "#2456FF";
      const border = dec ? "border:2px solid #B45309;" : "border:1px solid #E7DCCB;";
      const num    = dec ? "?" : esc(String(step.number || ""));

      html += `<table style="width:100%;border-collapse:collapse;margin:0 0 8px;" cellpadding="0" cellspacing="0"><tr>
        <td style="width:44px;vertical-align:top;padding:2px 10px 0 0;">
          <div style="width:36px;height:36px;background:${numBg};border-radius:50%;text-align:center;line-height:36px;color:white;font-weight:900;font-size:${dec ? "18px" : "14px"};">${num}</div>
        </td>
        <td style="background:#FFFDF8;${border}border-radius:12px;padding:14px 16px;">`;

      if (dec) html += `<div style="font-size:10px;font-weight:900;color:#B45309;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px;">Decision Point</div>`;
      html += `<div style="font-weight:800;color:#172033;font-size:15px;margin:0 0 4px;">${esc(step.title || "")}</div>`;

      if (step.owner || step.tool) {
        html += `<div style="font-size:12px;color:#8A93A5;margin:0 0 8px;">`;
        if (step.owner) html += `Owner: ${esc(step.owner)}`;
        if (step.owner && step.tool) html += ` &nbsp;|&nbsp; `;
        if (step.tool)  html += `Tool: ${esc(step.tool)}`;
        html += `</div>`;
      }

      if (step.whatToDo) html += `<div style="font-size:14px;color:#172033;margin:0 0 8px;line-height:1.5;">${esc(step.whatToDo)}</div>`;
      if (step.doneWhen) html += `<div style="font-size:13px;color:#2F8F5B;font-weight:600;">Done when: ${esc(step.doneWhen)}</div>`;

      if (dec && (step.ifYes || step.ifNo)) {
        html += `<table style="width:100%;border-collapse:collapse;margin-top:12px;" cellpadding="0" cellspacing="0"><tr>
          <td style="width:49%;background:#E8F5EE;border-radius:8px;padding:10px 12px;vertical-align:top;">
            <div style="font-size:10px;font-weight:900;color:#2F8F5B;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">YES</div>
            <div style="font-size:13px;color:#172033;">${esc(step.ifYes || "")}</div>
          </td>
          <td style="width:2%;"></td>
          <td style="width:49%;background:#FEF3E8;border-radius:8px;padding:10px 12px;vertical-align:top;">
            <div style="font-size:10px;font-weight:900;color:#B45309;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">NO</div>
            <div style="font-size:13px;color:#172033;">${esc(step.ifNo || "")}</div>
          </td>
        </tr></table>`;
      }

      if (step.automatable && step.automationNote) {
        html += `<div style="margin:10px 0 0;padding:10px 14px;background:rgba(36,86,255,0.07);border-left:3px solid #2456FF;border-radius:0 8px 8px 0;">
          <span style="font-size:10px;font-weight:900;color:#2456FF;text-transform:uppercase;letter-spacing:0.1em;display:block;margin-bottom:3px;">Automate this</span>
          <span style="font-size:13px;color:#172033;">${esc(step.automationNote)}</span>
        </div>`;
      }

      html += `</td></tr></table>`;
    }

    // Quality checks
    if (Array.isArray(workflow.qualityChecks) && workflow.qualityChecks.length) {
      html += `<div style="background:#F5F0E8;border-radius:12px;padding:14px 18px;margin:14px 0 8px;">
        <div style="font-size:11px;font-weight:900;color:#2456FF;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px;">Quality Checks</div>`;
      workflow.qualityChecks.forEach((c) => {
        html += `<div style="font-size:13px;color:#172033;margin-bottom:6px;">&#10003;&nbsp; ${esc(c)}</div>`;
      });
      html += `</div>`;
    }

    // Common mistakes
    if (Array.isArray(workflow.commonMistakes) && workflow.commonMistakes.length) {
      html += `<div style="background:rgba(180,83,9,0.06);border-radius:12px;padding:14px 18px;margin:0 0 8px;">
        <div style="font-size:11px;font-weight:900;color:#B45309;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px;">Common Mistakes to Avoid</div>`;
      workflow.commonMistakes.forEach((m) => {
        html += `<div style="font-size:13px;color:#172033;margin-bottom:6px;">&#9747;&nbsp; ${esc(m)}</div>`;
      });
      html += `</div>`;
    }
  }

  return html;
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
  const workflows = Array.isArray(body.workflows) ? body.workflows : [];

  if (!profile.businessName || !profile.email || workflows.length === 0) {
    return res.status(400).json({ error: "Missing profile or workflows" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const notionKey = process.env.NOTION_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // 1. Generate deliverables
  let deliverables;
  try {
    deliverables = await generateDeliverables(anthropic, { profile, workflows });
  } catch (err) {
    console.error("Generation failed:", err);
    return res.status(500).json({ error: "Generation failed: " + (err.message || "unknown") });
  }

  const sopMarkdown = deliverables.sopMarkdown || "";
  const gameplanMarkdown = deliverables.gameplanMarkdown || "";

  // 2. Notion page (fail soft)
  let notionUrl = null;
  let notionError = null;
  if (notionKey && SOP_LIBRARY_DB_ID && !SOP_LIBRARY_DB_ID.startsWith("TODO")) {
    try {
      const notion = new NotionClient({ auth: notionKey });
      const page = await createNotionPage(notion, { profile, sopMarkdown });
      notionUrl = page.url;
    } catch (err) {
      console.error("Notion page creation failed:", err);
      notionError = err.message || "Notion failed";
    }
  } else {
    notionError = "NOTION_API_KEY not configured";
  }

  // 3. Emails (fail soft per recipient)
  let clientEmailError = null;
  let joeEmailError = null;
  if (resendKey) {
    const resend = new Resend(resendKey);
    const subjectClient = `Your Practical AI Co. process map: ${profile.businessName}`;
    const subjectJoe = `New /map session complete: ${profile.businessName}`;
    const sopData = deliverables.sopData || null;
    const clientHtml = renderEmailHtml({ profile, notionUrl, gameplanMarkdown, sopData, isJoe: false });
    const joeHtml = renderEmailHtml({ profile, notionUrl, gameplanMarkdown, sopData, isJoe: true });

    // Attach the SOP Markdown as a .md file so the client always has a portable copy
    const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const attachmentName = (slug(profile.businessName) || "process-map") + ".md";
    const attachments = [{
      filename: attachmentName,
      content: Buffer.from(sopMarkdown || "(empty)", "utf8").toString("base64"),
    }];

    const [clientResult, joeResult] = await Promise.allSettled([
      resend.emails.send({
        from: FROM,
        to: profile.email,
        reply_to: JOE_EMAIL,
        subject: subjectClient,
        html: clientHtml,
        text: gameplanMarkdown,
        attachments,
      }),
      resend.emails.send({
        from: FROM,
        to: profile.joeEmail || JOE_EMAIL,
        reply_to: profile.email,
        subject: subjectJoe,
        html: joeHtml,
        text: sopMarkdown + "\n\n---\n\n" + gameplanMarkdown,
        attachments,
      }),
    ]);
    if (clientResult.status === "rejected") clientEmailError = (clientResult.reason && clientResult.reason.message) || "client email failed";
    if (joeResult.status === "rejected") joeEmailError = (joeResult.reason && joeResult.reason.message) || "joe email failed";
  } else {
    clientEmailError = "RESEND_API_KEY not configured";
    joeEmailError = "RESEND_API_KEY not configured";
  }

  console.log("Map complete:", {
    business: profile.businessName,
    email: profile.email,
    workflowCount: workflows.length,
    notionUrl,
    notionError,
    clientEmailError,
    joeEmailError,
  });

  return res.status(200).json({
    sopMarkdown,
    gameplanMarkdown,
    gameplanData: deliverables.gameplanData || null,
    sopData: deliverables.sopData || null,
    notionUrl,
    errors: {
      notion: notionError,
      clientEmail: clientEmailError,
      joeEmail: joeEmailError,
    },
  });
};
