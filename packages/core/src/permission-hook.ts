/**
 * Claude Code hooks for sensitive notes: `hook prompt` (UserPromptSubmit) and `hook pre-tool` (PreToolUse).
 *
 * The prompt hook turns the sensitive topics a user names into grants for that session. The pre-tool hook
 * reads each Bash command for `--allow-sensitive` and answers:
 * - "allow" when grants cover every requested path and the command runs nothing but rcllr,
 * - "ask" when a path is not covered or the hook cannot read the flag for sure,
 * - nothing otherwise, so Claude Code's own rules decide as for any command.
 *
 * Fail closed: an unreadable command, a missing config or a computed flag value asks. Headless runs cannot
 * ask, so there such a call fails. Hook output never names a path: it lands in the transcript.
 */

import type { Config } from "./config.ts";
import { addGrants, covers, loadGrants, matchPrompt } from "./grants.ts";
import type { HookOutput } from "./hook.ts";
import { COMMANDS } from "./install.ts";
import { text as say } from "./messages.ts";
import { isObject } from "./pyjson.ts";
import { splitCommand, type Word } from "./shell-words.ts";

export type Decision = "allow" | "ask" | null;

const FLAG = "--allow-sensitive";
/** Shortest prefix the CLI's option parser accepts for the flag that the hook still recognizes. */
const MIN_PREFIX = "--a".length;
/** Text that betrays the flag inside a word the hook cannot split: `bash -c "…"`, `eval`, a heredoc body. */
const HIDDEN = "--allow-s";
/** On a command the splitter rejects, any trace of the flag or an abbreviation of it asks. */
const TRACE = "--al";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NAMES: ReadonlySet<string> = new Set(COMMANDS);

function basename(word: Word): string {
  return word.text.split("/").at(-1) ?? "";
}

function isRcllr(word: Word): boolean {
  return !word.dynamic && NAMES.has(basename(word));
}

/** The subcommand starts with rcllr, after optional variable assignments. */
function runsRcllr(words: readonly Word[]): boolean {
  const first = words.find((word) => !ASSIGNMENT.test(word.text));
  return first !== undefined && isRcllr(first);
}

/** `--allow-sensitive` or an abbreviation the option parser accepts, with or without `=value`. */
function flagValue(word: Word): { inline: string | null } | null {
  if (word.dynamic || !word.text.startsWith("--")) return null;
  const eq = word.text.indexOf("=");
  const flag = eq === -1 ? word.text : word.text.slice(0, eq);
  if (flag.length < MIN_PREFIX || !FLAG.startsWith(flag)) return null;
  return { inline: eq === -1 ? null : word.text.slice(eq + 1) };
}

interface Requests {
  readonly paths: string[];
  /** A flag was there, but its value is unknown before the shell runs. */
  unknown: boolean;
}

function requests(groups: readonly (readonly Word[])[]): Requests {
  const found: Requests = { paths: [], unknown: false };
  for (const words of groups) {
    const rcllr = words.some(isRcllr);
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      const flag = rcllr ? flagValue(word) : null;
      if (flag === null) {
        if (word.text.includes(HIDDEN)) found.unknown = true;
        continue;
      }
      if (flag.inline !== null) {
        found.paths.push(flag.inline);
        continue;
      }
      const value = words[i + 1];
      if (value === undefined || value.dynamic) {
        found.unknown = true;
      } else {
        found.paths.push(value.text);
        i++;
      }
    }
  }
  return found;
}

/** Allow, ask, or leave it to Claude Code's rules (null). `config` is null when no brain config loads. */
export function decide(config: Config | null, command: string, sessionId: string): Decision {
  let groups: Word[][];
  try {
    groups = splitCommand(command);
  } catch {
    return command.includes(TRACE) ? "ask" : null;
  }
  const found = requests(groups);
  if (found.unknown) return "ask";
  if (found.paths.length === 0) return null;
  if (config === null) return "ask";
  const granted = loadGrants(config, sessionId);
  if (!found.paths.every((path) => covers(granted, path))) return "ask";
  return groups.every(runsRcllr) ? "allow" : null;
}

function answer(decision: "allow" | "ask"): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: say(decision === "allow" ? "hook_sensitive_allow" : "hook_sensitive_ask", "plain"),
    },
  }) + "\n";
}

/** PreToolUse: print a decision for Bash calls with `--allow-sensitive`. Always exits 0. */
export function preToolEvent(event: unknown, config: Config | null, output: HookOutput): number {
  if (!isObject(event) || event.tool_name !== "Bash" || !isObject(event.tool_input)) return 0;
  const command = event.tool_input.command;
  if (typeof command !== "string") return 0;
  const sessionId = typeof event.session_id === "string" ? event.session_id : "";
  let decision: Decision;
  try {
    decision = decide(config, command, sessionId);
  } catch {
    decision = command.includes(TRACE) ? "ask" : null;
  }
  if (decision !== null) output.out(answer(decision));
  return 0;
}

/**
 * UserPromptSubmit: grant the sensitive topics the prompt names to this session. Prints nothing, since
 * Claude Code adds a prompt hook's output to the conversation. Always exits 0.
 */
export function promptEvent(event: unknown, config: Config, output: HookOutput): number {
  void output;
  if (!isObject(event) || typeof event.prompt !== "string" || typeof event.session_id !== "string") return 0;
  try {
    addGrants(config, event.session_id, matchPrompt(config, event.prompt));
  } catch {
    // A grant that cannot be stored only means the next sensitive call asks.
  }
  return 0;
}
