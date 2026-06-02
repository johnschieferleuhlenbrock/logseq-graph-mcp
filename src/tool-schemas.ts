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
  annotations: Record<string, unknown> = {},
): ToolDefinition {
  return {
    name,
    description,
    annotations,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const intentToolEnum = [
  "update_property",
  "batch_update_property",
  "delete_property",
  "append_contact_log",
  "append_journal_bullet",
  "create_stub",
  "rename_page",
  "delete_page",
  "update_body_section",
  "regenerate_index",
];

export const READ_TOOL_NAMES = new Set([
  "list_pages",
  "read_page",
  "read_pages",
  "read_journal",
  "search",
  "backlinks",
  "query_pages",
  "graph_status",
  "find_orphans",
  "find_low_degree",
  "find_hubs",
  "node_degree",
  "graph_stats",
  "find_components",
  "find_dangling_links",
]);

export const RAW_MUTATING_TOOL_NAMES = new Set(intentToolEnum);

export const SAFE_WRITE_TOOL_NAMES = new Set([
  "submit_write_intent",
  "flush_write_intents",
  "get_write_intent",
  "list_write_intents",
  "cancel_write_intent",
]);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  schema("list_pages", "List Logseq pages from frontmatter only.", {
    type_filter: stringProp,
    tag: stringProp,
    include_properties: stringArrayProp,
    include_mtime: booleanProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("read_page", "Read one Logseq page by name.", {
    name: stringProp,
    include_raw: booleanProp,
  }, ["name"], { readOnlyHint: true, openWorldHint: false }),
  schema("read_pages", "Read multiple Logseq pages.", {
    names: stringArrayProp,
    include_body: booleanProp,
    include_raw: booleanProp,
    body_chars: numberProp,
  }, ["names"], { readOnlyHint: true, openWorldHint: false }),
  schema("read_journal", "Read one journal entry by date, defaulting to today.", {
    date: stringProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("search", "Search pages and optionally journals.", {
    query: stringProp,
    regex: booleanProp,
    max_results: numberProp,
    offset: numberProp,
    include_journals: booleanProp,
    context_chars: numberProp,
    case_sensitive: booleanProp,
    preserve_newlines: booleanProp,
  }, ["query"], { readOnlyHint: true, openWorldHint: false }),
  schema("backlinks", "Find pages linking to a target page.", {
    name: stringProp,
    include_aliases: booleanProp,
    limit: numberProp,
    offset: numberProp,
    mode: { type: "string", enum: ["summary", "detail"] },
    context_chars: numberProp,
  }, ["name"], { readOnlyHint: true, openWorldHint: false }),
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
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("graph_status", "Return read-only graph and write-path health.", {
    limit: numberProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("find_orphans", "Find disconnected pages.", {
    include_meta: booleanProp,
    include_redirects: booleanProp,
    limit: numberProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("find_low_degree", "Find pages with low graph degree.", {
    max_degree: numberProp,
    direction: { type: "string", enum: ["in", "out", "total"] },
    include_meta: booleanProp,
    include_redirects: booleanProp,
    limit: numberProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("find_hubs", "Find high-degree graph hubs.", {
    limit: numberProp,
    direction: { type: "string", enum: ["in", "out", "total"] },
    include_meta: booleanProp,
    include_redirects: booleanProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("node_degree", "Return graph degree information for one page.", {
    name: stringProp,
  }, ["name"], { readOnlyHint: true, openWorldHint: false }),
  schema("graph_stats", "Return graph topology summary.", {
    top_hubs: numberProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("find_components", "Find connected components in the page graph.", {
    include_meta: booleanProp,
    include_redirects: booleanProp,
    min_size: numberProp,
    exclude_main: booleanProp,
    limit: numberProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("find_dangling_links", "Find wikilinks whose targets do not exist.", {
    min_refs: numberProp,
    exclude_namespaces: booleanProp,
    limit: numberProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("submit_write_intent", "Durably record a validated Logseq write intent without mutating the graph.", {
    idempotency_key: stringProp,
    tool: { type: "string", enum: intentToolEnum },
    arguments: { type: "object", additionalProperties: true },
    caller: stringProp,
    expected_base_head: stringProp,
    expires_at: stringProp,
  }, ["idempotency_key", "tool", "arguments"], { destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  schema("flush_write_intents", "Apply explicit durable write intents under git guard and record per-intent results.", {
    intent_ids: stringArrayProp,
    max_items: numberProp,
  }, ["intent_ids"], { destructiveHint: true, openWorldHint: false }),
  schema("get_write_intent", "Return one durable write intent by intent id.", {
    intent_id: stringProp,
  }, ["intent_id"], { readOnlyHint: true, openWorldHint: false }),
  schema("list_write_intents", "List durable write intents with optional state filters.", {
    states: stringArrayProp,
    limit: numberProp,
    offset: numberProp,
  }, [], { readOnlyHint: true, openWorldHint: false }),
  schema("cancel_write_intent", "Cancel a pending, retryable, or manual-review write intent.", {
    intent_id: stringProp,
    caller: stringProp,
  }, ["intent_id"], { destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  schema("update_property", "Set or update one frontmatter property.", {
    name: stringProp,
    key: stringProp,
    value: stringProp,
    force: booleanProp,
    allow_dangling: booleanProp,
  }, ["name", "key", "value"], { destructiveHint: true, openWorldHint: false }),
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
  }, ["updates"], { destructiveHint: true, openWorldHint: false }),
  schema("delete_property", "Remove one frontmatter property.", {
    name: stringProp,
    key: stringProp,
  }, ["name", "key"], { destructiveHint: true, openWorldHint: false }),
  schema("append_contact_log", "Append a contact-log bullet and bump last-contacted when newer.", {
    name: stringProp,
    medium: stringProp,
    summary: stringProp,
    date: stringProp,
    duration: stringProp,
    direction: stringProp,
    allow_dangling: booleanProp,
  }, ["name", "medium", "summary"], { destructiveHint: false, openWorldHint: false }),
  schema("append_journal_bullet", "Append a bullet to a journal entry.", {
    content: stringProp,
    section: stringProp,
    date: stringProp,
    allow_dangling: booleanProp,
  }, ["content"], { destructiveHint: false, openWorldHint: false }),
  schema("create_stub", "Create a new Logseq page stub.", {
    name: stringProp,
    page_type: stringProp,
    properties: propertyMapProp,
    notes: stringArrayProp,
    source: stringProp,
    confidence: stringProp,
    force: booleanProp,
    allow_dangling: booleanProp,
  }, ["name"], { destructiveHint: false, openWorldHint: false }),
  schema("rename_page", "Rename a page and optionally leave a redirect stub.", {
    old_name: stringProp,
    new_name: stringProp,
    leave_redirect: booleanProp,
  }, ["old_name", "new_name"], { destructiveHint: true, openWorldHint: false }),
  schema("delete_page", "Soft-delete a page into archive/YYYY/MM.", {
    name: stringProp,
    force_if_backlinks: booleanProp,
  }, ["name"], { destructiveHint: true, openWorldHint: false }),
  schema("update_body_section", "Update a page body block selected by a unique anchor line.", {
    name: stringProp,
    anchor: stringProp,
    new_content: stringProp,
    mode: { type: "string", enum: ["replace_block", "append_to_section", "prepend_to_section", "delete_block"] },
    allow_dangling: booleanProp,
  }, ["name", "anchor"], { destructiveHint: true, openWorldHint: false }),
  schema("regenerate_index", "Regenerate generated/graph_index.json.", {}, [], { destructiveHint: false, openWorldHint: false }),
];

export function toolDefinitionsForMode(writeMode: string, readonlyMode: boolean): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((definition) => {
    if (READ_TOOL_NAMES.has(definition.name)) return true;
    if (readonlyMode || writeMode === "readonly") return false;
    if (SAFE_WRITE_TOOL_NAMES.has(definition.name)) return true;
    if (RAW_MUTATING_TOOL_NAMES.has(definition.name)) return writeMode === "admin_raw";
    return false;
  });
}
