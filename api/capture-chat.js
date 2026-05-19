// Vercel Serverless Function. One Claude turn for the /capture interview.
// Receives the conversation so far and returns the next assistant message.
// When the assistant has enough information, it ends its message with the
// marker INTERVIEW_COMPLETE on a line by itself.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a thoughtful operational consultant helping a small business owner map one of their workflows for Practical AI Co.

You are NOT running a survey. You are a curious peer who wants to understand how the work actually happens today, in plain English.

CONVERSATIONAL RULES
- Ask ONE question at a time. Never stack two or three questions in one turn.
- Use plain English. No jargon, no corporate phrases, no consultant lingo.
- Never use em dashes. Use periods, commas, parentheses, or simple hyphens.
- Be warm, calm, and specific. Sound like a smart friend at a kitchen table.
- When something is vague or unclear, ask a quick follow-up. Do not fake understanding.
- When the owner describes one path, probe for alternate paths (urgent versus standard, new customer versus repeat, in-person versus remote, etc.).
- When the owner describes a step, naturally find out what tool they use, where the information lives, who handles it, what makes it slow.
- Naturally uncover shadow systems (the official tool versus what they actually rely on).
- Do NOT ask "what software do you use" as a flat question. Discover it through the conversation.
- Do not lecture. Do not summarize back too soon.
- Never make the owner feel disorganized or behind. This is normal small-business reality.

WHAT YOU ARE QUIETLY TRYING TO UNDERSTAND
- Where the work enters the business and what triggers it.
- The step-by-step path, including branches and conditions.
- Alternate paths and merge points where paths come back together.
- Handoffs between people.
- Which tools touch the process and where humans bridge them manually.
- Repeated questions, duplicated work, copy-paste between systems.
- Where the owner has to step in to keep things moving.
- Bottlenecks, delays, points of friction.
- Places where AI or automation could remove obvious busywork.

PACING
- Aim for 12 to 22 exchanges. Stop earlier if you have what you need.
- You have enough when you can describe: the main flow, at least one branch or alternate path, the tools involved, where the owner steps in, and two or three concrete friction points.

HOW TO END
- When you have enough, write a warm 2 to 3 sentence summary of what you understand so far. Speak directly to the owner.
- Then on a new line by itself, write exactly: INTERVIEW_COMPLETE
- Do not write anything after the marker.

HOW TO START (your very first message)
- Brief warm greeting using the owner's first name and the process name.
- Then one specific opening question that gets them describing the process from the start.
- Conversational, not corporate.

The owner's context (name, business, process) is in the first user message.`;

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

  if (!profile.processName) {
    return res.status(400).json({ error: "Missing process name" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const anthropic = new Anthropic({ apiKey });

  const intro =
    `I'm ${profile.firstName || "the owner"}` +
    (profile.businessName ? ` from ${profile.businessName}` : "") +
    `. I want to map our "${profile.processName}" process so we can find places to clean it up.`;

  const messages = [{ role: "user", content: intro }];
  conversation.forEach((m) => {
    if (m && (m.role === "assistant" || m.role === "user") && m.content) {
      messages.push({ role: m.role, content: String(m.content) });
    }
  });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    });
    const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return res.status(200).json({ message: text });
  } catch (err) {
    console.error("capture-chat error:", err);
    return res.status(500).json({ error: err.message || "Chat failed" });
  }
};
