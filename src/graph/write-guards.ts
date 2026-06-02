import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LockMetadata = {
  op_id?: string;
  pid: number;
  hostname: string;
  created_at: string;
  expires_at: string;
  target: string;
};

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

export function lockMetadata(targetPath: string, timeoutMs: number, opId?: string): LockMetadata {
  const now = Date.now();
  return {
    op_id: opId,
    pid: process.pid,
    hostname: os.hostname(),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + timeoutMs).toISOString(),
    target: targetPath,
  };
}

export function acquireLock(targetPath: string, timeoutMs: number, opId?: string): LockHandle {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o644);
      fs.writeFileSync(fd, `${JSON.stringify(lockMetadata(targetPath, timeoutMs, opId), null, 2)}\n`, "utf8");
      return new LockHandle(lockPath, fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || Date.now() > deadline) {
        throw new Error(`could not acquire lock on ${lockPath} within ${timeoutMs / 1000}s`);
      }
      sleepMs(50);
    }
  }
}

export function withFileLock<T>(targetPath: string, timeoutMs: number, fn: () => T, opId?: string): T {
  const lock = acquireLock(targetPath, timeoutMs, opId);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
