import fs from "node:fs";
import path from "node:path";

export function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function mtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return -1;
  }
}

export function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function relativeGraphPath(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

export function listMarkdown(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function stem(filePath: string): string {
  return path.basename(filePath, ".md");
}

export function isPathUnder(candidatePath: string, parentPath: string): boolean {
  const parentResolved = pathExists(parentPath) ? fs.realpathSync.native(parentPath) : path.resolve(parentPath);
  let candidate: string;
  if (pathExists(candidatePath)) {
    candidate = fs.realpathSync.native(candidatePath);
  } else {
    const dir = path.dirname(candidatePath);
    const dirResolved = pathExists(dir) ? fs.realpathSync.native(dir) : path.resolve(dir);
    candidate = path.join(dirResolved, path.basename(candidatePath));
  }
  const relative = path.relative(parentResolved, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

