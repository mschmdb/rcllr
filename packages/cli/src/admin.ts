/** Setup and maintenance commands: init, install, migrate-name, hook, meta, links, curator. Port of admin.py. */

import * as os from "node:os";
import * as path from "node:path";

import {
  Access, agentEvent, type Config, curator, RcllrError, dumpJson, findRoot, generate, HELP, importMemory, init,
  install, linksExtra, sessionProject,
  loadConfig, loadsJson, LOCALES, message as say, metaReport, migrate, migrateName, preCommit, refreshPathsFile,
  renderAgents, requireExtra,
} from "@rcllr/core";

import type { Namespace, Parser } from "./argparse.ts";
import { err, out, readStdin } from "./io.ts";

const output = { out, err };

export function register(add: (name: string) => Parser): void {
  let command = add("init");
  command.positional("path", HELP.init_path!, { nargs: "?" });
  command.option("--remote", { metavar: "URL", help: HELP.init_remote! });
  command.option("--locale", { choices: LOCALES, default: "en", help: HELP.init_locale! });
  command = add("install");
  command.option("--replace-command", { kind: "append", metavar: "TEXT", help: HELP.install_replace! });
  command = add("import-memory");
  command.option("--dry-run", { kind: "flag", help: HELP.dry_run! });
  command.option("--from-hook", { kind: "flag", help: HELP.import_from_hook! });
  command.option("--claude-home", { metavar: "PATH", help: HELP.import_claude_home! });
  command.option("--codex-home", { metavar: "PATH", help: HELP.import_codex_home! });
  command = add("migrate-name");
  command.option("--apply", { kind: "flag", help: HELP.migrate_apply! });
  command = add("hook");
  command.positional("kind", HELP.hook_kind!, { choices: ["pre-commit", "agent"] });
  command = add("meta");
  command.positional("action", HELP.meta_action!, { choices: ["migrate", "generate", "report", "index", "agents"] });
  command.option("--dry-run", { kind: "flag", help: HELP.dry_run! });
  command.option("--only", { kind: "append", metavar: "PATH", help: HELP.meta_only! });
  command.option("--max-age", { type: "int", metavar: "DAYS", help: HELP.meta_max_age! });
  command.option("--scope", { metavar: "SCOPE", group: "access", help: HELP.scope! });
  command = add("links");
  command.option("--out", { metavar: "PATH", help: HELP.links_out! });
  command.option("--min-topics", { type: "int", help: HELP.links_min! });
  command.option("--scope", { metavar: "SCOPE", group: "access", help: HELP.scope! });
  command.option("--json", { kind: "flag", group: "output", help: HELP.extra_json! });
  command = add("curator");
  command.option("--open-days", { type: "int", metavar: "DAYS", help: HELP.curator_open! });
  command.option("--stale-days", { type: "int", metavar: "DAYS", help: HELP.curator_stale! });
  command.option("--prompt", { kind: "flag", help: HELP.curator_prompt! });
  command.option("--scope", { metavar: "SCOPE", group: "access", help: HELP.scope! });
  command.option("--json", { kind: "flag", group: "output", help: HELP.extra_json! });
}

function optional<T>(value: unknown): T | null {
  return value === undefined || value === null ? null : value as T;
}

export function runInit(args: Namespace, root: string, tone: string): number {
  const target = args.path ? args.path as string : root;
  const remote = optional<string>(args.remote);
  const created = init(target, remote, args.locale as string);
  const key = remote ? "out_init_with_remote" : "out_init";
  out(say(key, tone, { path: created }) + "\n");
  return 0;
}

/** Hooks must never return 2: Claude Code treats exit 2 as a blocking error. */
export function runHook(args: Namespace, root: string, tone: string): number {
  void tone;
  let config: Config;
  try {
    config = loadConfig(findRoot(process.cwd(), root));
  } catch (error) {
    if (error instanceof RcllrError) return 0;
    throw error;
  }
  if (args.kind === "pre-commit") return preCommit(config, output);
  let event: unknown;
  try {
    event = loadsJson(readStdin());
  } catch {
    return 0;
  }
  return agentEvent(event, config, output);
}

export function runInstall(args: Namespace, config: Config, tone: string): number {
  const replace = args.replaceCommand as string[];
  const [written, removed] = install(config, replace);
  if (replace.length > 0) out(say("out_removed_hooks", tone, { count: removed }) + "\n");
  for (const path of written) out(say("out_installed", tone, { what: path }) + "\n");
  return 0;
}

export function runImportMemory(args: Namespace, config: Config, tone: string): number {
  const claudeHome = (args.claudeHome as string | null) ?? process.env.CLAUDE_CONFIG_DIR
    ?? path.join(os.homedir(), ".claude");
  const codexHome = (args.codexHome as string | null) ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const options = { claudeHome, codexHome, dryRun: Boolean(args.dryRun), sync: true };
  if (!args.fromHook) {
    const result = importMemory(new Access(config), options);
    out(say("out_imported", tone, { count: result.changed.length, sync: result.sync }) + "\n");
    for (const path of result.kept) out(say("out_import_kept", tone, { path }) + "\n");
    return 0;
  }
  // A hook: import only the session's project, and never block the session (Claude Code treats exit 2 as one).
  try {
    const event = loadsJson(readStdin());
    const cwd = typeof event === "object" && event !== null && "cwd" in event ? (event as { cwd: unknown }).cwd : null;
    if ((!config.extras.claudeMemory && !config.extras.codexMemory) || typeof cwd !== "string") return 0;
    importMemory(new Access(config), { ...options, project: sessionProject(cwd) });
    return 0;
  } catch (error) {
    err(say("hook_sync_failed", "plain", { reason: error instanceof Error ? error.message : String(error) }) + "\n");
    return 1;
  }
}

export function runMigrateName(args: Namespace, config: Config, tone: string): number {
  const result = migrateName(config.root, { apply: Boolean(args.apply), home: os.homedir(), env: process.env });
  for (const step of result.steps) {
    const [kind, file] = step.split(":");
    out(say("out_migrate_" + kind, tone, { file }) + "\n");
  }
  if (result.steps.length === 0) out(say("out_migrate_none", tone) + "\n");
  else out(say(result.applied ? "out_migrate_done" : "out_migrate_dry", tone) + "\n");
  for (const place of result.outside) out(say("out_migrate_outside", tone, { place }) + "\n");
  return 0;
}

export function runMeta(args: Namespace, config: Config, tone: string): number {
  const dryRun = args.dryRun as boolean;
  if (args.action === "report") {
    out(metaReport(config, optional<number>(args.maxAge), optional<string>(args.scope)) + "\n");
    return 0;
  }
  if (args.action === "agents") {
    out(renderAgents(config));
    return 0;
  }
  const changed: string[] = [];
  if (args.action === "migrate") {
    const only = args.only as string[];
    changed.push(...migrate(config, dryRun, only.length > 0 ? only : null));
  } else {
    if (args.action === "index" && !dryRun) {
      if (refreshPathsFile(config)) changed.push(config.sensitive.pathsFile);
    }
    changed.push(...generate(config, dryRun));
  }
  for (const path of changed) out(path + "\n");
  err(say("out_index_changed", tone, { count: changed.length }) + "\n");
  return 0;
}

export function runLinks(args: Namespace, config: Config, tone: string): number {
  const minTopics = optional<number>(args.minTopics);
  const scope = optional<string>(args.scope);
  if (args.json) {
    out(dumpJson(linksExtra.build(config, minTopics, scope)) + "\n");
    return 0;
  }
  const path = linksExtra.writeLinks(config, optional<string>(args.out), minTopics, scope);
  out(say("out_written", tone, { path: path.slice(config.root.length + 1) }) + "\n");
  return 0;
}

export function runCurator(args: Namespace, config: Config, tone: string): number {
  void tone;
  if (args.prompt) {
    requireExtra(config, "curator");
    out(curator.prompt(config));
    return 0;
  }
  const result = curator.scan(config, optional<number>(args.openDays), optional<number>(args.staleDays),
    optional<string>(args.scope));
  out(args.json ? dumpJson(result) + "\n" : curator.renderMarkdown(result));
  return 0;
}
