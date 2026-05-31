export const SAFE_NAME_RE = /^[\w\s.,&()'+!@-]+$/u;
export const SAFE_DATE_RE = /^\d{4}[-_]\d{2}[-_]\d{2}$/;

export function slugifyPageName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

export function normalizeNamespaceName(name: string): string {
  return name.replaceAll("/", "___");
}

export function safePageName(name: string, kind = "page"): string | null {
  if (!name) return `${kind} name is required`;
  if (name.length > 200) return `${kind} name too long (max 200 chars)`;
  if (name.includes("\0")) return `${kind} name contains NUL byte`;
  if (name.includes("/") || name.includes("\\")) return `${kind} name contains path separator`;
  if (name.includes("..")) return `${kind} name contains '..'`;
  if (name.trim() !== name) return `${kind} name has leading or trailing whitespace`;
  if (name.startsWith(".")) return `${kind} name cannot start with '.'`;
  if (!SAFE_NAME_RE.test(name)) return `${kind} name contains disallowed characters`;
  return null;
}

export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

export function toJournalDate(date: string): string {
  return date.replaceAll("-", "_");
}

export function fromJournalDate(date: string): string {
  return date.replaceAll("_", "-");
}

