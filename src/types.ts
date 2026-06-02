export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ToolResult = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

export type Frontmatter = Array<[string, string]>;

export type StatusEntry = {
  status: string;
  path: string;
  old_path: string;
};

export type GraphNode = {
  name: string;
  path: string;
  type: string | null;
  is_redirect: boolean;
  redirects_to: string | null;
  in_edges: Set<string>;
  out_edges: Set<string>;
};

export type ToolDefinition = {
  name: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  outputSchema?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};
