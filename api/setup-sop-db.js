// ONE-SHOT SETUP ENDPOINT — creates the SOP Library database in Notion.
// Token-gated so it cannot be triggered by random visitors.
// SAFE TO REMOVE after the SOP Library DB ID has been wired into sop-complete.js.
//
// Usage:
//   GET /api/setup-sop-db?token=sop-init-go
//
// Returns the new database ID and Notion URL.

const { Client: NotionClient } = require("@notionhq/client");

const TOKEN = "sop-init-go";
const PARENT_PAGE_ID = "362567cd-8712-80f6-8cad-c9c355f2cfc7";

module.exports = async (req, res) => {
  const token = (req.query && req.query.token) || (req.body && req.body.token);
  if (token !== TOKEN) {
    return res.status(401).json({ error: "Invalid or missing token" });
  }

  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "NOTION_API_KEY not set" });
  }

  const notion = new NotionClient({ auth: apiKey });

  // Note: Notion's `status` property type cannot be CREATED via the API
  // (it can only be read on existing databases). We use Select for Status
  // here; sop-complete.js already falls back from status to select.
  const properties = {
    "Process Name": { title: {} },
    "Client": { rich_text: {} },
    "Business": { rich_text: {} },
    "Email": { email: {} },
    "Frequency": {
      select: {
        options: [
          { name: "Daily", color: "blue" },
          { name: "Weekly", color: "green" },
          { name: "Monthly", color: "yellow" },
          { name: "Quarterly", color: "orange" },
          { name: "Ad-hoc", color: "gray" },
        ],
      },
    },
    "Owner": { rich_text: {} },
    "Backup": { rich_text: {} },
    "Estimated Time": { rich_text: {} },
    "Status": {
      select: {
        options: [
          { name: "Draft", color: "gray" },
          { name: "Active", color: "green" },
          { name: "Needs Review", color: "yellow" },
        ],
      },
    },
    "Last Updated": { date: {} },
  };

  try {
    const db = await notion.databases.create({
      parent: { type: "page_id", page_id: PARENT_PAGE_ID },
      title: [{ type: "text", text: { content: "SOP Library" } }],
      properties,
    });

    return res.status(200).json({
      ok: true,
      databaseId: db.id,
      url: db.url,
      next: "Send the databaseId value back to Claude in chat to finish wiring.",
    });
  } catch (err) {
    console.error("Create SOP Library DB failed:", err);
    return res.status(500).json({
      error: err.message || "Create failed",
      hint:
        "Most likely: the Practical AI Co. integration is not yet connected to the parent page. " +
        "Open the parent page in Notion → ⋯ menu → Connections → Add connections → Practical AI Co.",
    });
  }
};
