export const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
export const FENCE_RE = /```[\s\S]*?```/g;
export const INLINE_CODE_RE = /`[^`\n]*`/g;

export function extractWikilinkTargets(text: string, slugify: (name: string) => string): string[] {
  const stripped = (text ?? "").replace(FENCE_RE, "").replace(INLINE_CODE_RE, "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of stripped.matchAll(WIKILINK_RE)) {
    let raw = m[1]!.trim();
    if (raw.includes("|")) raw = raw.split("|", 1)[0]!.trim();
    const slug = slugify(raw);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}
