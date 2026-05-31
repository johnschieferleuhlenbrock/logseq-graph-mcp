import type { Frontmatter } from "../types.js";

export const PROP_RE = /^([a-zA-Z][\w-]*?)::\s*(.*?)\s*$/;

export function splitFrontmatter(text: string): [Frontmatter, string] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const props: Frontmatter = [];
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") {
      bodyStart = i + 1;
      break;
    }
    const m = PROP_RE.exec(line.replace(/\r?\n$/, ""));
    if (m) {
      props.push([m[1]!, m[2]!]);
      bodyStart = i + 1;
    } else {
      bodyStart = i;
      break;
    }
  }
  return [props, lines.slice(bodyStart).join("")];
}

export function propsDict(props: Frontmatter): Record<string, string> {
  return Object.fromEntries(props);
}

export function joinFrontmatter(props: Frontmatter, body: string): string {
  let head = props.map(([k, v]) => `${k}:: ${v}\n`).join("");
  if (head && body && !body.startsWith("\n")) head += "\n";
  return head + body;
}

export function propsSet(props: Frontmatter, key: string, value: string): Frontmatter {
  let seen = false;
  const out: Frontmatter = [];
  for (const [k, v] of props) {
    if (k === key && !seen) {
      out.push([k, value]);
      seen = true;
    } else if (k !== key) {
      out.push([k, v]);
    }
  }
  if (!seen) out.push([key, value]);
  return out;
}

export function propsDelete(props: Frontmatter, key: string): [Frontmatter, string | undefined] {
  let removed: string | undefined;
  const out: Frontmatter = [];
  for (const [k, v] of props) {
    if (k === key) removed = v;
    else out.push([k, v]);
  }
  return [out, removed];
}
