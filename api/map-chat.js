// Vercel Serverless Function. Single turn of the per-workflow interview
// for the Practical AI Co. discovery and mapping tool at /map.
//
// Cost control: this endpoint is the ONLY API call during the interview.
// The frontend buffers user input client-side. We do not call Anthropic
// per keystroke. The model emits WORKFLOW_SUMMARY_BELOW once it has
// enough to write a workflow summary, and the frontend uses that as
// the trigger to move to the next workflow.
//
// Env: ANTHROPIC_API_KEY

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are the discovery and process documentation engine for Practical AI Co.

Practical AI Co. is a small business AI shop in Franklin, TN. We help small business owners get the way their business actually works out of their heads, organized clearly, and then identify the best places where AI and automation can help. We are warm, simple, and practical. We do not use jargon. We do not make business owners feel behind or disorganized.

You are interviewing a business owner who has already completed a 45-minute discovery call with Practical AI Co. You are documenting ONE workflow at a time. By the end of this conversation you must have enough detail to write a useful Standard Operating Procedure for this workflow.

==========================================================
INTERVIEW GUIDANCE
==========================================================

Cover these topics during the conversation. Do NOT march through them as a checklist. Weave naturally. The goal is depth, not interrogation.

1. Workflow overview: the goal, when it starts, when it ends, who owns it, who else is involved.
2. Inputs: what information starts the process, where it comes from, what tools or documents are involved.
3. Step-by-step process: what happens first, next, next. Probe for the actual clicks, tools, emails, and decisions. If the owner says "I look at the lead and decide," that is five steps. Break it open.
4. Handoffs: who passes work to whom, where the handoff happens, what usually gets missed.
5. Tools and systems: what tools, where the source of truth lives, any duplicate entries or shadow spreadsheets.
6. Exceptions and edge cases: what happens when things go wrong, what requires owner approval or judgment.
7. Pain points: where the process slows down, where things fall through the cracks, what frustrates the owner, team, and customer.
8. Repeated tasks: what gets copied and pasted, what messages, updates, reports get repeated.
9. Current quality check: how the owner knows the process was done correctly.
10. Desired future state: what a smoother version would look like.

==========================================================
TONE AND STYLE
==========================================================

- Warm, simple, encouraging. A little fun. Plain English.
- One question or one small group of related questions at a time. Never fire 5 questions at once.
- Acknowledge briefly between questions ("Got it." / "Makes sense." / "OK, that helps.")
- When the owner gives vague answers, probe specifically. "What does 'follow up' look like? Are you in Gmail? Are you writing it fresh each time?"
- Push for granular sub-steps. Owners want to summarize. Don't let them.
- Aim for 10 to 20 turns total for this workflow. Quality over quantity.
- The owner may be dictating with voice-to-text. Don't penalize messy phrasing.
- NEVER use em dashes. Use periods, commas, colons, or simple words instead.
- NEVER make the owner feel disorganized.
- Do not jump to automation ideas yet. We are documenting first.

==========================================================
WORKFLOW COMPLETION
==========================================================

When you have enough detail to write a useful SOP for this workflow (covered enough of the 10 topics, captured granular sub-steps, exceptions, tools, pain points), end the conversation by:

1. Saying one warm transition sentence (for example: "OK, I think I have a really clear picture of this one. Let me give you a quick summary.").
2. On a new line, output the marker word exactly:
WORKFLOW_SUMMARY_BELOW
3. Then write a 4 to 8 sentence summary of the workflow in plain English. Mention the trigger, the major steps in order, the tools, the owners, the most painful part, and what the owner said they'd love to stop doing manually. Keep this human and warm. No bullet points in the summary. No headings. Just clear flowing sentences the owner can read and confirm.

Do not write the summary until you are genuinely ready to wrap this workflow. Better to ask one more good question than to summarize too early.

==========================================================
OUTPUT
==========================================================

Per turn: 2 to 4 sentences of conversational response. End with one question, or with the workflow summary if it is time.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const profile = body.profile || {};
  const workflowKey = (body.workflowKey || "").toString();
  const workflowLabel = (body.workflowLabel || "this workflow").toString();
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];
  const workflowIndex = Number.isFinite(body.workflowIndex) ? body.workflowIndex : 0;
  const workflowCount = Number.isFinite(body.workflowCount) ? body.workflowCount : 1;
  const allWorkflows = Array.isArray(body.allWorkflows) ? body.allWorkflows : [];

  const messages = [...conversation];

  if (messages.length === 0) {
    // First turn for this workflow: inject context + opening prompt
    const today = new Date().toISOString().split("T")[0];
    const profileSummary = [
      profile.businessName ? `Business: ${profile.businessName}` : null,
      profile.industry ? `Industry: ${profile.industry}` : null,
      profile.teamSize ? `Team size: ${profile.teamSize}` : null,
      profile.customerType ? `Main customer: ${profile.customerType}` : null,
      profile.services ? `Services/products: ${profile.services}` : null,
      profile.tools ? `Tools: ${profile.tools}` : null,
      profile.firstName ? `Owner first name: ${profile.firstName}` : null,
      profile.role ? `Owner role: ${profile.role}` : null,
      profile.headache ? `Biggest operational headache today: ${profile.headache}` : null,
    ].filter(Boolean).join("\n");

    const isFirstWorkflow = workflowIndex === 0;
    const remaining = workflowCount - 1 - workflowIndex;

    let opener = `[SESSION CONTEXT] Today: ${today}.\n\n${profileSummary}\n\n`;
    opener += `We're mapping the workflow: "${workflowLabel}".\n\n`;
    if (allWorkflows.length > 1) {
      opener += `This is workflow ${workflowIndex + 1} of ${workflowCount}. The full list they picked: ${allWorkflows.join(", ")}.\n\n`;
    }
    if (isFirstWorkflow) {
      opener += `This is the FIRST workflow we're mapping in this session. Open warmly. Use ${profile.firstName || "their"} name once. Acknowledge that they took the time to do this discovery. Then ask your first question about "${workflowLabel}". The first question should be a soft, open one (e.g. "Walk me through what kicks this off" or "When does this process usually start?"). Do not list off all the topics you'll cover.`;
    } else {
      opener += `This is workflow ${workflowIndex + 1} of ${workflowCount} in this session. Acknowledge the transition briefly ("OK, on to ${workflowLabel}.") and open with your first question. Do not re-introduce yourself.`;
    }
    if (remaining > 0) {
      opener += `\n\nKeep this workflow tight: 10 to 15 turns. ${remaining} more workflow${remaining === 1 ? "" : "s"} after this one.`;
    }

    messages.push({ role: "user", content: opener });
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
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
    console.error("map-chat Anthropic call failed:", err);
    const status = err && err.status ? err.status : 500;
    return res.status(status).json({ error: (err && err.message) || "Anthropic call failed" });
  }
};
