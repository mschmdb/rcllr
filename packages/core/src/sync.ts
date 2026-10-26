/**
 * One Git sync path for the CLI and every agent hook. Never echoes raw Git output.
 *
 * A local brain (no `repo.remote`) only commits: no fetch, no push, no remote check.
 * Every commit covers only `committedPaths`; whatever else changed waits for a human commit.
 */

import type { Config } from "./config.ts";
import { Rejected, SyncError } from "./errors.ts";
import { withRepositoryLock } from "./lock.ts";
import { type Done, run } from "./proc.ts";
import { sorted, strip } from "./py.ts";
import { exists, join, resolve, stripTrailingSlashes } from "./pyos.ts";

const OPEN_OPERATIONS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"];

// Git's own wording for a refused login. "Could not read from remote repository" alone also means a missing
// repository, so it stays a plain failure.
const AUTH_FAILURES = [
  "Permission denied (publickey",
  "Host key verification failed",
  "Authentication failed for",
  "could not read Username for",
];

/** The message key for a failed fetch or push, judged from Git's stderr. The text itself never leaves. */
export function remoteFailure(stderr: string): "git_auth" | null {
  return AUTH_FAILURES.some((pattern) => stderr.includes(pattern)) ? "git_auth" : null;
}

export function git(config: Config, args: readonly string[], allowed: readonly number[] = [0]): Done {
  const done = run("git", args, { cwd: config.root, timeoutS: config.limits.gitTimeoutS });
  if (done.failed) throw new SyncError("git_unavailable");
  if (!allowed.includes(done.code!)) {
    const remoteStep = args[0] === "fetch" || args[0] === "push";
    throw new SyncError((remoteStep && remoteFailure(done.stderr)) || "git_failed", { step: args[0] });
  }
  return done;
}

/** Longest commit subject `--message` accepts, in characters. */
export const MAX_COMMIT_MESSAGE = 200;

/**
 * What rcllr commits: the note folders, the content folders `init` creates and the generated files.
 * Config and tooling (rcllr.toml, AGENTS.md, CLAUDE.md, .claude/, .codex/, scripts) stay for a human commit.
 */
export function committedPaths(config: Config): string[] {
  const layout = config.layout;
  // The routes and entities files are content the user curates, wherever rcllr.toml puts them.
  const paths = [...layout.roots, layout.sources, layout.archive, layout.index, config.sensitive.pathsFile,
    config.links.output, stripTrailingSlashes(config.curator.reportDir), config.context.routesFile,
    config.links.entitiesFile];
  return [...new Set(paths)];
}

function excludes(config: Config): string[] {
  return config.repo.syncExclude.map((path) => ":(exclude)" + path);
}

/** The committed paths minus sync_exclude. Never empty, so it never widens to the whole tree. */
export function notePathspec(config: Config): string[] {
  return ["--", ...committedPaths(config).map((path) => ":(literal)" + path), ...excludes(config)];
}

/** One line of 1 to MAX_COMMIT_MESSAGE characters. The error never repeats the text. */
export function checkCommitMessage(message: string | null | undefined): void {
  if (message === null || message === undefined) return;
  if (!strip(message) || /[\p{Cc}\u2028\u2029]/u.test(message) || [...message].length > MAX_COMMIT_MESSAGE) {
    throw new Rejected("commit_message_invalid", { max: MAX_COMMIT_MESSAGE });
  }
}

function remoteRef(config: Config): string {
  return "refs/remotes/" + config.repo.remoteName + "/" + config.repo.branch;
}

/**
 * Remote and branch for a Git command line. loadConfig already rejects names that start with "-"; this check
 * covers a Config a library caller built by hand, so a value can never act as a Git option (--upload-pack).
 */
function remoteAndBranch(config: Config): [string, string] {
  const remote = config.repo.remoteName;
  const branch = config.repo.branch;
  if (remote.startsWith("-") || branch.startsWith("-")) throw new SyncError("git_branch", { branch });
  return [remote, branch];
}

function verify(config: Config): void {
  const repo = config.repo;
  const [remote] = remoteAndBranch(config);
  if (resolve(git(config, ["rev-parse", "--show-toplevel"]).stdout.trim()) !== config.root) {
    throw new SyncError("git_root");
  }
  if (git(config, ["symbolic-ref", "--short", "HEAD"]).stdout.trim() !== repo.branch) {
    throw new SyncError("git_branch", { branch: repo.branch });
  }
  if (!repo.local && git(config, ["remote", "get-url", "--", remote]).stdout.trim() !== repo.remote) {
    throw new SyncError("git_remote", { name: repo.remoteName });
  }
  for (const state of OPEN_OPERATIONS) {
    const location = git(config, ["rev-parse", "--git-path", state]).stdout.trim();
    if (exists(join(config.root, location))) throw new SyncError("git_open_operation");
  }
  if (git(config, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim()) throw new SyncError("git_conflicts");
}

function count(config: Config, range: string): number {
  return Number.parseInt(git(config, ["rev-list", "--count", "--end-of-options", range]).stdout.trim(), 10);
}

function refresh(config: Config): void {
  const [remote, branch] = remoteAndBranch(config);
  // --no-write-fetch-head: parallel fetches would otherwise race on FETCH_HEAD. The "--" here, in push and in
  // remote get-url (--end-of-options where "--" would start paths) is a second guard: nothing after it is
  // read as an option.
  git(config, ["fetch", "--no-write-fetch-head", "--", remote,
    "refs/heads/" + branch + ":" + remoteRef(config)]);
  if (count(config, "HEAD.." + remoteRef(config))) {
    try {
      git(config, ["rebase", "--autostash", "--end-of-options", remoteRef(config)]);
    } catch (error) {
      if (!(error instanceof SyncError)) throw error;
      git(config, ["rebase", "--abort"]);
      throw new SyncError("git_diverged");
    }
  }
}

/** Before a write: clean tree, then catch up with the remote, so markers and scopes are current. */
export function prepareRepository(config: Config): void {
  verify(config);
  if (git(config, ["status", "--porcelain", "--untracked-files=all", ...notePathspec(config)]).stdout) {
    throw new SyncError("git_dirty");
  }
  if (pushes(config)) refresh(config);
}

/** Fetch and push only with a remote and auto_push on; a local brain never talks to a remote. */
function pushes(config: Config): boolean {
  return config.repo.autoPush && !config.repo.local;
}

/**
 * Commit staged note changes. Anything a human staged under sync_exclude stays staged, uncommitted.
 *
 * `git commit -- <pathspec>` would do this too, but drops what the pre-commit hook stages. So the
 * foreign staged changes are parked as a patch and restored after the commit.
 */
function commitNotesOnly(config: Config, message: string): void {
  // --no-renames: a rename lists only its new path, so the deletion of the old one would slip into the commit.
  const staged = new Set(git(config, ["diff", "--cached", "--no-renames", "--name-only", "-z"]).stdout.split("\0"));
  const notes = new Set(git(config, ["diff", "--cached", "--no-renames", "--name-only", "-z", ...notePathspec(config)])
    .stdout.split("\0"));
  const foreign = sorted([...staged].filter((path) => path && !notes.has(path)));
  const parked = foreign.length > 0 ? git(config, ["diff", "--cached", "--no-renames", "--binary", "--", ...foreign]).stdout : "";
  if (foreign.length > 0) git(config, ["reset", "-q", "--", ...foreign]);
  try {
    git(config, ["commit", "-m", message]);
  } finally {
    if (parked) {
      const restore = run("git", ["apply", "--cached"], { cwd: config.root, input: parked, timeoutS: config.limits.gitTimeoutS });
      if (restore.failed || restore.code !== 0) throw new SyncError("git_failed", { step: "apply" });
    }
  }
}

/**
 * `git add` fails on a pathspec that matches nothing, so only paths that exist or are tracked go in.
 * Status and diff accept unmatched pathspecs.
 */
function addablePathspec(config: Config): string[] {
  const tracked = git(config, ["ls-files", "-z", ...notePathspec(config)]).stdout.split("\0").filter(Boolean);
  const present = committedPaths(config).filter((path) => exists(join(config.root, path))
    || tracked.some((file) => file === path || file.startsWith(path + "/")));
  return present.length > 0 ? ["--", ...present.map((path) => ":(literal)" + path), ...excludes(config)] : [];
}

/** Commit note changes with `message` (default repo.commit_message), then push if configured. */
export function syncLocked(config: Config, refreshRemote = false, message: string | null = null): void {
  checkCommitMessage(message);
  verify(config);
  const spec = notePathspec(config);
  if (git(config, ["status", "--porcelain", "--untracked-files=all", ...spec]).stdout) {
    const addable = addablePathspec(config);
    if (addable.length > 0) git(config, ["add", "-A", ...addable]);
    if (git(config, ["diff", "--cached", "--quiet", ...spec], [0, 1]).code === 1) {
      commitNotesOnly(config, message ?? config.repo.commitMessage);
    }
  }
  if (!pushes(config)) return;
  if (count(config, remoteRef(config) + "..HEAD") || refreshRemote) pushLatest(config);
}

/** How often a sync fetches and pushes again when another machine pushed first. */
export const PUSH_ATTEMPTS = 3;

/**
 * Catch up with the remote, then push. Another machine may push between our fetch and our push; then the
 * push fails and we fetch, rebase and push again. A refused login fails at once, retrying cannot fix it.
 */
function pushLatest(config: Config): void {
  const [remote, branch] = remoteAndBranch(config);
  for (let attempt = 1; ; attempt++) {
    refresh(config);
    if (!count(config, remoteRef(config) + "..HEAD")) return;
    try {
      git(config, ["push", "--", remote, branch]);
      return;
    } catch (error) {
      if (!(error instanceof SyncError) || error.key !== "git_failed" || attempt === PUSH_ATTEMPTS) throw error;
    }
  }
}

export function syncRepository(config: Config, refreshRemote = false, message: string | null = null): void {
  withRepositoryLock(config.root, () => syncLocked(config, refreshRemote, message), config.limits.lockTimeoutS);
}
