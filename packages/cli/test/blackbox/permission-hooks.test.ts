/** `hook prompt` and `hook pre-tool`: Claude Code asks before sensitive calls only when no named topic covers them. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type Brain, type Result, Sandbox } from "./harness.ts";

const READ = "rcllr read topics/haus-ulm/a.md --allow-sensitive topics/haus-ulm/";

function hub(sandbox: Sandbox): Brain {
  const target = sandbox.brain("hub");
  target.gitInit();
  target.write(".sensitive-paths", "# generated\ntopics/haus-ulm/\n");
  target.write("topics/haus-ulm/README.md", "---\nscope: work\naliases: [Wärmepumpe]\n---\n\n> SENSITIVE\n\n# Haus\n");
  return target;
}

function prompt(sandbox: Sandbox, root: string, text: string, sessionId = "s1"): Result {
  const stdin = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: text, cwd: root });
  return sandbox.run(["hook", "prompt", "--root", root], { cwd: root, stdin });
}

function preTool(sandbox: Sandbox, root: string, command: string, sessionId = "s1", cwd = root): Result {
  const stdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "Bash",
    tool_input: { command }, cwd });
  return sandbox.run(["hook", "pre-tool", "--root", root], { cwd, stdin });
}

function decision(result: Result): string | null {
  return result.out ? JSON.parse(result.out).hookSpecificOutput.permissionDecision : null;
}

test("a sensitive call asks until the user names the topic, then it is allowed", () => {
  const sandbox = new Sandbox();
  const target = hub(sandbox);
  assert.equal(decision(preTool(sandbox, target.root, READ)), "ask");
  const named = prompt(sandbox, target.root, "Was kostet die Wärmepumpe?");
  assert.deepEqual([named.code, named.out, named.err], [0, "", ""]);
  const allowed = preTool(sandbox, target.root, READ);
  assert.deepEqual([allowed.code, decision(allowed), allowed.err], [0, "allow", ""]);
  assert.equal(decision(preTool(sandbox, target.root, READ, "s2")), "ask");
});

test("a granted call in a chain with git leaves the decision to Claude Code", () => {
  const sandbox = new Sandbox();
  const target = hub(sandbox);
  prompt(sandbox, target.root, "Haus Ulm");
  const result = preTool(sandbox, target.root, "git fetch && " + READ + " && git push");
  assert.deepEqual([result.code, result.out], [0, ""]);
});

test("a plain call gets no answer", () => {
  const sandbox = new Sandbox();
  const target = hub(sandbox);
  const result = preTool(sandbox, target.root, "rcllr read notes/a.md");
  assert.deepEqual([result.code, result.out, result.err], [0, "", ""]);
});

test("outside a brain a sensitive call asks and other calls get no answer", () => {
  const sandbox = new Sandbox();
  const stdin = (command: string): string => JSON.stringify({ tool_name: "Bash", session_id: "s", tool_input: { command } });
  const sensitive = sandbox.run(["hook", "pre-tool"], { cwd: sandbox.tmp, stdin: stdin(READ) });
  assert.deepEqual([sensitive.code, decision(sensitive)], [0, "ask"]);
  const plain = sandbox.run(["hook", "pre-tool"], { cwd: sandbox.tmp, stdin: stdin("ls") });
  assert.deepEqual([plain.code, plain.out], [0, ""]);
  const named = sandbox.run(["hook", "prompt"], { cwd: sandbox.tmp, stdin: JSON.stringify({ prompt: "x", session_id: "s" }) });
  assert.deepEqual([named.code, named.out, named.err], [0, "", ""]);
});

for (const raw of ["", "not json", "[]", "null", "{}", '{"tool_name": "Bash", "tool_input": {"command": 5}}']) {
  test("unusable event " + JSON.stringify(raw) + " exits 0 without output", () => {
    const sandbox = new Sandbox();
    const target = hub(sandbox);
    for (const kind of ["prompt", "pre-tool"]) {
      const result = sandbox.run(["hook", kind, "--root", target.root], { cwd: target.root, stdin: raw });
      assert.deepEqual([result.code, result.out, result.err], [0, "", ""], kind);
    }
  });
}
