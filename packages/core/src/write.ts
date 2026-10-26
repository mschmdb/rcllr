/** Save validated packets atomically; on a write error, roll back our own changes. */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

import { Access, type Note } from "./access.ts";
import { type Config, configFile, loadConfig } from "./config.ts";
import { AccessDenied, Rejected, SyncError } from "./errors.ts";
import { type Issue, issue, linkIssues } from "./links.ts";
import { withRepositoryLock } from "./lock.ts";
import { text as say } from "./messages.ts";
import { compare } from "./py.ts";
import { exists, join, name, parent, sha256 } from "./pyos.ts";
import { checkCommitMessage, prepareRepository, syncLocked } from "./sync.ts";
import { type Change, metadataIssues, type Plan, validatePacket } from "./validate.ts";

export const NEW_FILE_MODE = 0o600;

/**
 * Steps tests replace to simulate a full disk or a failing remote, like Python's `patch("rcllr.write.…")`.
 * Production code never changes them.
 */
export const seams = {
  atomicWrite: (path: string, data: Uint8Array): void => atomicWrite(path, data),
  prepareRepository: (config: Config): void => prepareRepository(config),
  // A config built in code has no file to reload; one loaded from rcllr.toml is read again.
  reloadConfig: (config: Config): Config => (exists(configFile(config.root)) ? loadConfig(config.root) : config),
  syncLocked: (config: Config, message: string | null = null): void => syncLocked(config, false, message),
};

export interface WriteResult {
  changed: string[];
  unchanged: string[];
  revisions: Record<string, string>;
  issues: Issue[];
  saved: boolean;
  sync: string;
  /** The message key of a failed sync, so the caller can say why. */
  syncError?: string;
}

export interface CheckResult {
  checked: number;
  issues: Issue[];
  ok: boolean;
}

export function report(plan: Plan): WriteResult {
  const changed = plan.changes
    .filter((change) => change.previous === null || change.note.text !== change.previous.text)
    .map((change) => change.note.path);
  const revisions: Record<string, string> = {};
  for (const change of plan.changes) revisions[change.note.path] = change.note.revision;
  return {
    changed,
    unchanged: plan.changes.map((change) => change.note.path).filter((path) => !changed.includes(path)),
    revisions,
    issues: plan.issues,
    saved: false,
    sync: "not-run",
  };
}

/** An operating system error: Python's OSError. */
function isOsError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
    && typeof (error as NodeJS.ErrnoException).errno === "number";
}

export function digest(path: string): string {
  return sha256(fs.readFileSync(path));
}

/** Create a fresh temporary file next to the target, like tempfile.mkstemp. */
function mkstemp(directory: string): [number, string] {
  for (;;) {
    const name = join(directory, ".rcllr-" + randomBytes(6).toString("hex") + ".tmp");
    try {
      return [fs.openSync(name, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600), name];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function atomicWrite(path: string, data: Uint8Array): void {
  const mode = exists(path) ? fs.statSync(path).mode & 0o777 : NEW_FILE_MODE;
  const [descriptor, name] = mkstemp(parent(path));
  try {
    try {
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(descriptor, data, offset);
      fs.fsyncSync(descriptor);
      fs.fchmodSync(descriptor, mode);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(name, path);
  } finally {
    if (exists(name)) fs.unlinkSync(name);
  }
}

/** Undo our writes. False if a foreign change made a full rollback impossible. */
export function rollback(access: Access, written: readonly Change[], createdDirs: readonly string[]): boolean {
  let complete = true;
  for (const change of [...written].reverse()) {
    const path = join(access.root, change.note.path);
    try {
      if (digest(path) !== change.note.revision) {
        complete = false;
        continue;
      }
      if (change.previous) atomicWrite(path, Buffer.from(change.previous.text, "utf-8"));
      else fs.unlinkSync(path);
    } catch (error) {
      if (!isOsError(error)) throw error;
      complete = false;
    }
  }
  for (const directory of [...createdDirs].reverse()) {
    try {
      fs.rmdirSync(directory);
    } catch {
      // Not empty or already gone: leave it.
    }
  }
  return complete;
}

export function applyPlan(access: Access, plan: Plan): void {
  const written: Change[] = [];
  const createdDirs: string[] = [];
  try {
    for (const change of plan.changes) {
      const { note, previous } = change;
      if (previous && previous.text === note.text) continue;
      const path = access.resolve(note.path, true);
      const changedMeanwhile = exists(path) ? previous === null || digest(path) !== previous.revision : previous !== null;
      if (changedMeanwhile) throw new Rejected("write_race");
      const missing: string[] = [];
      let folder = parent(path);
      while (!exists(folder)) {
        missing.push(folder);
        folder = parent(folder);
      }
      for (const directory of missing.reverse()) {
        fs.mkdirSync(directory);
        createdDirs.push(directory);
      }
      access.resolve(note.path, true);
      seams.atomicWrite(path, Buffer.from(note.text, "utf-8"));
      written.push(change);
    }
  } catch (error) {
    if (!(isOsError(error) || error instanceof Rejected || error instanceof AccessDenied)) throw error;
    if (!rollback(access, written, createdDirs)) throw new Rejected("rollback_failed");
    throw new Rejected("not_saved");
  }
}

/** `message` replaces repo.commit_message for this save's commit. */
export function ingest(access: Access, packet: unknown, dryRun = false, sync = true,
                       message: string | null = null): WriteResult {
  checkCommitMessage(message);
  return withRepositoryLock(access.config.root, () => {
    let config = access.config;
    let current = access;
    if (sync && !dryRun) {
      seams.prepareRepository(config);
      // The remote may have changed rcllr.toml, markers and scopes; load and read them again.
      config = seams.reloadConfig(config);
      current = new Access(config, access.scope, access.topic, access.allowed);
    }
    const plan = validatePacket(current, packet);
    const result = report(plan);
    if (dryRun) return result;
    applyPlan(current, plan);
    result.saved = true;
    result.sync = "pending";
    if (sync) {
      try {
        seams.syncLocked(config, message);
        result.sync = "ok";
      } catch (error) {
        if (!(error instanceof SyncError)) throw error;
        result.sync = "failed";
        result.syncError = error.key;
        return result;
      }
      // The remote may have hidden a note or removed the paths list meanwhile; the write still succeeded.
      const revisions: Record<string, string> = {};
      result.revisions = revisions;
      let refreshed: Access;
      try {
        refreshed = new Access(config, current.scope, current.topic, current.allowed);
      } catch (error) {
        if (error instanceof AccessDenied) return result;
        throw error;
      }
      for (const change of plan.changes) {
        try {
          revisions[change.note.path] = refreshed.read(change.note.path).revision;
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
        }
      }
    }
    return result;
  }, access.config.limits.lockTimeoutS);
}

/** Files named explicitly in rcllr.toml that are missing. A default name may be absent without notice. */
function configIssues(config: Config): Issue[] {
  const files: [boolean, string, string, string][] = [
    [config.context.routesFileSet, config.context.routesFile, "routes-file-missing", "routes_file_missing"],
    [config.links.entitiesFileSet, config.links.entitiesFile, "entities-file-missing", "entities_file_missing"],
  ];
  return files.filter(([set, file]) => set && !exists(join(config.root, file)))
    .map(([, file, code, key]) => issue(name(configFile(config.root)), code, say(key, "plain", { file }), "warning"));
}

/**
 * Lines of a visible note that name a sensitive file or folder in plain text, not as a link. The note itself is
 * fine, but every reader learns that the hidden path exists. The warning never repeats the path.
 */
function mentionIssues(access: Access, note: Note): Issue[] {
  if (note.sensitive) return [];
  const found: Issue[] = [];
  note.text.split("\n").forEach((line, index) => {
    // Split, don't match: a pattern around "/" would backtrack on long runs of slashes.
    const named = line.split(/[^\p{L}\p{N}_.\/-]+/u).filter((token) => token.includes("/"))
      .map((token) => token.replace(/^\.\//, "").replace(/[.,;:]+$/, "").replace(/\/+$/, ""))
      .some((token) => token && access.sensitivity.isListed(token));
    if (named) found.push(issue(note.path, "sensitive-path-mention", say("sensitive_path_mention", "plain"), "warning", index + 1));
  });
  return found;
}

export function check(access: Access, paths: readonly string[] | null = null): CheckResult {
  const problems: Issue[] = paths === null ? configIssues(access.config) : [];
  let checked = 0;
  for (const path of paths ?? access.paths()) {
    let note;
    try {
      note = access.read(path);
    } catch (error) {
      if (!(error instanceof AccessDenied) || paths !== null) throw error;
      continue;
    }
    checked += 1;
    problems.push(...metadataIssues(note, access.config));
    // Report existing dead links; this is not a write request.
    problems.push(...linkIssues(access, note, new Map(), note, true));
    problems.push(...mentionIssues(access, note));
  }
  // By path, then line; issues without a line (frontmatter) come first. The sort is stable.
  problems.sort((a, b) => compare(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0));
  return { checked, issues: problems, ok: !problems.some((problem) => problem.severity === "error") };
}
