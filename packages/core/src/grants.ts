/**
 * Session grants for sensitive notes.
 *
 * The prompt hook reads the user's own prompt, finds the sensitive topics it names and stores them as
 * grants for that Claude Code session. The permission hook then lets `--allow-sensitive` calls through
 * that those grants cover. The agent never writes a prompt, so a grant always traces back to the user.
 *
 * Grants live in the Git folder, never in the tree, so they are never committed. They hold sensitive
 * paths and nothing else; the paths file lists the same paths already.
 */

import * as fs from "node:fs";

import type { Config } from "./config.ts";
import { insideWithoutSymlinks } from "./files.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { run } from "./proc.ts";
import { casefold } from "./py.ts";
import { isObject, type Json, loads } from "./pyjson.ts";
import { exists, isDir, isFile, isSymlink, join, name, parent, readText, resolve, stem } from "./pyos.ts";
import { pathKey, Sensitivity } from "./sensitive.ts";

/** How many sessions keep their grants; the oldest drop out first. */
export const MAX_SESSIONS = 64;
/** Names and aliases shorter than this match too much by chance, so they never grant anything. */
export const MIN_TERM_LENGTH = 3;
const MAX_SESSION_ID = 200;
const STATE_DIR = "rcllr";
const STATE_FILE = "grants.json";

const UMLAUTS: Readonly<Record<string, string>> = { "ä": "ae", "ö": "oe", "ü": "ue" };

/** Compare words the way people type them: no case, umlauts as ae/oe/ue, no accents, one space between words. */
export function normalizeTerm(text: string): string {
  const folded = casefold(text.normalize("NFC")).replace(/[äöü]/g, (umlaut) => UMLAUTS[umlaut]!);
  return folded.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

interface Entry {
  /** The listed path without a trailing slash, as written in the paths file or in `sensitive.always`. */
  readonly path: string;
  readonly terms: readonly string[];
}

/** The aliases of one note, read only when the file sits inside the brain without symlinks. */
function aliasesOf(config: Config, rel: string): string[] {
  const file = join(config.root, rel);
  if (!isFile(file) || !insideWithoutSymlinks(config.root, file)) return [];
  try {
    const value = parseFrontmatter(readText(file, "ignore")).data.get(config.frontmatter.aliases);
    if (value === undefined) return [];
    return Array.isArray(value) ? [...value] : [value];
  } catch {
    return [];
  }
}

function entries(config: Config): Entry[] {
  const sensitivity = Sensitivity.load(config);
  const found = new Map<string, Entry>();
  const add = (rel: string, names: readonly string[]): void => {
    const key = pathKey(rel);
    if (found.has(key)) return;
    const terms = names.map(normalizeTerm).filter((term) => term.length >= MIN_TERM_LENGTH);
    found.set(key, { path: rel, terms: [...new Set(terms)] });
  };
  for (const dir of [...sensitivity.dirs, ...sensitivity.alwaysDirs]) {
    add(dir, [name(dir), ...aliasesOf(config, dir + "/" + config.layout.topicReadme)]);
  }
  for (const file of [...sensitivity.files, ...sensitivity.alwaysFiles]) {
    add(file, [stem(file), ...aliasesOf(config, file)]);
  }
  return [...found.values()];
}

/** Sensitive paths whose folder name, file name or aliases appear in `prompt` as whole words. */
export function matchPrompt(config: Config, prompt: string): string[] {
  const text = " " + normalizeTerm(prompt) + " ";
  return entries(config)
    .filter((entry) => entry.terms.some((term) => text.includes(" " + term + " ")))
    .map((entry) => entry.path);
}

/** A clean relative path, or null for anything rcllr would not read as one: absolute, `..`, `.`, backslashes. */
function cleanRequest(requested: string): string | null {
  const rel = requested.replace(/\/+$/, "");
  if (!rel || rel.startsWith("/") || rel.includes("\\") || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return rel;
}

/**
 * True when `requested` is a granted path or lies below a granted folder. Broad requests above a grant are
 * not covered. A grant ending in `.md` is a file, as in the paths file, and covers only itself.
 */
export function covers(granted: ReadonlySet<string>, requested: string): boolean {
  const rel = cleanRequest(requested);
  if (rel === null) return false;
  const key = pathKey(rel);
  return [...granted].map(pathKey).some((grant) =>
    key === grant || (!grant.endsWith(".md") && key.startsWith(grant + "/")));
}

/** `.git/rcllr/grants.json` of the brain (the worktree's Git folder in a worktree), or null without Git. */
export function grantsFile(config: Config): string | null {
  const done = run("git", ["rev-parse", "--git-dir"], { cwd: config.root, timeoutS: config.limits.gitTimeoutS });
  if (done.failed || done.code !== 0) return null;
  const gitDir = done.stdout.trim();
  return gitDir ? join(resolve(join(config.root, gitDir)), STATE_DIR, STATE_FILE) : null;
}

function usableSession(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= MAX_SESSION_ID && !/\p{Cc}/u.test(sessionId);
}

/** The state folder and file are only used when neither is a symlink. */
function safe(file: string): boolean {
  const folder = parent(file);
  return !isSymlink(folder) && !isSymlink(file) && (!exists(folder) || isDir(folder));
}

function readStore(file: string): Map<string, string[]> {
  const store = new Map<string, string[]>();
  if (!safe(file) || !isFile(file)) return store;
  let data: Json;
  try {
    data = loads(readText(file));
  } catch {
    return store;
  }
  const sessions = isObject(data) ? data.sessions : undefined;
  if (!isObject(sessions)) return store;
  for (const [id, paths] of Object.entries(sessions)) {
    if (!Array.isArray(paths) || !paths.every((value) => typeof value === "string")) return new Map();
    store.set(id, paths as string[]);
  }
  return store;
}

/** The paths granted to `sessionId`. Missing, broken or redirected state means no grants. */
export function loadGrants(config: Config, sessionId: string): Set<string> {
  if (!usableSession(sessionId)) return new Set();
  const file = grantsFile(config);
  if (file === null) return new Set();
  return new Set(readStore(file).get(sessionId) ?? []);
}

/** Add `paths` to the grants of `sessionId`. Writes through no symlink and never fails the caller. */
export function addGrants(config: Config, sessionId: string, paths: readonly string[]): void {
  if (paths.length === 0 || !usableSession(sessionId)) return;
  const file = grantsFile(config);
  if (file === null || !safe(file)) return;
  const store = readStore(file);
  const merged = [...new Set([...(store.get(sessionId) ?? []), ...paths])].sort();
  store.delete(sessionId);
  store.set(sessionId, merged);
  const kept = [...store.entries()].slice(-MAX_SESSIONS);
  const folder = parent(file);
  const temp = file + "." + process.pid + ".tmp";
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify({ sessions: Object.fromEntries(kept) }, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch {
    fs.rmSync(temp, { force: true });
  }
}
