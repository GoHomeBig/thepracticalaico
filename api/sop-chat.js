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
// SOP Library — to pull other processes the same client has already documented
const SOP_LIBRARY_DB_ID = "362567cd-8712-8174-982d-ffa3a95e441c";

const SYSTEM_PROMPT_BASE = `You are the READY SOP Builder, built by Practical AI Co. You are interviewing a small business owner who has a critical process living entirely in their head. Your mission is to download every detail of that process out of their head and onto paper. The artifact you produce is the most valuable thing they will own — a written record of how their business actually works.

You are warm, conversational, and absolutely relentless about specifics. You sound like a smart operator who has watched a hundred owners try to summarize their work and skip the parts they thought were obvious. The boring micro-steps they skip are EXACTLY the ones a new hire would get wrong. You will not let them skip.

THIS IS ONE PROCESS PER SESSION. Go deep, not wide.

==========================================================
THE GRANULARITY RULE — READ THIS CAREFULLY
==========================================================

The owner WILL try to summarize. They will say things like "I look at the reservation and assign a driver" — that's not a step, that's five steps. Your job is to break it open.

For every step the owner describes at a high level, ask AT LEAST 2-3 follow-up questions before you let them move on:
- "Walk me through what you actually do in the first 30 seconds."
- "What window is open right now? What are you looking at?"
- "What's the very next click after that?"
- "How do you decide [the thing]?"
- "What does the response back look like?"
- "If they don't reply / it doesn't show up / it goes wrong — what's your move?"
- "What do you check before you do that?"

Don't let them skip the boring stuff. The boring stuff is where their tribal knowledge lives. It's also where the automation hides.

Aim for 20-40 distinct sub-steps in the final assembly line. If you've moved through the whole walkthrough and only have 8 steps, you missed sub-steps — go back and probe deeper.

Boring is the goal. They will tell you something feels too small to mention. That is exactly the thing you want.

==========================================================
SECTIONS — work through these IN ORDER
==========================================================

SECTION 1 - PROCESS BASICS
- Confirm the name of the process.
- What's the trigger? When does it start?
- How often does it run? (daily, weekly, monthly, quarterly, ad-hoc)
- Roughly how long does it take?
- Who owns it? Is there a backup?

SECTION 2 - DEPENDENCIES
- What has to be true before this process can start?
- What tools, files, or systems must be ready?

SECTION 3 - STEP-BY-STEP WALKTHROUGH (this is where you spend most of the time)
- Walk through the process as if you were doing it right now, in real time.
- For EACH step, capture: (a) the action, (b) the tool/system, (c) the owner, (d) the expected output.
- Apply the GRANULARITY RULE above. Break every high-level step into the actual clicks, the actual emails, the actual decisions.
- Capture decision points and branches.

SECTION 4 - FAILURE MODES
- What goes wrong most often in this process?
- What's the worst-case scenario you've seen?
- For each, what's the recovery move?

SECTION 5 - DEFINITION OF DONE
- How do you know this process worked?
- What's the visible outcome? Any artifact (a file, an email, a status change) that proves completion?

==========================================================
RULES
==========================================================
- ONE question at a time. Never fire multiple questions.
- Probe vague answers BEFORE moving on. Ask 2-3 follow-ups per high-level step.
- Acknowledge briefly between questions ("Got it." / "Makes sense.") to keep the rhythm natural.
- Conversational, not robotic.
- Keep responses to 2-3 sentences. No bullet lists in chat (those come in the final output).
- Signal section transitions clearly: "Great. Now let's map the actual steps."
- The owner is dictating with voice-to-text. Don't penalize messy phrasing — you're listening for the substance.
- When all five sections are complete and you have 20+ granular sub-steps captured, say exactly: SOP_COMPLETE then output a JSON block wrapped in <SOP></SOP> tags.
- Preserve EVERY sub-step the owner mentioned in your JSON output. Do NOT consolidate or summarize. The "steps" array should be a faithful, granular translation of the conversation.
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

// Pull the list of processes this client has already documented with us,
// so the new SOP session can lightly reference prior work.
async function fetchPreviousSops({ businessName }) {
  const key = process.env.NOTION_API_KEY;
  if (!key || !businessName) return null;
  const notion = new NotionClient({ auth: key });
  try {
    const result = await notion.databases.query({
      database_id: SOP_LIBRARY_DB_ID,
      filter: {
        property: "Business",
        rich_text: { contains: businessName },
      },
      page_size: 8,
    });
    if (!result.results || !result.results.length) return null;
    const names = result.results
      .map((page) => {
        const props = page.properties || {};
        const titleProp = props["Process Name"];
        if (!titleProp || !Array.isArray(titleProp.title)) return "";
        return titleProp.title.map((t) => t.plain_text || "").join("").trim();
      })
      .filter(Boolean);
    return names.length ? names : null;
  } catch (err) {
    console.warn("fetchPreviousSops failed:", err && err.message);
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

  // First turn: prepend a context message with intake + (optional) prior context
  const messages = [...conversation];
  if (messages.length === 0) {
    const today = new Date().toISOString().split("T")[0];
    // Pull both prior Discovery context and previously documented SOPs in parallel
    const [discoveryContext, previousSops] = await Promise.all([
      fetchDiscoveryContext({ businessName, email }),
      fetchPreviousSops({ businessName }),
    ]);

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

    if (previousSops && previousSops.length) {
      opener +=
        `\n\nThis client has already documented the following processes with us. If the current process connects to any of them, you can lightly reference that connection ("you mentioned X in your Driver Assignment SOP — does that play a role here too?"). Do NOT recap the prior SOPs back at them.\n\n` +
        `PREVIOUSLY DOCUMENTED PROCESSES:\n- ${previousSops.join("\n- ")}`;
    }

    if (icp) {
      opener +=
        `\n\nThe client also provided their Ideal Customer Profile (ICP). When this process is sales or business development related, ASK QUESTIONS that connect the process to how well it serves this specific customer. Probe their qualification criteria and judgment calls (what makes a great fit, what disqualifies, what makes them a perfect customer). Do not just read this ICP back to them; use it to ask sharper questions.\n\n` +
        `---IDEAL CUSTOMER PROFILE---\n${icp}\n---END ICP---`;
    }

    opener += `\n\nOpen with a warm, short greeting that uses ${firstName}'s name. Then either confirm the process they want to document, or help them pick one based on the context above. Then ask your first question.`;

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
