// Shared builders for the /capture flow. Used by both /api/capture-complete
// (auto-push on generation) and /api/capture-export (on-demand from the UI).
//
// The leading underscore on the parent folder tells Vercel this is not
// itself a serverless function.

const { Client: NotionClient } = require("@notionhq/client");
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");

const SOP_LIBRARY_DB_ID = "362567cd-8712-8174-982d-ffa3a95e441c";

// ============================================================
// Notion helpers
// ============================================================
function richText(content, max) {
  const s = String(content == null ? "" : content);
  const limit = max || 1900;
  if (s.length <= limit) return [{ type: "text", text: { content: s } }];
  const out = [];
  for (let i = 0; i < s.length; i += limit) {
    out.push({ type: "text", text: { content: s.slice(i, i + limit) } });
  }
  return out;
}
const para     = (t) => ({ object: "block", type: "paragraph",          paragraph:          { rich_text: richText(t) } });
const h2       = (t) => ({ object: "block", type: "heading_2",          heading_2:          { rich_text: richText(t) } });
const h3       = (t) => ({ object: "block", type: "heading_3",          heading_3:          { rich_text: richText(t) } });
const bullet   = (t) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(t) } });
const divider  = ()  => ({ object: "block", type: "divider",            divider: {} });

function buildNotionBlocks(profile, r) {
  const blocks = [];

  if (r.executive_summary) {
    const e = r.executive_summary;
    blocks.push(h2("Executive summary"));
    if (e.biggest_bottleneck)            blocks.push(bullet("Biggest bottleneck: " + e.biggest_bottleneck));
    if (e.biggest_time_drain)            blocks.push(bullet("Biggest time drain: " + e.biggest_time_drain));
    if (e.most_owner_dependent_step)     blocks.push(bullet("Most owner-dependent: " + e.most_owner_dependent_step));
    if (e.most_immediate_ai_opportunity) blocks.push(bullet("Most immediate AI opportunity: " + e.most_immediate_ai_opportunity));
  }

  if (r.recommended_first_build && r.recommended_first_build.title) {
    blocks.push(h2("Start here"));
    blocks.push(h3(r.recommended_first_build.title));
    if (r.recommended_first_build.why_this_first) {
      blocks.push(para(r.recommended_first_build.why_this_first));
    }
    if (r.recommended_first_build.what_practical_ai_would_build) {
      blocks.push(para(r.recommended_first_build.what_practical_ai_would_build));
    }
    if (Array.isArray(r.recommended_first_build.estimated_impact)) {
      r.recommended_first_build.estimated_impact.forEach((i) => blocks.push(bullet(i)));
    }
  }

  if (r.process_summary) {
    blocks.push(divider());
    blocks.push(h2("Overview"));
    blocks.push(para(r.process_summary));
  }

  if (Array.isArray(r.process_steps) && r.process_steps.length) {
    blocks.push(h2("Process steps"));
    r.process_steps.forEach((s) => {
      blocks.push(h3(`Step ${s.step_number}. ${s.title || ""}`));
      if (s.description) blocks.push(para(s.description));
      if (Array.isArray(s.inputs_from) && s.inputs_from.length) {
        blocks.push(para("Inputs from: " + s.inputs_from.join(", ")));
      }
      if (s.people_involved)        blocks.push(bullet("People: " + s.people_involved));
      if (s.tools_used)             blocks.push(bullet("Tools: " + s.tools_used));
      if (s.risk_or_friction)       blocks.push(bullet("Friction: " + s.risk_or_friction));
      if (s.automation_opportunity) blocks.push(bullet("Automation opportunity (see ideas below)"));
    });
  }

  if (Array.isArray(r.process_branches) && r.process_branches.length) {
    blocks.push(h2("Branches"));
    r.process_branches.forEach((b) => {
      blocks.push(h3(`After step ${b.after_step}: ${b.condition || ""}`));
      if (b.yes_path) blocks.push(bullet("If yes: " + b.yes_path));
      if (b.no_path)  blocks.push(bullet("If no: " + b.no_path));
    });
  }

  if (Array.isArray(r.tools_and_systems) && r.tools_and_systems.length) {
    blocks.push(h2("Tools and systems"));
    r.tools_and_systems.forEach((t) => {
      const headline = `${t.tool_name || ""}${t.system_role ? " (" + t.system_role + ")" : ""}`;
      blocks.push(h3(headline));
      if (t.purpose)     blocks.push(bullet("Purpose: " + t.purpose));
      if (t.used_by)     blocks.push(bullet("Used by: " + t.used_by));
      if (t.pain_points) blocks.push(bullet("Pain points: " + t.pain_points));
    });
  }

  if (Array.isArray(r.systems_breakdown) && r.systems_breakdown.length) {
    blocks.push(h2("Where systems break down"));
    r.systems_breakdown.forEach((s) => {
      blocks.push(h3(s.title || ""));
      if (s.description) blocks.push(para(s.description));
      if (s.impact)      blocks.push(bullet("Impact: " + s.impact));
    });
  }

  if (Array.isArray(r.bottlenecks) && r.bottlenecks.length) {
    blocks.push(h2("Where work gets stuck"));
    r.bottlenecks.forEach((b) => {
      blocks.push(h3(b.title || ""));
      if (b.description)    blocks.push(para(b.description));
      if (b.why_it_matters) blocks.push(bullet("Why it matters: " + b.why_it_matters));
    });
  }

  if (Array.isArray(r.owner_dependencies) && r.owner_dependencies.length) {
    blocks.push(h2("Owner dependencies"));
    r.owner_dependencies.forEach((d) => {
      blocks.push(h3(d.title || ""));
      if (d.description) blocks.push(para(d.description));
    });
  }

  if (Array.isArray(r.manual_work) && r.manual_work.length) {
    blocks.push(h2("Manual work"));
    r.manual_work.forEach((m) => {
      blocks.push(h3(m.title || ""));
      if (m.description) blocks.push(para(m.description));
    });
  }

  if (Array.isArray(r.sop_sections) && r.sop_sections.length) {
    blocks.push(divider());
    blocks.push(h2(r.sop_title || "Draft SOP"));
    r.sop_sections.forEach((s) => {
      if (s.section_title) blocks.push(h3(s.section_title));
      if (s.content)       blocks.push(para(s.content));
    });
  }

  if (Array.isArray(r.automation_ideas) && r.automation_ideas.length) {
    blocks.push(divider());
    blocks.push(h2("AI opportunities"));
    r.automation_ideas.forEach((a) => {
      blocks.push(h3(a.title || ""));
      if (a.plain_english_description) blocks.push(para(a.plain_english_description));
      if (a.why_it_matters)            blocks.push(bullet("Why it matters: " + a.why_it_matters));
      if (a.difficulty)                blocks.push(bullet("Difficulty: " + a.difficulty));
      if (a.recommended_process_step)  blocks.push(bullet("Connects to: " + a.recommended_process_step));
      if (a.practical_ai_build_note)   blocks.push(bullet("Practical AI Co.: " + a.practical_ai_build_note));
      if (Array.isArray(a.estimated_impact)) {
        a.estimated_impact.forEach((i) => blocks.push(bullet("Impact: " + i)));
      }
    });
  }

  // Notion caps children at 100 per page-create request
  return blocks.slice(0, 99);
}

async function pushToNotion({ profile, results }) {
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) throw new Error("NOTION_API_KEY not configured");

  const notion = new NotionClient({ auth: notionKey });
  const today = new Date().toISOString().split("T")[0];
  const title =
    (results.sop_title || (profile.processName + " SOP")) +
    (profile.businessName ? " (" + profile.businessName + ")" : "");

  const page = await notion.pages.create({
    parent: { database_id: SOP_LIBRARY_DB_ID },
    properties: {
      "Process Name": { title: richText(title) },
      "Client":       { rich_text: richText(profile.firstName || "") },
      "Business":     { rich_text: richText(profile.businessName || "") },
      "Email":        { email: profile.email || null },
      "Status":       { select: { name: "Draft" } },
      "Last Updated": { date: { start: today } },
    },
    children: buildNotionBlocks(profile, results),
  });
  return { url: page.url, id: page.id };
}

// ============================================================
// Word document
// ============================================================
const h1Para     = (t) => new Paragraph({ text: String(t || ""), heading: HeadingLevel.HEADING_1 });
const h2Para     = (t) => new Paragraph({ text: String(t || ""), heading: HeadingLevel.HEADING_2 });
const h3Para     = (t) => new Paragraph({ text: String(t || ""), heading: HeadingLevel.HEADING_3 });
const pPara      = (t) => new Paragraph({ children: [new TextRun({ text: String(t || "") })] });
const labelPara  = (label, value) => new Paragraph({ children: [
  new TextRun({ text: label + ": ", bold: true }),
  new TextRun({ text: String(value || "") }),
]});
const spacer     = () => new Paragraph({ text: "" });

function buildDocxDocument(profile, r) {
  const c = [];

  c.push(h1Para(r.sop_title || (profile.processName + " SOP")));
  c.push(new Paragraph({ children: [new TextRun({ text: profile.businessName || "", italics: true, color: "666666" })] }));
  c.push(new Paragraph({ children: [new TextRun({ text: "Prepared by Practical AI Co. for " + (profile.firstName || ""), color: "888888", size: 18 })] }));
  c.push(spacer());

  if (r.executive_summary) {
    c.push(h2Para("Executive summary"));
    const e = r.executive_summary;
    if (e.biggest_bottleneck)            c.push(labelPara("Biggest bottleneck", e.biggest_bottleneck));
    if (e.biggest_time_drain)            c.push(labelPara("Biggest time drain", e.biggest_time_drain));
    if (e.most_owner_dependent_step)     c.push(labelPara("Most owner-dependent", e.most_owner_dependent_step));
    if (e.most_immediate_ai_opportunity) c.push(labelPara("Most immediate AI opportunity", e.most_immediate_ai_opportunity));
    c.push(spacer());
  }

  if (r.recommended_first_build && r.recommended_first_build.title) {
    c.push(h2Para("Start here"));
    c.push(h3Para(r.recommended_first_build.title));
    if (r.recommended_first_build.why_this_first) c.push(pPara(r.recommended_first_build.why_this_first));
    if (r.recommended_first_build.what_practical_ai_would_build) c.push(pPara(r.recommended_first_build.what_practical_ai_would_build));
    if (Array.isArray(r.recommended_first_build.estimated_impact)) {
      r.recommended_first_build.estimated_impact.forEach((i) => c.push(labelPara("Impact", i)));
    }
    c.push(spacer());
  }

  if (r.process_summary) {
    c.push(h2Para("Overview"));
    c.push(pPara(r.process_summary));
    c.push(spacer());
  }

  if (Array.isArray(r.process_steps) && r.process_steps.length) {
    c.push(h2Para("Process steps"));
    r.process_steps.forEach((s) => {
      c.push(h3Para(`Step ${s.step_number}. ${s.title || ""}`));
      if (s.description) c.push(pPara(s.description));
      if (Array.isArray(s.inputs_from) && s.inputs_from.length) c.push(labelPara("Inputs from", s.inputs_from.join(", ")));
      if (s.people_involved)        c.push(labelPara("People", s.people_involved));
      if (s.tools_used)             c.push(labelPara("Tools", s.tools_used));
      if (s.risk_or_friction)       c.push(labelPara("Friction", s.risk_or_friction));
      if (s.automation_opportunity) c.push(labelPara("Note", "Automation opportunity (see AI opportunities)"));
      c.push(spacer());
    });
  }

  if (Array.isArray(r.process_branches) && r.process_branches.length) {
    c.push(h2Para("Branches"));
    r.process_branches.forEach((b) => {
      c.push(h3Para(`After step ${b.after_step}: ${b.condition || ""}`));
      if (b.yes_path) c.push(labelPara("If yes", b.yes_path));
      if (b.no_path)  c.push(labelPara("If no", b.no_path));
      c.push(spacer());
    });
  }

  if (Array.isArray(r.tools_and_systems) && r.tools_and_systems.length) {
    c.push(h2Para("Tools and systems"));
    r.tools_and_systems.forEach((t) => {
      c.push(h3Para(`${t.tool_name || ""}${t.system_role ? " (" + t.system_role + ")" : ""}`));
      if (t.purpose)     c.push(labelPara("Purpose", t.purpose));
      if (t.used_by)     c.push(labelPara("Used by", t.used_by));
      if (t.pain_points) c.push(labelPara("Pain points", t.pain_points));
      c.push(spacer());
    });
  }

  if (Array.isArray(r.systems_breakdown) && r.systems_breakdown.length) {
    c.push(h2Para("Where systems break down"));
    r.systems_breakdown.forEach((s) => {
      c.push(h3Para(s.title || ""));
      if (s.description) c.push(pPara(s.description));
      if (s.impact)      c.push(labelPara("Impact", s.impact));
      c.push(spacer());
    });
  }

  if (Array.isArray(r.bottlenecks) && r.bottlenecks.length) {
    c.push(h2Para("Where work gets stuck"));
    r.bottlenecks.forEach((b) => {
      c.push(h3Para(b.title || ""));
      if (b.description)    c.push(pPara(b.description));
      if (b.why_it_matters) c.push(labelPara("Why it matters", b.why_it_matters));
      c.push(spacer());
    });
  }

  if (Array.isArray(r.owner_dependencies) && r.owner_dependencies.length) {
    c.push(h2Para("Owner dependencies"));
    r.owner_dependencies.forEach((d) => {
      c.push(h3Para(d.title || ""));
      if (d.description) c.push(pPara(d.description));
      c.push(spacer());
    });
  }

  if (Array.isArray(r.manual_work) && r.manual_work.length) {
    c.push(h2Para("Manual work"));
    r.manual_work.forEach((m) => {
      c.push(h3Para(m.title || ""));
      if (m.description) c.push(pPara(m.description));
      c.push(spacer());
    });
  }

  if (Array.isArray(r.sop_sections) && r.sop_sections.length) {
    c.push(h2Para("Draft SOP"));
    r.sop_sections.forEach((s) => {
      if (s.section_title) c.push(h3Para(s.section_title));
      if (s.content)       c.push(pPara(s.content));
      c.push(spacer());
    });
  }

  if (Array.isArray(r.automation_ideas) && r.automation_ideas.length) {
    c.push(h2Para("AI opportunities"));
    r.automation_ideas.forEach((a) => {
      c.push(h3Para(a.title || ""));
      if (a.plain_english_description) c.push(pPara(a.plain_english_description));
      if (a.why_it_matters)            c.push(labelPara("Why it matters", a.why_it_matters));
      if (a.difficulty)                c.push(labelPara("Difficulty", a.difficulty));
      if (a.recommended_process_step)  c.push(labelPara("Connects to", a.recommended_process_step));
      if (a.practical_ai_build_note)   c.push(labelPara("Practical AI Co.", a.practical_ai_build_note));
      if (Array.isArray(a.estimated_impact)) {
        a.estimated_impact.forEach((i) => c.push(labelPara("Impact", i)));
      }
      c.push(spacer());
    });
  }

  return new Document({
    creator: "Practical AI Co.",
    title: r.sop_title || (profile.processName + " SOP"),
    sections: [{ children: c }],
  });
}

async function buildDocxBuffer(profile, results) {
  const doc = buildDocxDocument(profile, results);
  return Packer.toBuffer(doc);
}

// ============================================================
// Utilities
// ============================================================
function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function docxFilename(profile) {
  return (slug(profile.businessName) || "process") + "-" +
         (slug(profile.processName)  || "sop") + ".docx";
}

module.exports = {
  pushToNotion,
  buildDocxBuffer,
  docxFilename,
  slug,
};
