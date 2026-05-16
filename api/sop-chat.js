// Vercel Serverless Function — single turn of the SOP Builder conversation.
// Pulls Discovery context from Notion's PAIC Service Lab on the first turn (if
// a matching business is found there) so the AI can recommend the right
// process to document.
//
// Env: ANTHROPIC_API_KEY, NOTION_API_KEY

const Anthropic = require("@anthropic-ai/sdk");
const { Client: NotionClient } = require("@notionhq/client");

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 8192;

// Discovery DB (PAIC Service Lab) — for pulling prior context
const DISCOVERY_DB_ID = "41707d89-4890-4670-b59c-fafc78d3f1e2";

const SYSTEM_PROMPT_BASE = `You are the READY SOP Builder, built by Practical AI Co. You interview small business owners and help them turn ONE business process into a runnable SOP — a document detailed enough that a new hire could execute the process without asking questions.

You are warm but precise. You sound like a smart operator who has watched a hundred processes get half-documented and then break. You probe for specificity. You never accept "we just send a follow-up email." You push: which tool, what trigger, what template, what if no response, when do you escalate.

THIS IS ONE PROCESS PER SESSION. Go deep, not wide.

Work through these sections IN ORDER. Ask ONE question at a time.

SECTION 1 - PROCESS BASICS
- Confirm the name of the process.
- What's the trigger? When does it start?
- How often does it run? (daily, weekly, monthly, quarterly, ad-hoc)
- Roughly how long does it take?
- Who owns it? Is there a backup?

SECTION 2 - DEPENDENCIES
- What has to be true before this process can start?
- What tools, files, or systems must be ready?

SECTION 3 - STEP-BY-STEP WALKTHROUGH
- Walk through the process as if you were doing it right now, step by step.
- For EACH step, capture: (a) the action, (b) the tool/system, (c) the owner, (d) the expected output.
- If a step is vague, push back specifically. "What does 'follow up' mean? Are you in Gmail? Are you logged into a CRM?"
- Capture decision points: "If X happens, what do you do? Is that a different path?"

SECTION 4 - FAILURE MODES
- What goes wrong most often in this process?
- What's the worst-case scenario you've seen?
- For each, what's the recovery move?

SECTION 5 - DEFINITION OF DONE
- How do you know this process worked?
- What's the visible outcome? Any artifact (a file, an email, a status change) that proves completion?

RULES:
- ONE question at a time. Never fire multiple questions.
- Probe vague answers BEFORE moving on. Ask the follow-up.
- Acknowledge briefly between questions ("Got it." / "Makes sense.") to keep the rhythm natural.
- Conversational, not robotic.
- Keep responses to 2-3 sentences. No bullet lists in chat (those come in the final output).
- Signal section transitions clearly: "Great. Now let's map the actual steps."
- When all five sections are complete, say exactly: SOP_COMPLETE then output a JSON block wrapped in <SOP></SOP> tags.
- Use the date provided in the session-start message for the "date" field. Do NOT use your training cutoff date.
- The JSON output may be long. Output it in FULL. Do not abbreviate or truncate. Always include the closing </SOP> tag.

JSON OUTPUT FORMAT:
<SOP>
{
  "processName": "string",
  "client": {
    "firstName": "string",
    "businessName": "string",
    "email": "string"
  },
  "date": "YYYY-MM-DD",
  "trigger": "what starts this process",
  "frequency": "Daily | Weekly | Monthly | Quarterly | Ad-hoc",
  "estimatedTime": "e.g. '30 minutes' or '2 hours'",
  "owner": "person or role",
  "backup": "person or role, or 'none'",
  "dependencies": ["list of preconditions"],
  "steps": [
    {
      "n": 1,
      "action": "what happens",
      "tool": "which tool or system",
      "owner": "who does it",
      "output": "what this step produces (or null)",
      "branches": [
        {"if": "condition", "then": "alternate action"}
      ]
    }
  ],
  "decisions": [
    {"if": "condition", "then": "what to do"}
  ],
  "failureModes": [
    {"issue": "what goes wrong", "recovery": "what to do"}
  ],
  "definitionOfDone": "how you know it worked"
}
</SOP>`;

async function fetchDiscoveryContext({ businessName, email }) {
  const key = process.env.NOTION_API_KEY;
  if (!key || !businessName) return null;
  const notion = new NotionClient({ auth: key });
  try {
    const result = await notion.databases.query({
      database_id: DISCOVERY_DB_ID,
      filter: {
        property: "Business",
        rich_text: { contains: businessName },
      },
      page_size: 1,
      sorts: [{ property: "Discovery Date", direction: "descending" }],
    });
    if (!result.results || !result.results.length) return null;
    const page = result.results[0];
    const props = page.properties || {};
    // Pull the Notes property as plain text
    const notesProp = props.Notes;
    if (!notesProp || !Array.isArray(notesProp.rich_text)) return null;
    const notesText = notesProp.rich_text.map((rt) => rt.plain_text || "").join("");
    if (!notesText.trim()) return null;
    // Trim to roughly 2000 chars to keep prompt size reasonable
    return notesText.length > 2400 ? notesText.slice(0, 2400) + "..." : notesText;
  } catch (err) {
    console.warn("fetchDiscoveryContext failed:", err && err.message);
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const firstName = (body.firstName || "").toString().trim();
  const businessName = (body.businessName || "").toString().trim();
  const email = (body.email || "").toString().trim();
  const processName = (body.processName || "").toString().trim();
  const icp = (body.icp || "").toString().slice(0, 6000).trim();
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];

  if (!firstName || !businessName) {
    return res.status(400).json({ error: "Missing firstName or businessName" });
  }

  // First turn: prepend a context message with intake + (optional) Discovery context
  const messages = [...conversation];
  if (messages.length === 0) {
    const today = new Date().toISOString().split("T")[0];
    const discoveryContext = await fetchDiscoveryContext({ businessName, email });

    let opener =
      `[SESSION START] Client first name: "${firstName}". Business name: "${businessName}". Email: "${email}". Today's date: ${today}.`;

    if (processName) {
      opener += ` The client has already told us the process they want to document: "${processName}". Confirm that's what we're capturing, then move into Section 1 (Process Basics).`;
    } else {
      opener += ` The client has NOT chosen a process yet. Help them pick one to document.`;
    }

    if (discoveryContext) {
      opener +=
        `\n\nWe have prior Discovery context for this business. Use it to inform your questions and to suggest the best process to document if the client did not pick one. Do NOT regurgitate the document at them. Reference it lightly.\n\n` +
        `---DISCOVERY CONTEXT---\n${discoveryContext}\n---END DISCOVERY CONTEXT---`;
    } else {
      opener += `\n\nNo prior Discovery session was found for this business. Proceed without it.`;
    }

    if (icp) {
      opener +=
        `\n\nThe client also provided their Ideal Customer Profile (ICP). When this process is sales or business development related, ASK QUESTIONS that connect the process to how well it serves this specific customer. Probe their qualification criteria and judgment calls (what makes a great fit, what disqualifies, what makes them a perfect customer). Do not just read this ICP back to them; use it to ask sharper questions.\n\n` +
        `---IDEAL CUSTOMER PROFILE---\n${icp}\n---END ICP---`;
    }

    opener += `\n\nOpen with a warm, short greeting that uses ${firstName}'s name. Then either confirm the process they want to document, or help them pick one based on the Discovery context (if available). Then ask your first question.`;

    messages.push({ role: "user", content: opener });
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT_BASE,
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: (m.content || "").toString(),
      })),
    });

    const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    return res.status(200).json({ message: text });
  } catch (err) {
    console.error("Anthropic SOP call failed:", err);
    const status = err && err.status ? err.status : 500;
    return res.status(status).json({ error: (err && err.message) || "Anthropic call failed" });
  }
};
