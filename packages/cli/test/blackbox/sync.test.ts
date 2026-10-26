/** Git sync: `sync`, the sync step of writes, refusals and exit code 3. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fullNote, ingest, md, newEntry, Sandbox } from "./harness.ts";
import type { Brain, Synced } from "./harness.ts";

function repo(): Brain {
  return new Sandbox().synced().brain;
}

function synced(): Synced {
  return new Sandbox().synced();
}

/** A pre-receive hook that rejects every push; fetches still work. */
function blockPushes(world: Synced): string {
  const hook = path.join(world.remote, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf-8");
  fs.chmodSync(hook, fs.statSync(hook).mode | 0o100);
  return hook;
}

// --- sync -----------------------------------------------------------------------------------------------------

test("sync of a clean brain says synced and exits 0", () => {
  const brain = repo();
  const result = brain.run(["sync"]);
  assert.deepEqual([result.code, result.out, result.err], [0, "Synced.\n", ""]);
});

test("sync of a clean brain creates no commit", () => {
  const world = synced();
  const head = world.brain.git(["rev-parse", "HEAD"]);
  world.brain.run(["sync"]);
  assert.equal(world.brain.git(["rev-parse", "HEAD"]), head);
});

test("cheeky sync says brain synced", () => {
  const brain = repo();
  assert.equal(brain.cheeky(["sync"]).out, "Brain synced.\n");
});

test("tone plain in the config makes sync neutral", () => {
  const brain = repo();
  brain.configure('[ui]\ntone = "plain"\n');
  brain.commit("config");
  assert.equal(brain.sandbox.run(["sync"], { cwd: brain.root }).out, "Synced.\n");
});

test("serious beats a cheeky config", () => {
  const brain = repo();
  brain.configure('[ui]\ntone = "cheeky"\n');
  brain.commit("config");
  assert.equal(brain.sandbox.run(["sync", "--serious"], { cwd: brain.root }).out, "Synced.\n");
});

test("sync json reports status ok", () => {
  const brain = repo();
  const result = brain.run(["sync", "--json"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out), { status: "ok" });
});

test("sync commits a hand-written note and pushes it", () => {
  const world = synced();
  world.brain.write("notes/by-hand.md", fullNote({ title: "By hand" }));
  assert.equal(world.brain.run(["sync"]).code, 0);
  assert.equal(world.remoteLog()[0], "Update notes");
  assert.ok(world.remoteFiles().includes("notes/by-hand.md"));
  assert.equal(world.brain.git(["status", "--porcelain"]), "");
});

test("sync commits changes and deletions too", () => {
  const world = synced();
  fs.unlinkSync(path.join(world.brain.root, "notes/first.md"));
  world.brain.run(["sync"]);
  assert.ok(!world.remoteFiles().includes("notes/first.md"));
});

test("sync pulls remote changes", () => {
  const world = synced();
  world.remoteEdit("notes/remote.md", fullNote({ title: "Remote" }));
  assert.equal(world.brain.run(["sync"]).code, 0);
  assert.ok(world.brain.exists("notes/remote.md"));
});

test("sync rebases local commits onto remote changes", () => {
  const world = synced();
  world.remoteEdit("notes/remote.md", fullNote({ title: "Remote" }));
  world.brain.write("notes/local.md", fullNote({ title: "Local" }));
  assert.equal(world.brain.run(["sync"]).code, 0);
  const files = world.remoteFiles();
  for (const rel of ["notes/remote.md", "notes/local.md"]) assert.ok(files.includes(rel), rel);
  assert.equal(world.brain.git(["log", "--format=%s", "-1"]), "Update notes");
});

test("sync pushes commits made by hand", () => {
  const world = synced();
  world.brain.write("notes/committed.md", fullNote({ title: "Committed" }));
  world.brain.commit("My own message");
  world.brain.run(["sync"]);
  assert.equal(world.remoteLog()[0], "My own message");
});

test("sync uses the configured commit message", () => {
  const world = synced();
  world.brain.repoOption('commit_message = "Brain update"');
  world.brain.write("notes/by-hand.md", fullNote({ title: "By hand" }));
  world.brain.run(["sync"]);
  assert.equal(world.remoteLog()[0], "Brain update");
});

test("sync with auto_push false commits locally only", () => {
  const world = synced();
  world.brain.repoOption("auto_push = false");
  world.brain.write("notes/by-hand.md", fullNote({ title: "By hand" }));
  assert.equal(world.brain.run(["sync"]).code, 0);
  assert.equal(world.brain.git(["log", "--format=%s", "-1"]), "Update notes");
  assert.ok(!world.remoteFiles().includes("notes/by-hand.md"));
});

test("sync_exclude keeps listed paths out of the commit", () => {
  const world = synced();
  world.brain.repoOption('sync_exclude = ["tooling/"]');
  world.brain.write("tooling/script.sh", "echo hi\n");
  world.brain.write("notes/by-hand.md", fullNote({ title: "By hand" }));
  world.brain.run(["sync"]);
  assert.ok(world.remoteFiles().includes("notes/by-hand.md"));
  assert.ok(!world.remoteFiles().includes("tooling/script.sh"));
  assert.equal(world.brain.git(["status", "--porcelain"]), "?? tooling/");
});

test("sync_exclude keeps staged foreign changes staged", () => {
  const world = synced();
  world.brain.repoOption('sync_exclude = ["tooling/"]');
  world.brain.write("tooling/script.sh", "echo hi\n");
  world.brain.git(["add", "tooling/script.sh"]);
  world.brain.write("notes/by-hand.md", fullNote({ title: "By hand" }));
  world.brain.run(["sync"]);
  assert.equal(world.brain.git(["status", "--porcelain"]), "A  tooling/script.sh");
  assert.ok(!world.remoteFiles().includes("tooling/script.sh"));
});

// --- refusals -------------------------------------------------------------------------------------------------

test("sync on another branch exits 2", () => {
  const brain = repo();
  brain.git(["checkout", "-q", "-b", "other"]);
  const result = brain.run(["sync"]);
  assert.equal(result.code, 2);
  assert.equal(result.err, "Sync needs branch main.\n");
});

test("sync with a different remote URL exits 2", () => {
  const brain = repo();
  brain.git(["remote", "set-url", "origin", "/somewhere/else.git"]);
  const result = brain.run(["sync"]);
  assert.equal(result.code, 2);
  assert.equal(result.err, "Remote origin does not match repo.remote in rcllr.toml.\n");
});

test("sync without the configured remote name exits 2", () => {
  const brain = repo();
  brain.git(["remote", "rename", "origin", "upstream"]);
  assert.equal(brain.run(["sync"]).code, 2);
});

test("write refuses a wrong branch and writes nothing", () => {
  const brain = repo();
  brain.git(["checkout", "-q", "-b", "other"]);
  const result = brain.run(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  assert.equal(result.code, 2);
  assert.equal(result.err, "Sync needs branch main.\n");
  assert.ok(!brain.exists("notes/fresh.md"));
});

test("write refuses a wrong remote and writes nothing", () => {
  const brain = repo();
  brain.git(["remote", "set-url", "origin", "/somewhere/else.git"]);
  const result = brain.run(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  assert.equal(result.code, 2);
  assert.equal(result.err, "Remote origin does not match repo.remote in rcllr.toml.\n");
  assert.ok(!brain.exists("notes/fresh.md"));
});

test("sync in a folder that is not the Git root exits 2", () => {
  const sandbox = new Sandbox();
  const outer = path.join(sandbox.tmp, "outer");
  fs.mkdirSync(outer);
  sandbox.git(outer, ["init", "-q", "-b", "main"]);
  const inner = sandbox.brain("inner");
  fs.renameSync(inner.root, path.join(outer, "inner"));
  const result = sandbox.run(["sync", "--serious"], { cwd: path.join(outer, "inner") });
  assert.equal(result.code, 2);
  assert.equal(result.err, "The Git root does not match the brain root.\n");
});

test("sync in a folder without Git exits 2", () => {
  const brain = new Sandbox().brain();
  const result = brain.run(["sync"]);
  assert.equal(result.code, 2);
  assert.ok(result.err.startsWith("Git step failed"));
});

test("sync during an open rebase exits 2", () => {
  const brain = repo();
  fs.mkdirSync(path.join(brain.root, ".git", "rebase-merge"), { recursive: true });
  const result = brain.run(["sync"]);
  assert.equal(result.code, 2);
  assert.equal(result.err, "A Git operation is in progress. Resolve it first.\n");
});

test("sync with a diverged remote keeps local commits and exits 2", () => {
  const world = synced();
  world.brain.write("notes/first.md", fullNote({ title: "First", body: "local change" }));
  world.brain.commit("local");
  world.remoteEdit("notes/first.md", fullNote({ title: "First", body: "remote change" }));
  const result = world.brain.run(["sync"]);
  assert.equal(result.code, 2);
  assert.equal(result.err, "The remote contradicts local changes. Local commits are kept.\n");
  assert.equal(world.brain.git(["log", "--format=%s", "-1"]), "local");
  assert.equal(world.brain.git(["status", "--porcelain"]), "");
  assert.ok(world.brain.read("notes/first.md").includes("local change"));
});

test("write with a diverged remote writes nothing", () => {
  const world = synced();
  world.brain.write("notes/first.md", fullNote({ title: "First", body: "local change" }));
  world.brain.commit("local");
  world.remoteEdit("notes/first.md", fullNote({ title: "First", body: "remote change" }));
  const result = world.brain.run(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  assert.equal(result.code, 2);
  assert.equal(result.err, "The remote contradicts local changes. Local commits are kept.\n");
  assert.ok(!world.brain.exists("notes/fresh.md"));
});

test("write catches up with the remote first", () => {
  const world = synced();
  world.remoteEdit("notes/remote.md", fullNote({ title: "Remote" }));
  assert.equal(world.brain.run(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() }).code, 0);
  assert.ok(world.brain.exists("notes/remote.md"));
  const files = world.remoteFiles();
  for (const rel of ["notes/remote.md", "notes/fresh.md"]) assert.ok(files.includes(rel), rel);
});

test("cheeky dirty tree message scolds but keeps the instruction", () => {
  const brain = repo();
  brain.write("notes/by-hand.md", md());
  const result = brain.cheeky(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  assert.equal(result.code, 2);
  assert.equal(result.err, "Tidy up first. "
    + "The brain has uncommitted note changes. Run `rcllr sync` first.\n");
});

// --- exit code 3 ----------------------------------------------------------------------------------------------

test("failed push after a write exits 3 and keeps the save", () => {
  const world = synced();
  blockPushes(world);
  const result = world.brain.run(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  assert.equal(result.code, 3);
  assert.equal(result.out, "Write status: saved; sync: failed\nChanged: notes/fresh.md\n");
  assert.equal(result.err, "Markdown saved, but Git sync failed. Retry with `rcllr sync`.\n");
  assert.ok(world.brain.exists("notes/fresh.md"));
  assert.equal(world.brain.git(["log", "--format=%s", "-1"]), "Update notes");
  assert.deepEqual(world.remoteLog(), ["Initial"]);
});

test("a refused SSH login on push names the login after the save", () => {
  const world = synced();
  // A pre-push hook stands in for SSH: a push URL other than the remote would be refused before the save.
  const hook = path.join(world.brain.root, world.brain.git(["rev-parse", "--git-path", "hooks"]), "pre-push");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 1\n", "utf-8");
  fs.chmodSync(hook, 0o755);
  const result = world.brain.run(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  assert.equal(result.code, 3);
  assert.equal(result.err, "Markdown saved, but Git sync failed. Retry with `rcllr sync`.\n"
    + "Git could not log in to the remote. Local data is kept. For an SSH remote, test the login with "
    + "`ssh -T git@<host>`; `gh auth` does not cover SSH.\n");
  assert.ok(!result.err.includes("example.invalid"));
});

test("exit 3 json reports saved true and sync failed", () => {
  const world = synced();
  blockPushes(world);
  const result = world.brain.run(["write", "notes/fresh.md", "--expected", "new", "--json"], { stdin: md() });
  assert.equal(result.code, 3);
  const data = JSON.parse(result.out);
  assert.deepEqual([data.saved, data.sync], [true, "failed"]);
  assert.equal(result.err, "Markdown saved, but Git sync failed. Retry with `rcllr sync`.\n");
});

test("exit 3 applies to ingest too", () => {
  const world = synced();
  blockPushes(world);
  assert.equal(ingest(world.brain, [newEntry("notes/one.md"), newEntry("notes/two.md")]).code, 3);
});

test("cheeky exit 3 message keeps the instruction", () => {
  const world = synced();
  blockPushes(world);
  const result = world.brain.cheeky(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  assert.equal(result.code, 3);
  assert.equal(result.err, "Half a brain is better than none. "
    + "Markdown saved, but Git sync failed. Retry with `rcllr sync`.\n");
});

test("sync after exit 3 pushes once pushes work again", () => {
  const world = synced();
  const hook = blockPushes(world);
  world.brain.run(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  const failing = world.brain.run(["sync"]);
  assert.equal(failing.code, 2);
  assert.equal(failing.err, "Git step failed: push. Local data is kept.\n");
  fs.unlinkSync(hook);
  assert.equal(world.brain.run(["sync"]).code, 0);
  assert.ok(world.remoteFiles().includes("notes/fresh.md"));
});

test("a blocked push does not leak Git output", () => {
  const world = synced();
  blockPushes(world);
  world.brain.write("notes/by-hand.md", fullNote({ title: "By hand" }));
  const result = world.brain.run(["sync"]);
  assert.equal(result.code, 2);
  assert.ok(!(result.err + result.out).includes("pre-receive"));
  assert.equal(result.err, "Git step failed: push. Local data is kept.\n");
});

test("failed sync after write leaves the working tree clean", () => {
  const world = synced();
  blockPushes(world);
  world.brain.run(["write", "notes/fresh.md", "--expected", "new"], { stdin: md() });
  assert.equal(world.brain.git(["status", "--porcelain"]), "");
});
