/** Port of tests/test_hooks.py. A stand-in sync function replaces unittest.mock.patch. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { Access } from "../src/access.ts";
import type { Config } from "../src/config.ts";
import { agentEvent, type HookOutput, isBrainPath, preCommit, stage } from "../src/hook.ts";
import { syncRepository } from "../src/sync.ts";
import { ingest } from "../src/write.ts";
import { type Brain, brain, DEV_BIN, documentText, GIT_ENV, invoke, revision, spawnDev, synced, tempDir } from "./helpers.ts";

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

/** A sync stand-in that only counts calls. */
function counter(): { calls: number; sync: (config: Config) => void } {
  const state = { calls: 0, sync: (_config: Config): void => { state.calls++; } };
  return state;
}

for (const event of [{ tool_name: "Bash" }, { tool_name: "exec_command" }, { tool_name: "apply_patch" },
  { hook_event_name: "SessionEnd" }]) {
  test("shell tools and session end trigger a sync: " + JSON.stringify(event), () => {
    const target = brain();
    const sync = counter();
    assert.equal(agentEvent({ ...event, cwd: target.root }, target.config, new Captured(), sync.sync), 0);
    assert.equal(sync.calls, 1);
  });
}

for (const [tool, where] of [["Read", "ROOT"], ["Bash", "PARENT"]] as const) {
  test("unknown tool or other project does not trigger a sync: " + tool, () => {
    const target = brain();
    const cwd = where === "ROOT" ? target.root : path.dirname(target.root);
    const sync = counter();
    assert.equal(agentEvent({ tool_name: tool, cwd }, target.config, new Captured(), sync.sync), 0);
    assert.equal(sync.calls, 0);
  });
}

test("a native file edit from another cwd matches the brain path", () => {
  const target = brain();
  const event = { tool_name: "Edit", cwd: path.dirname(target.root),
    tool_input: { file_path: path.join(target.root, "notes/a.md") } };
  const sync = counter();
  assert.equal(agentEvent(event, target.config, new Captured(), sync.sync), 0);
  assert.equal(sync.calls, 1);
});

test("a malformed payload does not trigger a sync", () => {
  const target = brain();
  const parent = path.dirname(target.root);
  for (const event of [null, [], { tool_name: "Bash", cwd: 42 }, { tool_name: [], cwd: target.root },
    { tool_name: "Edit", tool_input: null, cwd: parent }]) {
    const sync = counter();
    assert.equal(agentEvent(event, target.config, new Captured(), sync.sync), 0);
    assert.equal(sync.calls, 0, JSON.stringify(event));
  }
});

test("a failed sync is non-blocking", () => {
  const repo = synced();
  repo.git(["remote", "set-url", "origin", "git@example.org:other/repo.git"]);
  const output = new Captured();
  assert.equal(agentEvent({ tool_name: "Bash", cwd: repo.brain.root }, repo.brain.config, output, syncRepository), 1);
  assert.ok(output.stderr.includes("rcllr sync failed"));
});

test("the hook command never returns 2", () => {
  const base = tempDir();
  for (const kind of ["agent", "pre-commit"]) {
    const done = spawnDev(["--root", base, "hook", kind], {
      cwd: base, input: JSON.stringify({ tool_name: "Bash", cwd: base }), encoding: "utf-8",
    });
    assert.equal(done.status, 0, kind);
  }
});

test("only brain paths match", () => {
  const target = brain();
  const other = path.join(path.dirname(target.root), "other");
  fs.mkdirSync(other);
  assert.ok(isBrainPath(target.root, target.root));
  assert.ok(isBrainPath(path.join(target.root, "notes"), target.root));
  assert.ok(!isBrainPath(other, target.root));
});

test("pre-commit regenerates the paths file and the indexes", () => {
  const repo = synced();
  const target = repo.brain;
  target.write("INDEX.md", "# Index\n\n## Topics\n\n## Notes (flat)\n\n## Bookmarks\n");
  target.write("notes/hidden.md", documentText({ body: "> SENSITIVE" }));
  target.write("notes/raw.md", "# Raw\n");
  repo.git(["add", "-A"]);
  assert.equal(preCommit(target.config, new Captured()), 0);
  assert.ok(target.read(".sensitive-paths").includes("notes/hidden.md"));
  assert.ok(target.read("notes/raw.md").startsWith("---\n"));
  const index = target.read("INDEX.md");
  assert.ok(index.includes("notes/raw.md") && !index.includes("notes/hidden.md"));
  const staged = new Set(repo.git(["diff", "--cached", "--name-only"]).split("\n"));
  for (const rel of [".sensitive-paths", "INDEX.md", "notes/raw.md"]) assert.ok(staged.has(rel), rel);
});

test("pre-commit never stages a topic README with unstaged edits, also under a non-ASCII name", () => {
  const repo = synced();
  const target = repo.brain;
  target.write("INDEX.md", "# Index\n\n## Topics\n\n## Notes (flat)\n\n## Bookmarks\n");
  target.write("topics/café/README.md", documentText({ title: "Café" }));
  target.write("topics/café/a.md", documentText({ title: "A" }));
  repo.git(["add", "-A"]);
  repo.git(["commit", "-q", "-m", "Base"]);
  const committed = target.read("topics/café/README.md");
  target.write("topics/café/b.md", documentText({ title: "B" }));
  repo.git(["add", "-A"]);
  target.write("topics/café/README.md", committed + "\nHuman edit, not staged.\n");
  assert.equal(preCommit(target.config, new Captured()), 0);
  assert.equal(repo.git(["show", ":topics/café/README.md"]) + "\n", committed);
});

test("pre-commit stages generated files by their literal path, never as a pattern", () => {
  const repo = synced();
  const target = repo.brain;
  target.write("INDEX.md", "# Index\n\n## Topics\n\n## Notes (flat)\n\n## Bookmarks\n");
  target.write("topics/real/README.md", documentText({ title: "Real" }));
  target.write("topics/real/a.md", documentText({ title: "A" }));
  repo.git(["add", "-A"]);
  repo.git(["commit", "-q", "-m", "Base"]);
  target.write("topics/real/README.md", target.read("topics/real/README.md") + "\nHuman edit, not staged.\n");
  const out = new Captured();
  // Stand-in for a generated path that Git would read as a pattern matching topics/real/README.md.
  stage(target.config, ["topics/*/README.md"], new Set(), out);
  assert.ok(!repo.git(["diff", "--cached", "--name-only"]).includes("topics/real/README.md"));
});

test("pre-commit skips repos without an index", () => {
  const target: Brain = brain();
  target.gitInit();
  target.write("notes/raw.md", "# Raw\n");
  assert.equal(preCommit(target.config, new Captured()), 0);
  assert.equal(target.read("notes/raw.md"), "# Raw\n");
});

test("the installed pre-commit hook updates the index after ingest", () => {
  const repo = synced();
  const target = repo.brain;
  // The installed hook calls `rcllr` from PATH: put the dev runner first, like the black-box suite.
  const saved = process.env.PATH;
  process.env.PATH = path.dirname(DEV_BIN) + path.delimiter + (saved ?? "");
  Object.assign(process.env, GIT_ENV);
  try {
    target.write("INDEX.md", "# Index\n\n## Topics\n\n## Notes (flat)\n\n## Bookmarks\n");
    assert.equal(invoke(target, ["install", "--serious"]).code, 0);
    target.commit("Install hooks");
    repo.git(["push", "-q"]);
    const data = { changes: [
      { path: "notes/new.md", content: documentText(), expected: null },
      { path: "topics/new/README.md", content: documentText({ scope: "work" }), expected: null },
    ] };
    const result = ingest(new Access(target.config), data) as unknown as Record<string, any>;
    assert.equal(result.sync, "ok");
    assert.ok(target.read("INDEX.md").includes("notes/new.md"));
    assert.equal(result.revisions["topics/new/README.md"], revision(target, "topics/new/README.md"));
    assert.deepEqual((ingest(new Access(target.config), data) as unknown as Record<string, any>).changed, []);
    assert.equal(repo.git(["status", "--porcelain"]), "");
  } finally {
    process.env.PATH = saved;
  }
});
