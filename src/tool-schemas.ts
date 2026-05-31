import type { ToolDefinition } from "./types.js";

const stringProp = { type: "string" };
const booleanProp = { type: "boolean" };
const numberProp = { type: "number" };
const stringArrayProp = { type: "array", items: stringProp };
const propertyMapProp = { type: "object", additionalProperties: { type: "string" } };

function schema(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  schema("list_pages", "List Logseq pages from frontmatter only.", {
    type_filter: stringProp,
    tag: stringProp,
    include_properties: stringArrayProp,
    include_mtime: booleanProp,
  }),
  schema("read_page", "Read one Logseq page by name.", {
    name: stringProp,
    include_raw: booleanProp,
  }, ["name"]),
  schema("read_pages", "Read multiple Logseq pages.", {
    names: stringArrayProp,
    include_body: booleanProp,
    include_raw: booleanProp,
    body_chars: numberProp,
  }, ["names"]),
  schema("read_journal", "Read one journal entry by date, defaulting to today.", {
    date: stringProp,
  }),
  schema("search", "Search pages and optionally journals.", {
    query: stringProp,
    regex: booleanProp,
    max_results: numberProp,
    offset: numberProp,
    include_journals: booleanProp,
    context_chars: numberProp,
    case_sensitive: booleanProp,
    preserve_newlines: booleanProp,
  }, ["query"]),
  schema("backlinks", "Find pages linking to a target page.", {
    name: stringProp,
    include_aliases: booleanProp,
    limit: numberProp,
    offset: numberProp,
    mode: { type: "string", enum: ["summary", "detail"] },
    context_chars: numberProp,
  }, ["name"]),
  schema("query_pages", "Filter pages by frontmatter properties.", {
    filters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: stringProp,
          op: { type: "string", enum: ["eq", "ne", "lt", "le", "gt", "ge", "contains", "regex", "exists", "missing"] },
          value: stringProp,
        },
        required: ["key", "op"],
        additionalProperties: false,
      },
    },
    type_filter: stringProp,
    tag: stringProp,
    sort_by: stringProp,
    descending: booleanProp,
    limit: numberProp,
    offset: numberProp,
  }),
  schema("graph_status", "Return read-only graph and write-path health.", {
    limit: numberProp,
  }),
  schema("find_orphans", "Find disconnected pages.", {
    include_meta: booleanProp,
    include_redirects: booleanProp,
    limit: numberProp,
  }),
  schema("find_low_degree", "Find pages with low graph degree.", {
    max_degree: numberProp,
    direction: { type: "string", enum: ["in", "out", "total"] },
    include_meta: booleanProp,
    include_redirects: booleanProp,
    limit: numberProp,
  }),
  schema("find_hubs", "Find high-degree graph hubs.", {
    limit: numberProp,
    direction: { type: "string", enum: ["in", "out", "total"] },
    include_meta: booleanProp,
    include_redirects: booleanProp,
  }),
  schema("node_degree", "Return graph degree information for one page.", {
    name: stringProp,
  }, ["name"]),
  schema("graph_stats", "Return graph topology summary.", {
    top_hubs: numberProp,
  }),
  schema("find_components", "Find connected components in the page graph.", {
    include_meta: booleanProp,
    include_redirects: booleanProp,
    min_size: numberProp,
    exclude_main: booleanProp,
    limit: numberProp,
  }),
  schema("find_dangling_links", "Find wikilinks whose targets do not exist.", {
    min_refs: numberProp,
    exclude_namespaces: booleanProp,
    limit: numberProp,
  }),
  schema("update_property", "Set or update one frontmatter property.", {
    name: stringProp,
    key: stringProp,
    value: stringProp,
    force: booleanProp,
    allow_dangling: booleanProp,
  }, ["name", "key", "value"]),
  schema("batch_update_property", "Apply multiple property updates in one guarded transaction.", {
    updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: stringProp,
          key: stringProp,
          value: stringProp,
          allow_dangling: booleanProp,
        },
        required: ["name", "key", "value"],
        additionalProperties: false,
      },
    },
    force: booleanProp,
    allow_dangling: booleanProp,
  }, ["updates"]),
  schema("delete_property", "Remove one frontmatter property.", {
    name: stringProp,
    key: stringProp,
  }, ["name", "key"]),
  schema("append_contact_log", "Append a contact-log bullet and bump last-contacted when newer.", {
    name: stringProp,
    medium: stringProp,
    summary: stringProp,
    date: stringProp,
    duration: stringProp,
    direction: stringProp,
    allow_dangling: booleanProp,
  }, ["name", "medium", "summary"]),
  schema("append_journal_bullet", "Append a bullet to a journal entry.", {
    content: stringProp,
    section: stringProp,
    date: stringProp,
    allow_dangling: booleanProp,
  }, ["content"]),
  schema("create_stub", "Create a new Logseq page stub.", {
    name: stringProp,
    page_type: stringProp,
    properties: propertyMapProp,
    notes: stringArrayProp,
    source: stringProp,
    confidence: stringProp,
    force: booleanProp,
    allow_dangling: booleanProp,
  }, ["name"]),
  schema("rename_page", "Rename a page and optionally leave a redirect stub.", {
    old_name: stringProp,
    new_name: stringProp,
    leave_redirect: booleanProp,
  }, ["old_name", "new_name"]),
  schema("delete_page", "Soft-delete a page into archive/YYYY/MM.", {
    name: stringProp,
    force_if_backlinks: booleanProp,
  }, ["name"]),
  schema("update_body_section", "Update a page body block selected by a unique anchor line.", {
    name: stringProp,
    anchor: stringProp,
    new_content: stringProp,
    mode: { type: "string", enum: ["replace_block", "append_to_section", "prepend_to_section", "delete_block"] },
    allow_dangling: booleanProp,
  }, ["name", "anchor"]),
  schema("regenerate_index", "Regenerate generated/graph_index.json.", {}),
];
