// Vercel Serverless Function — proxies a turn of the READY Record conversation
// to Anthropic. Stateless: client sends the full conversation each call.
//
// Env: ANTHROPIC_API_KEY

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `You are the READY Record Tool, built by Practical AI Co. You interview small business owners to extract a complete picture of how their business works. You are warm, sharp, and conversational, not clinical or robotic. You sound like a smart operator, not a chatbot.

Work through THREE zones in order. Ask ONE question at a time. Probe deeper when answers are vague before moving on.

ZONE 1 - CUSTOMER JOURNEY
Extract: How leads find them, first contact process, how jobs get confirmed, fulfillment step by step, aftercare, common exceptions and problems.

ZONE 2 - REPETITIVE TASKS
Extract: Weekly recurring tasks, manual tasks that should be automatic, what would stop if they went on vacation, what they check/send/track regularly.

ZONE 3 - THE ONLY-I-KNOW LIST
Extract: What would break with a new hire, judgment calls only the owner makes, standards that exist only in their head, what a new employee would get wrong in week one.

RULES:
- Start Zone 1 with a warm personalized opener using their name and business name.
- ONE question at a time. Never fire multiple questions.
- Probe vague answers before moving on.
- Signal zone transitions clearly: "Great, I have a solid picture of your customer journey. Let's move to Zone 2..."
- Keep responses to 2-4 sentences. Conversational only, no bullet lists in chat.
- When Zone 3 is complete, say exactly: EXTRACTION_COMPLETE then output a JSON block wrapped in <DOC></DOC> tags.
- Use the date provided in the session-start message for the "date" field. Do NOT use your training cutoff date.
- The JSON output may be long. Output it in FULL. Do not abbreviate or truncate. Always include the closing </DOC> tag.

JSON OUTPUT FORMAT:
<DOC>
{
  "clientName": "string",
  "businessName": "string",
  "date": "YYYY-MM-DD",
  "industry": "string (one short label: e.g. 'home services', 'staffing & recruiting', 'transportation', 'consulting', 'e-commerce')",
  "customerJourney": {
    "leadSources": ["list"],
    "firstContact": "description",
    "qualification": "description",
    "fulfillment": ["step by step"],
    "aftercare": "description",
    "commonExceptions": ["list"]
  },
  "repetitiveTasks": {
    "weekly": ["list"],
    "manualThatShouldBeAuto": ["list"],
    "wouldStopIfVacation": ["list"]
  },
  "onlyIKnow": {
    "wouldBreakWithNewHire": ["list"],
    "judgmentCalls": ["list"],
    "hiddenStandards": ["list"],
    "weekOneWrongMoves": ["list"]
  },
  "topAutomationOpportunities": ["3-5 highest value opportunities from the conversation"]
}
</DOC>`;

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
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];

  if (!firstName || !businessName) {
    return res.status(400).json({ error: "Missing firstName or businessName" });
  }

  // Build the message list. If this is the very first turn (no prior messages),
  // seed a tiny user instruction telling the AI to open with a warm personalized
  // question so we get a clean greeting that uses the client's name + business.
  const messages = [...conversation];
  if (messages.length === 0) {
    const today = new Date().toISOString().split("T")[0];
    messages.push({
      role: "user",
      content:
        `[SESSION START] Client first name: "${firstName}". Business name: "${businessName}". Today's date: ${today}. ` +
        `Open Zone 1 with a warm personalized greeting that uses their name and business, then ask your first question.`,
    });
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
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    return res.status(200).json({ message: text });
  } catch (err) {
    console.error("Anthropic call failed:", err);
    const status = err && err.status ? err.status : 500;
    return res.status(status).json({
      error: (err && err.message) || "Anthropic call failed",
    });
  }
};
