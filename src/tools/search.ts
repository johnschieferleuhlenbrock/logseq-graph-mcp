import { createRequire } from "node:module";

type SearchRegex = {
  search(line: string): { index: number; text: string } | null;
};

const require = createRequire(import.meta.url);

function loadRe2(): unknown {
  if ((process.env.LOGSEQ_REGEX_ENGINE ?? "auto").toLowerCase() === "native") return null;
  try {
    return require("re2");
  } catch {
    return null;
  }
}

const Re2Ctor = loadRe2() as (new (pattern: string, flags?: string) => { exec(input: string): RegExpExecArray | null }) | null;

export function regexEngineName(): string {
  return Re2Ctor ? "re2" : "native";
}

export function compileSearchRegex(pattern: string, flags: string): SearchRegex {
  if (Re2Ctor) {
    const re2 = new Re2Ctor(pattern, flags.replace("u", ""));
    return {
      search(line: string) {
        const match = re2.exec(line);
        if (!match) return null;
        return { index: match.index, text: match[0] };
      },
    };
  }
  const native = new RegExp(pattern, flags);
  return {
    search(line: string) {
      const match = native.exec(line);
      if (!match) return null;
      return { index: match.index, text: match[0] };
    },
  };
}
