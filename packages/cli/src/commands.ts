/** Write and maintenance commands: write, ingest, check, sync. Port of commands.py. */

import {
  Access, check, checkCommitMessage, type Config, HELP, ingest, JsonDecodeError, loadsJson, message as say, Rejected, report,
  syncRepository, validatePacket, withRepositoryLock,
} from "@rcllr/core";

import type { Namespace, Parser } from "./argparse.ts";
import { err, out, readInput } from "./io.ts";
import { accessOptions, outputOptions } from "./options.ts";

export const EXIT_SYNC_FAILED = 3;

type Result = Record<string, unknown>;

export function register(add: (name: string) => Parser): void {
  for (const name of ["ingest", "write", "check", "sync"]) {
    const action = add(name);
    if (name === "write") {
      action.positional("path", HELP.path!);
      action.option("--expected", {
        required: true, metavar: "REV", help: HELP.expected!, missingHint: say("usage_missing_expected", "plain"),
      });
      action.option("--append", { kind: "flag", help: HELP.append! });
    }
    outputOptions(action);
    if (name === "sync") continue;
    action.option("--input", { metavar: "PATH", help: name === "write" ? HELP.input_md! : HELP.input_json! });
    accessOptions(action);
    if (name === "ingest" || name === "write") {
      action.option("--dry-run", { kind: "flag", help: HELP.dry_run! });
      action.option("--message", { metavar: "TEXT", help: HELP.commit_message! });
    } else action.positional("paths", HELP.check_paths!, { nargs: "*" });
  }
}

export function writePacket(args: Namespace, limit: number): Record<string, unknown> {
  const text = readInput(args.input as string | null, limit);
  const entry: Record<string, unknown> = { path: args.path, expected: args.expected === "new" ? null : args.expected };
  entry[args.append ? "append" : "content"] = text;
  return { changes: [entry] };
}

export function loadPacket(path: string | null, limit: number): unknown {
  const text = readInput(path, limit);
  try {
    return loadsJson(text);
  } catch (error) {
    if (!(error instanceof JsonDecodeError)) throw error;
    throw new Rejected("json_unreadable", { msg: error.msg, line: error.lineno, col: error.colno });
  }
}

function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

export function outputResult(value: Result, asJson: boolean, limit: number, tone: string): string {
  const result = structuredClone(value);

  const encode = (): string => {
    if (asJson) return JSON.stringify(result) + "\n";
    const lines: string[] = [];
    if ("sync" in result) {
      const status = say(result.saved ? "out_saved" : "out_preview", tone);
      lines.push(say("out_write_status", tone, { status, sync: result.sync }));
      for (const path of result.changed as string[]) lines.push(say("out_changed", tone, { path }));
      for (const path of result.unchanged as string[]) lines.push(say("out_unchanged", tone, { path }));
    }
    if ("checked" in result) {
      lines.push(say("out_checked", tone, { count: result.checked, status: result.ok ? "ok" : "error" }));
    }
    if (result.status) lines.push(say("sync_ok", tone));
    for (const problem of (result.issues ?? []) as Record<string, unknown>[]) {
      // `path:line:` lets editors and terminals jump to the issue; the line never names a link target.
      const path = problem.line === undefined ? problem.path : problem.path + ":" + String(problem.line);
      lines.push(say("out_issue", tone, { path, message: problem.message, severity: problem.severity }));
    }
    if (result.truncated) lines.push(say("out_write_truncated", tone));
    return lines.join("\n") + "\n";
  };

  for (const key of ["changed", "unchanged", "issues", "revisions"]) {
    while (codePoints(encode()) > limit && truthy(result[key])) {
      result.truncated = true;
      const items = result[key];
      if (Array.isArray(items)) {
        items.pop();
      } else {
        const object = items as Record<string, unknown>;
        const keys = Object.keys(object);
        delete object[keys[keys.length - 1]!];
      }
    }
  }
  return encode();
}

export function run(args: Namespace, config: Config, tone: string): number {
  const limit = config.limits.maxInputChars;
  let code = 0;
  let result: Result;
  if (args.command === "sync") {
    syncRepository(config, true);
    result = { status: "ok" };
  } else {
    const access = new Access(config, args.scope as string | null, args.topic as string | null,
      args.allowSensitive as string[]);
    if (args.command === "ingest" || args.command === "write") {
      const message = (args.message as string | null) ?? null;
      checkCommitMessage(message);
      const packet = args.command === "ingest" ? loadPacket(args.input as string | null, limit) : writePacket(args, limit);
      result = { ...ingest(access, packet, Boolean(args.dryRun), true, message) };
      code = result.sync === "failed" ? EXIT_SYNC_FAILED : 0;
    } else {
      const paths = args.paths as string[];
      if (args.input && paths.length > 0) throw new Rejected("check_paths_or_input");
      [result, code] = withRepositoryLock(config.root, (): [Result, number] => {
        if (args.input) return [{ ...report(validatePacket(access, loadPacket(args.input as string, limit))) }, 0];
        const checked = { ...check(access, paths.length > 0 ? paths : null) };
        return [checked, checked.ok ? 0 : 2];
      }, config.limits.lockTimeoutS);
    }
  }
  out(outputResult(result, Boolean(args.json), args.maxChars as number, tone));
  if (code === EXIT_SYNC_FAILED) {
    err(say("sync_failed_after_save", tone) + "\n");
    // Only the login failure gets its own line: the other sync failures need no step beyond `rcllr sync`.
    if (result.syncError === "git_auth") err(say("git_auth", tone) + "\n");
  }
  return code;
}
