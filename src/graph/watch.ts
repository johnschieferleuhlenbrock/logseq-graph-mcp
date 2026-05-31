import fs from "node:fs";

export class GraphWatcher {
  private readonly watchers: fs.FSWatcher[] = [];

  constructor(dirs: string[], onChange: () => void) {
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const watcher = fs.watch(dir, { persistent: false }, () => onChange());
        watcher.unref();
        this.watchers.push(watcher);
      } catch {
        // Watch support differs by filesystem. Fingerprint checks remain authoritative.
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
  }
}
