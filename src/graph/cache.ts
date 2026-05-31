import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GraphNode } from "../types.js";
import { atomicWriteFileSync } from "./write-guards.js";

export type PageFingerprint = {
  path: string;
  mtimeMs: number;
  size: number;
};

type FrontmatterCacheEntry = {
  fingerprint: PageFingerprint;
  properties: Record<string, string>;
};

type SerializableGraphNode = {
  slug: string;
  name: string;
  path: string;
  type: string | null;
  is_redirect: boolean;
  redirects_to: string | null;
  in_edges: string[];
  out_edges: string[];
};

type CacheShape = {
  version: 1;
  root: string;
  frontmatter: Record<string, FrontmatterCacheEntry>;
  adjacency?: {
    fingerprint: string;
    nodes: SerializableGraphNode[];
  };
};

export function pageFingerprint(filePath: string): PageFingerprint | null {
  try {
    const st = fs.statSync(filePath);
    return { path: filePath, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function fingerprintKey(fingerprints: PageFingerprint[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(fingerprints.map((f) => [f.path, f.mtimeMs, f.size]).sort()))
    .digest("hex");
}

export class PersistentGraphCache {
  readonly cacheFile: string;
  private state: CacheShape;
  private dirty = false;

  constructor(root: string, cacheDir?: string) {
    const base = cacheDir ?? path.join(os.homedir(), ".cache", "logseq-mcp");
    const id = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
    this.cacheFile = path.join(base, `${id}.json`);
    this.state = this.load(root);
  }

  getFrontmatter(filePath: string, fingerprint: PageFingerprint): Record<string, string> | null {
    const entry = this.state.frontmatter[filePath];
    if (!entry) return null;
    if (entry.fingerprint.mtimeMs !== fingerprint.mtimeMs || entry.fingerprint.size !== fingerprint.size) return null;
    return { ...entry.properties };
  }

  setFrontmatter(filePath: string, fingerprint: PageFingerprint, properties: Record<string, string>): void {
    this.state.frontmatter[filePath] = { fingerprint, properties };
    this.dirty = true;
  }

  getAdjacency(fingerprint: string): Map<string, GraphNode> | null {
    if (this.state.adjacency?.fingerprint !== fingerprint) return null;
    const nodes = new Map<string, GraphNode>();
    for (const row of this.state.adjacency.nodes) {
      nodes.set(row.slug, {
        name: row.name,
        path: row.path,
        type: row.type,
        is_redirect: row.is_redirect,
        redirects_to: row.redirects_to,
        in_edges: new Set(row.in_edges),
        out_edges: new Set(row.out_edges),
      });
    }
    return nodes;
  }

  setAdjacency(fingerprint: string, nodes: Map<string, GraphNode>): void {
    this.state.adjacency = {
      fingerprint,
      nodes: Array.from(nodes.entries()).map(([slug, node]) => ({
        slug,
        name: node.name,
        path: node.path,
        type: node.type,
        is_redirect: node.is_redirect,
        redirects_to: node.redirects_to,
        in_edges: Array.from(node.in_edges).sort(),
        out_edges: Array.from(node.out_edges).sort(),
      })),
    };
    this.dirty = true;
  }

  invalidate(): void {
    this.state.adjacency = undefined;
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    atomicWriteFileSync(this.cacheFile, `${JSON.stringify(this.state, null, 2)}\n`);
    this.dirty = false;
  }

  private load(root: string): CacheShape {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")) as CacheShape;
      if (parsed.version === 1 && parsed.root === path.resolve(root) && parsed.frontmatter) return parsed;
    } catch {
      // rebuild
    }
    return { version: 1, root: path.resolve(root), frontmatter: {} };
  }
}
