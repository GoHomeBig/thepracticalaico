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

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 20000;
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

Output a single JSON object wrapped in <DELIVERABLES></DELIVERABLES> tags. The JSON has exactly two top-level fields: sopData (Deliverable 1) and gameplanData (Deliverable 2). The Markdown versions of both deliverables are derived from this structured data automatically; you do NOT need to produce them.

<DELIVERABLES>
{
  "sopData": {
    "businessOverview": "3 to 5 sentence plain-English summary of the business: name, industry, team size, primary customer, core services, current tools, main operational pain.",
    "workflows": [
      {
        "name": "the workflow name as it would appear in a process library",
        "atAGlance": {
          "purpose": "1 sentence: what this workflow is designed to accomplish",
          "owner": "primary role who owns this workflow",
          "trigger": "what starts this workflow",
          "time": "rough time estimate per occurrence, or omit if unknown",
          "tools": ["specific tool name", "specific tool name"],
          "output": "what this workflow produces when done",
          "successMetric": "how you know this workflow went well"
        },
        "steps": [
          {
            "number": 1,
            "title": "short action title (or a yes/no question for decision steps)",
            "whatToDo": "1 to 2 sentences describing the action, or what the owner must determine for decision steps",
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
        "qualityChecks": ["check 1", "check 2", "check 3"],
        "commonMistakes": ["mistake or pitfall 1", "mistake or pitfall 2"]
      }
    ]
  },
  "gameplanData": {
    "whatWeHeard": "a warm, accurate 4 to 6 sentence summary paragraph of the business and its operational reality. The client should feel understood.",
    "bottlenecks": [
      { "category": "Getting Customers | Following Up | Delivering the Work | Communicating with Customers | Running the Business", "note": "1 to 2 sentences specific to this client" }
    ],
    "topThreeOpportunities": [
      {
        "name": "short name",
        "process": "which workflow this connects to",
        "whatItDoes": "1 to 2 sentences in plain English",
        "whyItMatters": "1 to 2 sentences about why this is right for THIS business",
        "toolsLikelyInvolved": ["tool", "tool"],
        "difficulty": "Low | Medium | High",
        "impact": "Low | Medium | High",
        "confidence": "Low | Medium | High",
        "suggestedFirstStep": "the first concrete action Practical AI Co. would take, written in first-person plural. WE take this step, not the client. Example: 'We would connect to your ServiceTitan account and map the current lead routing rules.' Never assign research or homework to the client."
      }
    ],
    "bestFirstBuild": {
      "name": "the chosen first build",
      "whyFirst": "2 to 3 sentences",
      "whatItSolves": "the pain it removes",
      "whatPaicWillBuild": "what Practical AI Co. would build with the client, in we language",
      "whatsIncluded": "brief list of what gets shipped in the first version",
      "successLooksLike": "plain words describing the change the owner will feel"
    },
    "whatNotToAutomateYet": "one honest paragraph picking something that genuinely shouldn't be automated yet (requires judgment, isn't documented enough, volume too low). This builds trust.",
    "thirtyDayPlan": {
      "week1": "what we do together in week 1",
      "week2": "what we build in week 2",
      "week3": "what we test with real work in week 3",
      "week4": "what we refine and hand off in week 4"
    },
    "recommendedNextStep": "the recommended next step with Practical AI Co.: review the documentation together, confirm open questions, scope the first build. End with the CTA to reply or book another time with Joe."
  }
}
</DELIVERABLES>

==========================================================
RULES FOR sopData
==========================================================
- Workflows array: one entry per workflow the client walked through. Use the workflow name as it would appear in a process library.
- Steps are card-length, not document-length. Each step is a single action or decision.
- PRESERVE THE DETAIL the owner described. If they described 20 sub-steps, produce 20 steps. Do not summarize or consolidate sub-steps that the owner explicitly walked through.
- Include 8 to 30 steps per workflow depending on what the interview produced.
- isDecision: true for any step that requires a yes/no choice that changes what happens next. Title must be phrased as a question for decision steps.
- ifYes and ifNo: short descriptions of the two paths (only set for decision steps, null otherwise).
- automatable: true only when AI or automation could genuinely reduce human effort on THIS specific step.
- automationNote: must use we language ("we would...", "we could build...", "where we'd start..."). Never "you should" or "the client should". null when not automatable.
- qualityChecks: 3 to 5 items. Each is a short sentence describing what done-right looks like.
- commonMistakes: 2 to 4 items. Real pitfalls or anti-patterns to avoid.

==========================================================
RULES FOR gameplanData
==========================================================
- whatWeHeard: warm, specific, 4 to 6 sentences. The client should feel heard, not lectured.
- bottlenecks: 3 to 5 items. Only use categories that are relevant. Each note is 1 to 2 sentences and specific to this client.
- topThreeOpportunities: exactly 3 opportunities. Each suggestedFirstStep MUST use first-person plural and describe what Practical AI Co. does, never what the client should do.
- bestFirstBuild: must be one of the topThreeOpportunities (pick the highest-impact, lowest-friction one).
- whatNotToAutomateYet: pick something real. This builds trust by showing restraint.
- thirtyDayPlan: each week phrased in we language. Week 1 is process finalization and discovery. Week 2 is the first build. Week 3 is testing. Week 4 is refinement and handoff.

Output ONLY the JSON in <DELIVERABLES></DELIVERABLES> tags. No other text before or after. Do NOT include sopMarkdown or gameplanMarkdown fields. The server derives those from sopData and gameplanData.`;

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
  if (!match) {
    const stopReason = response.stop_reason || "unknown";
    const usage = response.usage ? `in=${response.usage.input_tokens} out=${response.usage.output_tokens}` : "no usage";
    const head = text.slice(0, 400).replace(/\n/g, " ");
    const tail = text.slice(-400).replace(/\n/g, " ");
    throw new Error(`Missing tags. stop=${stopReason} (${usage}) len=${text.length}. HEAD: ${head} || TAIL: ${tail}`);
  }
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
// Derive Markdown from structured data (for Notion + email attachment)
// ============================================================
function sopDataToMarkdown(sopData) {
  if (!sopData || !Array.isArray(sopData.workflows)) return "";
  const out = [];
  out.push("# Business Process Documentation");
  out.push("");
  if (sopData.businessOverview) {
    out.push("## Business Overview");
    out.push("");
    out.push(sopData.businessOverview);
    out.push("");
  }
  if (sopData.workflows.length > 1) {
    out.push("## Workflow Index");
    out.push("");
    out.push("| Workflow | Owner | Trigger | Tools |");
    out.push("|----------|-------|---------|-------|");
    sopData.workflows.forEach((w) => {
      const ag = w.atAGlance || {};
      const tools = Array.isArray(ag.tools) ? ag.tools.join(", ") : (ag.tools || "");
      out.push(`| ${w.name || ""} | ${ag.owner || ""} | ${ag.trigger || ""} | ${tools} |`);
    });
    out.push("");
  }
  for (const w of sopData.workflows) {
    out.push("---");
    out.push("");
    out.push(`## SOP: ${w.name || "Untitled Workflow"}`);
    out.push("");
    const ag = w.atAGlance || {};
    out.push("### At a Glance");
    out.push("");
    if (ag.purpose)       out.push(`- **Purpose:** ${ag.purpose}`);
    if (ag.owner)         out.push(`- **Owner:** ${ag.owner}`);
    if (ag.trigger)       out.push(`- **Trigger:** ${ag.trigger}`);
    if (ag.time)          out.push(`- **Time:** ${ag.time}`);
    if (ag.tools)         out.push(`- **Tools:** ${Array.isArray(ag.tools) ? ag.tools.join(", ") : ag.tools}`);
    if (ag.output)        out.push(`- **Output:** ${ag.output}`);
    if (ag.successMetric) out.push(`- **Success Metric:** ${ag.successMetric}`);
    out.push("");
    if (Array.isArray(w.steps) && w.steps.length) {
      out.push("### Step-by-Step Process");
      out.push("");
      for (const s of w.steps) {
        const dec = s.isDecision;
        const title = dec ? `Decision: ${s.title || ""}` : (s.title || "");
        out.push(`**Step ${s.number || ""}: ${title}**`);
        if (s.owner)    out.push(`- Owner: ${s.owner}`);
        if (s.tool)     out.push(`- Tool: ${s.tool}`);
        if (s.whatToDo) out.push(`- ${dec ? "What to determine" : "What to do"}: ${s.whatToDo}`);
        if (s.doneWhen) out.push(`- Done when: ${s.doneWhen}`);
        if (dec) {
          if (s.ifYes) out.push(`- If YES: ${s.ifYes}`);
          if (s.ifNo)  out.push(`- If NO: ${s.ifNo}`);
        }
        if (s.automatable && s.automationNote) {
          out.push(`- Automation opportunity: ${s.automationNote}`);
        }
        out.push("");
      }
    }
    if (Array.isArray(w.qualityChecks) && w.qualityChecks.length) {
      out.push("### Quality Checks");
      out.push("");
      w.qualityChecks.forEach((c) => out.push(`- ${c}`));
      out.push("");
    }
    if (Array.isArray(w.commonMistakes) && w.commonMistakes.length) {
      out.push("### Common Mistakes to Avoid");
      out.push("");
      w.commonMistakes.forEach((m) => out.push(`- ${m}`));
      out.push("");
    }
  }
  return out.join("\n");
}

function gameplanDataToMarkdown(gp) {
  if (!gp) return "";
  const out = [];
  out.push("# Your Practical AI Game Plan");
  out.push("");
  if (gp.whatWeHeard) {
    out.push("## What We Heard");
    out.push("");
    out.push(gp.whatWeHeard);
    out.push("");
  }
  if (Array.isArray(gp.bottlenecks) && gp.bottlenecks.length) {
    out.push("## Where Work Is Getting Stuck");
    out.push("");
    gp.bottlenecks.forEach((b) => {
      out.push(`### ${b.category || ""}`);
      out.push("");
      out.push(b.note || "");
      out.push("");
    });
  }
  if (Array.isArray(gp.topThreeOpportunities) && gp.topThreeOpportunities.length) {
    out.push("## Top 3 AI Opportunities");
    out.push("");
    gp.topThreeOpportunities.forEach((o, i) => {
      out.push(`### Opportunity ${i + 1}: ${o.name || ""}`);
      out.push("");
      if (o.process)              out.push(`**Process:** ${o.process}`);
      if (o.whatItDoes)           out.push(`**What it does:** ${o.whatItDoes}`);
      if (o.whyItMatters)         out.push(`**Why it matters:** ${o.whyItMatters}`);
      if (Array.isArray(o.toolsLikelyInvolved)) out.push(`**Tools likely involved:** ${o.toolsLikelyInvolved.join(", ")}`);
      if (o.difficulty)           out.push(`**Difficulty:** ${o.difficulty}`);
      if (o.impact)               out.push(`**Impact:** ${o.impact}`);
      if (o.confidence)           out.push(`**Confidence:** ${o.confidence}`);
      if (o.suggestedFirstStep)   out.push(`**Suggested first step:** ${o.suggestedFirstStep}`);
      out.push("");
    });
  }
  if (gp.bestFirstBuild) {
    const b = gp.bestFirstBuild;
    out.push("## Best First Build");
    out.push("");
    if (b.name)              out.push(`**The chosen build:** ${b.name}`);
    out.push("");
    if (b.whyFirst)          { out.push(`**Why this comes first:** ${b.whyFirst}`); out.push(""); }
    if (b.whatItSolves)      { out.push(`**What it solves:** ${b.whatItSolves}`); out.push(""); }
    if (b.whatPaicWillBuild) { out.push(`**What we'd build together:** ${b.whatPaicWillBuild}`); out.push(""); }
    if (b.whatsIncluded)     { out.push(`**What's included in the first version:** ${b.whatsIncluded}`); out.push(""); }
    if (b.successLooksLike)  { out.push(`**What success looks like:** ${b.successLooksLike}`); out.push(""); }
  }
  if (gp.whatNotToAutomateYet) {
    out.push("## What We Would Not Automate Yet");
    out.push("");
    out.push(gp.whatNotToAutomateYet);
    out.push("");
  }
  if (gp.thirtyDayPlan) {
    const p = gp.thirtyDayPlan;
    out.push("## Suggested 30-Day Plan");
    out.push("");
    if (p.week1) out.push(`- **Week 1:** ${p.week1}`);
    if (p.week2) out.push(`- **Week 2:** ${p.week2}`);
    if (p.week3) out.push(`- **Week 3:** ${p.week3}`);
    if (p.week4) out.push(`- **Week 4:** ${p.week4}`);
    out.push("");
  }
  if (gp.recommendedNextStep) {
    out.push("## Recommended Next Step");
    out.push("");
    out.push(gp.recommendedNextStep);
    out.push("");
  }
  return out.join("\n");
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

  const sopData = deliverables.sopData || null;
  const gameplanData = deliverables.gameplanData || null;
  const sopMarkdown = sopDataToMarkdown(sopData);
  const gameplanMarkdown = gameplanDataToMarkdown(gameplanData);

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
