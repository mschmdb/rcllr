/** The prompt hook grants sensitive topics, the pre-tool hook answers allow or ask for `--allow-sensitive`. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Config } from "../src/config.ts";
import { addGrants, loadGrants } from "../src/grants.ts";
import type { HookOutput } from "../src/hook.ts";
import { decide, preToolEvent, promptEvent } from "../src/permission-hook.ts";
import { type Brain, brain } from "./helpers.ts";

class Captured implements HookOutput {
  stdout = "";
  stderr = "";
  out(text: string): void {
    this.stdout += text;
  }
  err(text: string): void {
    this.stderr += text;
  }
}

const HAUS = "topics/haus-ulm/";

function hub(): Brain {
  const b = brain();
  b.gitInit();
  b.write(".sensitive-paths", "# generated\ntopics/haus-ulm/\ntopics/finanzen/\n");
  b.write("topics/haus-ulm/README.md", "---\nscope: privat\naliases: [Wärmepumpe]\n---\n\n> SENSIBEL\n\n# Haus\n");
  return b;
}

/** A hub where session "s" was granted the house topic. */
function granted(): Config {
  const config = hub().config;
  addGrants(config, "s", ["topics/haus-ulm"]);
  return config;
}

// --- decide: which calls need the user --------------------------------------------------------------------------

test("a command without --allow-sensitive needs no decision", () => {
  const config = hub().config;
  for (const command of ["rcllr read notes/a.md", "git log --all", "ls topics", "rcllr write x --append"]) {
    assert.equal(decide(config, command, "s"), null, command);
  }
});

test("without a grant every --allow-sensitive call asks", () => {
  const config = hub().config;
  assert.equal(decide(config, "rcllr read topics/haus-ulm/a.md --allow-sensitive " + HAUS, "s"), "ask");
});

test("a granted path is allowed, in every flag spelling", () => {
  const config = granted();
  for (const flag of ["--allow-sensitive " + HAUS, "--allow-sensitive=" + HAUS, "--allow " + HAUS, "--al=" + HAUS,
    "--allow-sensitive 'topics/haus-ulm/a.md'", '--allow-sensitive "topics/haus-ulm"']) {
    assert.equal(decide(config, "rcllr read topics/haus-ulm/a.md " + flag, "s"), "allow", flag);
  }
});

test("another session's grant does not count", () => {
  assert.equal(decide(granted(), "rcllr read x --allow-sensitive " + HAUS, "other"), "ask");
  assert.equal(decide(granted(), "rcllr read x --allow-sensitive " + HAUS, ""), "ask");
});

test("one uncovered path in the call asks", () => {
  const config = granted();
  for (const command of [
    "rcllr read x --allow-sensitive " + HAUS + " --allow-sensitive topics/finanzen/",
    "rcllr read x --allow-sensitive topics/",
    "rcllr read x --allow-sensitive topics/haus-ulm/../finanzen/",
    "rcllr read x --allow-sensitive " + HAUS + " && rcllr read y --allow-sensitive topics/finanzen/",
  ]) {
    assert.equal(decide(config, command, "s"), "ask", command);
  }
});

test("a flag value the shell computes asks", () => {
  const config = granted();
  for (const value of ['"$T"', "$T", "$(echo topics/haus-ulm/)", "`echo topics/haus-ulm/`", "topics/haus-*", "~/x", ""]) {
    assert.equal(decide(config, "rcllr read x --allow-sensitive " + value, "s"), "ask", value);
  }
});

test("a chain of rcllr calls with granted paths is allowed", () => {
  const config = granted();
  const command = "rcllr read a --allow-sensitive " + HAUS + " | head -1 && PATH=/x:$PATH /usr/local/bin/rcllr ingest "
    + "--allow-sensitive " + HAUS + " --input - <<'EOF'\n{\"changes\": []}\nEOF";
  assert.equal(decide(config, command, "s"), null, "head is no rcllr call, so the normal rules decide");
  assert.equal(decide(config, "rcllr read a --allow-sensitive " + HAUS + " && dk find b --allow-sensitive " + HAUS, "s"),
    "allow");
  assert.equal(decide(config, "rcllr ingest --allow-sensitive " + HAUS + " --input - <<'EOF'\n{}\nEOF", "s"), "allow");
});

test("a granted call inside a chain with other commands leaves the decision to the normal rules", () => {
  const config = granted();
  for (const command of [
    "git fetch && rcllr ingest --allow-sensitive " + HAUS + " --input x.json && git push",
    "rev=$(rcllr read a --allow-sensitive " + HAUS + " --end 1) && rcllr ingest --allow-sensitive " + HAUS,
  ]) {
    assert.equal(decide(config, command, "s"), null, command);
  }
});

test("the same chains ask without a grant", () => {
  const config = hub().config;
  for (const command of [
    "git fetch && rcllr ingest --allow-sensitive " + HAUS + " --input x.json && git push",
    "rev=$(rcllr read a --allow-sensitive " + HAUS + " --end 1) && echo $rev",
    "ls topics && rcllr read a --allow-sensitive=" + HAUS,
  ]) {
    assert.equal(decide(config, command, "s"), "ask", command);
  }
});

test("a flag hidden from the splitter asks, even when granted", () => {
  const config = granted();
  for (const command of [
    'bash -c "rcllr read a --allow-sensitive ' + HAUS + '"',
    "eval 'rcllr read a --allow-sensitive " + HAUS + "'",
    "cat <<EOF\n$(rcllr read a --allow-sensitive " + HAUS + ")\nEOF",
    "~/claude-hub/hub read a --allow-sensitive " + HAUS,
    "rcllr read a --allow-sensitive 'unclosed",
  ]) {
    assert.equal(decide(config, command, "s"), "ask", command);
  }
});

test("note text in a quoted heredoc is data, not a flag", () => {
  const config = hub().config;
  const command = "rcllr write notes/rcllr.md --expected new <<'EOF'\nUse --allow-sensitive topics/x/ with care.\nEOF";
  assert.equal(decide(config, command, "s"), null);
});

test("an unparsable command without the flag needs no decision", () => {
  assert.equal(decide(hub().config, "echo 'unclosed", "s"), null);
});

test("without a brain config a sensitive call asks", () => {
  assert.equal(decide(null, "rcllr read a --allow-sensitive " + HAUS, "s"), "ask");
  assert.equal(decide(null, "rcllr read a", "s"), null);
});

// --- preToolEvent: the answer Claude Code reads ----------------------------------------------------------------

function preTool(config: Config | null, command: unknown, sessionId: unknown = "s", tool = "Bash"): Captured {
  const output = new Captured();
  const event = { hook_event_name: "PreToolUse", session_id: sessionId, tool_name: tool, tool_input: { command } };
  assert.equal(preToolEvent(event, config, output), 0);
  return output;
}

function decision(output: Captured): unknown {
  return output.stdout ? JSON.parse(output.stdout).hookSpecificOutput.permissionDecision : null;
}

test("the pre-tool hook prints allow or ask as hook JSON and names no path", () => {
  const config = granted();
  const allow = preTool(config, "rcllr read a --allow-sensitive " + HAUS);
  const ask = preTool(config, "rcllr read a --allow-sensitive topics/finanzen/");
  assert.equal(decision(allow), "allow");
  assert.equal(decision(ask), "ask");
  for (const output of [allow, ask]) {
    const parsed = JSON.parse(output.stdout).hookSpecificOutput;
    assert.equal(parsed.hookEventName, "PreToolUse");
    assert.ok(!output.stdout.includes("haus") && !output.stdout.includes("finanzen"), output.stdout);
    assert.equal(output.stderr, "");
  }
});

test("the pre-tool hook stays silent for other tools, plain calls and unusable events", () => {
  const config = granted();
  assert.equal(preTool(config, "rcllr read a --allow-sensitive " + HAUS, "s", "Read").stdout, "");
  assert.equal(preTool(config, "rcllr read a").stdout, "");
  assert.equal(preTool(config, 5).stdout, "");
  for (const event of [null, [], "x", {}, { tool_name: "Bash" }, { tool_name: "Bash", tool_input: [] }]) {
    const output = new Captured();
    assert.equal(preToolEvent(event, config, output), 0);
    assert.equal(output.stdout, "");
  }
});

test("a missing or odd session id asks", () => {
  const config = granted();
  assert.equal(decision(preTool(config, "rcllr read a --allow-sensitive " + HAUS, null)), "ask");
  assert.equal(decision(preTool(config, "rcllr read a --allow-sensitive " + HAUS, 5)), "ask");
});

// --- promptEvent: grants from the user's own words -------------------------------------------------------------

function prompt(config: Config, text: unknown, sessionId: unknown = "s"): Captured {
  const output = new Captured();
  assert.equal(promptEvent({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: text }, config, output), 0);
  return output;
}

test("a prompt naming a topic grants it to that session, silently", () => {
  const config = hub().config;
  const output = prompt(config, "Was kostet die Wärmepumpe?");
  assert.deepEqual([output.stdout, output.stderr], ["", ""]);
  assert.deepEqual([...loadGrants(config, "s")], ["topics/haus-ulm"]);
  assert.equal(decide(config, "rcllr read a --allow-sensitive " + HAUS, "s"), "allow");
});

test("grants add up over a session and never reach another one", () => {
  const config = hub().config;
  prompt(config, "Haus Ulm");
  prompt(config, "Und jetzt etwas anderes");
  prompt(config, "Finanzen bitte", "t");
  assert.deepEqual([...loadGrants(config, "s")], ["topics/haus-ulm"]);
  assert.deepEqual([...loadGrants(config, "t")], ["topics/finanzen"]);
});

test("unusable prompt events grant nothing and print nothing", () => {
  const config = hub().config;
  prompt(config, 5);
  prompt(config, "Haus Ulm", 5);
  for (const event of [null, [], "Haus Ulm", {}]) {
    const output = new Captured();
    assert.equal(promptEvent(event, config, output), 0);
    assert.equal(output.stdout, "");
  }
  assert.deepEqual([...loadGrants(config, "s")], []);
});
