/** Wire a brain into Git, Claude Code and Codex. No absolute paths end up in any file. Port of install.py. */

import * as fs from "node:fs";

import type { Config } from "./config.ts";
import { Rejected } from "./errors.ts";
import { insideWithoutSymlinks } from "./files.ts";
import { run } from "./proc.ts";
import { str, strip } from "./py.ts";
import { isObject, type Json, type JsonObject, loads } from "./pyjson.ts";
import { asPosix, exists, isRelativeTo, join, name, parent, readText, relativeTo, writeText } from "./pyos.ts";

export const MANAGED = "# managed-by: rcllr";
/** The marker of hooks written before the rename to rcllr; `install` may overwrite those too. */
export const LEGACY_MANAGED = "# managed-by: dummkopf";
/** Every name the CLI answers to: rcllr, and the old names that stay as aliases during the transition. */
export const COMMANDS = ["rcllr", "dummkopf", "dk"] as const;
// Hooks often run with a narrower PATH than a terminal (the Claude desktop app, for one). rcllr is a Node script,
// so the hook needs both rcllr and node: ~/.local/bin for links the user made, then the folders where Homebrew
// (Apple silicon and Intel) and most installers put node. $HOME keeps the committed files free of
// machine-specific paths.
export const USER_BIN = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
export const PRE_COMMIT = `#!/bin/sh
${MANAGED}
# Regenerates the sensitive-paths list and the indexes. Never blocks a commit.
${USER_BIN}
export PATH
if command -v rcllr >/dev/null 2>&1; then
  rcllr hook pre-commit || true
else
  echo "rcllr not found on PATH; indexes not updated." >&2
fi
exit 0
`;
export const CLAUDE_COMMAND = USER_BIN + ' rcllr --root "$CLAUDE_PROJECT_DIR" hook agent';
export const CODEX_COMMAND = USER_BIN + ' rcllr --root "$(git rev-parse --show-toplevel)" hook agent';
export const CLAUDE_MATCHER = "Write|Edit|MultiEdit|Bash";
export const CODEX_MATCHER = "Bash|apply_patch|Edit|Write";
// Headless agents (`claude -p`, the GitHub Action, cloud sessions) deny every Bash command nobody allowed,
// and say so only in their result. `ask` beats `allow`, so a sensitive read still prompts in a terminal
// and is denied headless, where no user named the topic.
export const PERMISSIONS: Readonly<Record<"allow" | "ask", readonly string[]>> = {
  allow: COMMANDS.map((command) => "Bash(" + command + " *)"),
  ask: COMMANDS.map((command) => "Bash(" + command + " *--allow-sensitive*)"),
};

export type Settings = JsonObject;

export function hooksDir(config: Config): string {
  const done = run("git", ["rev-parse", "--git-path", "hooks"], { cwd: config.root, timeoutS: config.limits.gitTimeoutS });
  if (done.failed || done.code !== 0 || !strip(done.stdout)) throw new Rejected("not_a_git_repo", { path: config.root });
  return join(config.root, strip(done.stdout));
}

/** Path.relative_to(): fails like Python when the path lies outside root. */
function relativeOrFail(path: string, root: string): string {
  if (!isRelativeTo(path, root)) throw new Error("'" + path + "' is not in the subpath of '" + root + "'");
  return relativeTo(path, root);
}

/** The pre-commit hook path, after checking it is free or ours. */
export function gitHookPath(config: Config): string {
  const hook = join(hooksDir(config), "pre-commit");
  const text = exists(hook) ? readText(hook, "ignore") : "";
  if (exists(hook) && !text.includes(MANAGED) && !text.includes(LEGACY_MANAGED)) {
    throw new Rejected("hook_exists", { path: relativeOrFail(hook, config.root) });
  }
  return hook;
}

export function installGitHook(config: Config): string {
  const hook = gitHookPath(config);
  fs.mkdirSync(parent(hook), { recursive: true });
  writeText(hook, PRE_COMMIT);
  fs.chmodSync(hook, 0o755);
  return hook;
}

export function loadJson(path: string): Settings {
  if (!exists(path)) return {};
  let data: Json;
  try {
    data = loads(readText(path));
  } catch {
    throw new Rejected("settings_unreadable", { path: name(path) });
  }
  if (!isObject(data)) throw new Rejected("settings_unreadable", { path: name(path) });
  return data;
}

/** Any of our agent hooks, including the formats of older releases and the old name dummkopf. */
export function isOurs(command: unknown): boolean {
  return typeof command === "string" && (command.includes("rcllr") || command.includes("dummkopf"))
    && command.includes("hook agent");
}

/** dict.get on a JSON value; anything but an object fails like Python's AttributeError. */
function get(value: Json | undefined, key: string): Json | undefined {
  if (!isObject(value)) throw new TypeError("'" + typeName(value) + "' object has no attribute 'get'");
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function typeName(value: Json | undefined): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  return Number.isInteger(value) ? "int" : "float";
}

/** dict.setdefault on a JSON object. */
function setdefault(settings: JsonObject, key: string, fallback: Json): Json {
  if (!Object.hasOwn(settings, key)) settings[key] = fallback;
  return settings[key]!;
}

function list(value: Json): Json[] {
  if (!Array.isArray(value)) throw new TypeError("'" + typeName(value) + "' object is not iterable");
  return value;
}

/** Add our hook once. Older hook commands, also those named dummkopf, are replaced, never duplicated. */
export function addHook(settings: Settings, event: string, command: JsonObject, matcher: string | null): void {
  const hooks = setdefault(settings, "hooks", {});
  if (!isObject(hooks)) throw new TypeError("'" + typeName(hooks) + "' object has no attribute 'setdefault'");
  const entries = setdefault(hooks, event, []);
  if (!Array.isArray(entries)) throw new TypeError("'" + typeName(entries) + "' object has no attribute 'append'");
  const emptied: Json[] = [];
  for (const existing of entries) {
    if (isObject(existing) && Array.isArray(existing.hooks) && existing.hooks.length > 0) {
      existing.hooks = existing.hooks.filter((hook) =>
        get(hook, "command") === command.command || !isOurs(get(hook, "command")));
      if (existing.hooks.length === 0) emptied.push(existing);
    }
  }
  entries.splice(0, entries.length, ...entries.filter((existing) => !emptied.includes(existing)));
  for (const existing of entries) {
    if (list(get(existing, "hooks") ?? []).some((hook) => get(hook, "command") === command.command)) return;
  }
  const entry: JsonObject = matcher ? { matcher } : {};
  entry.hooks = [command];
  entries.push(entry);
}

/** Drop hook commands containing any pattern, and entries left empty. Returns the number removed. */
export function removeHooks(settings: Settings, patterns: readonly string[]): number {
  let removed = 0;
  const hooks = settings.hooks;
  if (patterns.length === 0 || !isObject(hooks)) return 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const keptEntries: Json[] = [];
    for (const entry of entries) {
      const commands = isObject(entry) ? list(get(entry, "hooks") ?? []) : [];
      const kept = commands.filter((hook) => {
        const value = get(hook, "command") ?? "";
        const text = typeof value === "string" ? value : str(value);
        return !patterns.some((pattern) => text.includes(pattern));
      });
      removed += commands.length - kept.length;
      if (kept.length > 0 || commands.length === 0) {
        keptEntries.push(commands.length > 0 ? { ...(entry as JsonObject), hooks: kept } : entry);
      }
    }
    hooks[event] = keptEntries;
    if (keptEntries.length === 0) delete hooks[event];
  }
  return removed;
}

/** The permissions object, after checking it and the lists we touch have the expected shape. */
function permissionsOf(settings: Settings, path: string): JsonObject {
  const permissions = setdefault(settings, "permissions", {});
  if (!isObject(permissions)) {
    throw new Rejected("settings_invalid", { path: name(path), key: "permissions", expected: "an object" });
  }
  for (const key of Object.keys(PERMISSIONS)) {
    const rules = permissions[key];
    if (rules !== undefined && !(Array.isArray(rules) && rules.every((rule) => typeof rule === "string"))) {
      throw new Rejected("settings_invalid", { path: name(path), key: "permissions." + key, expected: "a list of strings" });
    }
  }
  return permissions;
}

/** Add our permission rules once; foreign rules, including a deny on rcllr, stay untouched. */
export function addPermissions(settings: Settings, path: string): void {
  const permissions = permissionsOf(settings, path);
  for (const [key, ours] of Object.entries(PERMISSIONS)) {
    const rules = setdefault(permissions, key, []) as Json[];
    for (const rule of ours) if (!rules.includes(rule)) rules.push(rule);
  }
}

/**
 * The settings file `rel` inside the brain. A brain may come from someone else: a symlink on the way would
 * make install write outside it, so any symlink between the root and the file is rejected.
 */
export function settingsPath(config: Config, ...rel: string[]): string {
  const path = join(config.root, ...rel);
  if (!insideWithoutSymlinks(config.root, path)) throw new Rejected("install_symlink", { path: asPosix(rel.join("/")) });
  return path;
}

export function writeJson(path: string, data: Settings): void {
  fs.mkdirSync(parent(path), { recursive: true });
  writeText(path, JSON.stringify(data, null, 2) + "\n");
}

export function installClaude(config: Config, replace: readonly string[] = []): [string, number] {
  const path = settingsPath(config, ".claude", "settings.json");
  const settings = loadJson(path);
  const removed = removeHooks(settings, replace);
  setdefault(settings, "$schema", "https://json.schemastore.org/claude-code-settings.json");
  const command: JsonObject = { type: "command", command: CLAUDE_COMMAND };
  addHook(settings, "PostToolUse", command, CLAUDE_MATCHER);
  addHook(settings, "SessionEnd", command, null);
  addPermissions(settings, path);
  writeJson(path, settings);
  return [path, removed];
}

export function installCodex(config: Config, replace: readonly string[] = []): [string, number] {
  const path = settingsPath(config, ".codex", "hooks.json");
  const settings = loadJson(path);
  const removed = removeHooks(settings, replace);
  const command: JsonObject = {
    type: "command", command: CODEX_COMMAND, timeout: config.limits.gitTimeoutS, statusMessage: "Syncing notes",
  };
  addHook(settings, "PostToolUse", command, CODEX_MATCHER);
  writeJson(path, settings);
  return [path, removed];
}

/**
 * Return the relative paths written and the number of old hook commands removed.
 *
 * `replace` lists substrings of old hook commands to remove first, so a brain never runs two
 * sync paths side by side. Everything is checked before the first write, so a rejected install
 * (exit 2) changes nothing.
 */
export function install(config: Config, replace: readonly string[] = []): [string[], number] {
  gitHookPath(config);
  const claudeSettings = settingsPath(config, ".claude", "settings.json");
  permissionsOf(loadJson(claudeSettings), claudeSettings);
  if (config.extras.codexSync) loadJson(settingsPath(config, ".codex", "hooks.json"));
  const [claude, removedClaude] = installClaude(config, replace);
  let removed = removedClaude;
  const written = [installGitHook(config), claude];
  if (config.extras.codexSync) {
    const [codex, removedCodex] = installCodex(config, replace);
    written.push(codex);
    removed += removedCodex;
  }
  return [written.map((path) => asPosix(relativeOrFail(path, config.root))), removed];
}
