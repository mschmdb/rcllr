/**
 * One process lock per brain, shared by write packages and Git sync.
 *
 * Node has no flock(), so the lock is a file created atomically with the owner's process id.
 * A lock whose owner no longer runs counts as stale and is taken over. Readers take the same
 * lock as writers; a read holds it only for milliseconds.
 */

import * as fs from "node:fs";
import * as os from "node:os";

import { RcllrError } from "./errors.ts";
import { resolve, sha256 } from "./pyos.ts";

const POLL_MS = 50;
/** A lock file without a readable owner older than this counts as stale. */
const ORPHAN_MS = 60_000;

export function lockPath(root: string): string {
  return os.tmpdir() + "/rcllr-" + sha256(resolve(root)).slice(0, 16) + ".lock.node";
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove the lock if its owner is gone. True if it was removed or is already gone. */
function clearStale(path: string): boolean {
  let stat: fs.Stats;
  let owner: number;
  try {
    stat = fs.statSync(path);
    owner = Number.parseInt(fs.readFileSync(path, "utf-8"), 10);
  } catch (error) {
    // Gone means free. Anything else (a folder, no read permission; the lock lives in the shared temp folder) is
    // someone's lock we cannot judge: wait for the timeout instead of retrying at once forever.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const orphan = !Number.isInteger(owner) && Date.now() - stat.mtimeMs > ORPHAN_MS;
  if (!orphan && (!Number.isInteger(owner) || owner === process.pid || alive(owner))) return false;
  try {
    // Remove only the file we inspected; a fresh lock from another process has a new inode.
    if (fs.statSync(path).ino === stat.ino) fs.unlinkSync(path);
  } catch {
    // Someone else removed it first.
  }
  return true;
}

function acquire(path: string): boolean {
  const temp = path + "." + process.pid + "." + Math.random().toString(16).slice(2);
  fs.writeFileSync(temp, String(process.pid), { mode: 0o600 });
  try {
    fs.linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Run `body` while holding the brain's lock; throw `busy` after `timeoutS` seconds. */
export function withRepositoryLock<T>(root: string, body: () => T, timeoutS = 10): T {
  const path = lockPath(root);
  const deadline = Date.now() + timeoutS * 1000;
  while (!acquire(path)) {
    if (clearStale(path)) continue;
    if (Date.now() >= deadline) throw new RcllrError("busy");
    sleep(POLL_MS);
  }
  try {
    return body();
  } finally {
    fs.rmSync(path, { force: true });
  }
}
