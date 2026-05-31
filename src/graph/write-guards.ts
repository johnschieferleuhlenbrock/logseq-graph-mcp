import fs from "node:fs";
import path from "node:path";

export function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function atomicWriteFileSync(filePath: string, content: string, id = `${process.pid}.${Date.now()}`): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp.${id}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w", 0o644);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
}

export class LockHandle {
  constructor(private readonly lockPath: string, private fd: number) {}

  release(): void {
    try {
      fs.closeSync(this.fd);
    } finally {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // best effort
      }
    }
  }
}

export function acquireLock(targetPath: string, timeoutMs: number): LockHandle {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return new LockHandle(lockPath, fs.openSync(lockPath, "wx", 0o644));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || Date.now() > deadline) {
        throw new Error(`could not acquire lock on ${lockPath} within ${timeoutMs / 1000}s`);
      }
      sleepMs(50);
    }
  }
}

export function withFileLock<T>(targetPath: string, timeoutMs: number, fn: () => T): T {
  const lock = acquireLock(targetPath, timeoutMs);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
