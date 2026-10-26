/** Port of tests/test_sync.py: Git sync, ingest with sync, rollback and the repository lock. */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";

import { Access } from "../src/access.ts";
import { RcllrError, SyncError } from "../src/errors.ts";
import { withRepositoryLock } from "../src/lock.ts";
import { defaultConfig } from "../src/config.ts";
import {
  checkCommitMessage, committedPaths, notePathspec, prepareRepository, remoteFailure, syncRepository,
} from "../src/sync.ts";
import { atomicWrite, ingest, seams } from "../src/write.ts";
import { documentText as document, invoke, REPO, revision, type Synced, synced, tempDir } from "./helpers.ts";

process.setMaxListeners(0);

type Item = Record<string, unknown>;

function packet(s: Synced, rel = "notes/first.md", body = "New content"): { changes: Item[] } {
  const expected = s.brain.exists(rel) ? revision(s.brain, rel) : null;
  return { changes: [{ path: rel, content: document({ body }), expected }] };
}

function caught(body: () => unknown): RcllrError {
  try {
    body();
  } catch (error) {
    assert.ok(error instanceof RcllrError, String(error));
    return error;
  }
  assert.fail("no error");
}

/** Replace a write step for one call, like Python's unittest.mock.patch. */
function patched<K extends keyof typeof seams, T>(name: K, replacement: (typeof seams)[K], body: () => T): T {
  const original = seams[name];
  seams[name] = replacement;
  try {
    return body();
  } finally {
    seams[name] = original;
  }
}

function repoOption(s: Synced, line: string): void {
  s.brain.toml = s.brain.toml.replace("[repo]\n", "[repo]\n" + line + "\n");
  s.brain.configure("");
}

function excludeTools(s: Synced): void {
  repoOption(s, "sync_exclude = ['scripts', 'tool']");
  s.brain.commit("Configure");
  s.git(["push", "-q"]);
}

describe("sync", () => {
  test("sync commits and pushes change", () => {
    const s = synced();
    s.brain.write("notes/first.md", "updated\n");
    syncRepository(s.brain.config);
    assert.equal(s.git(["status", "--porcelain"]), "");
    assert.equal(s.git(["rev-parse", "HEAD"]), s.git(["rev-parse", "origin/main"]));
    assert.equal(s.git(["log", "-1", "--format=%s"]), "Update notes");
  });

  test("a hand-built config with an option-like remote never reaches git", () => {
    const s = synced();
    s.brain.write("notes/first.md", "updated\n");
    const base = s.brain.config;
    const config = { ...base, repo: { ...base.repo, remoteName: "--upload-pack=touch pwned" } };
    assert.equal(caught(() => syncRepository(config)).key, "git_branch");
    assert.ok(!fs.existsSync(path.join(s.brain.root, "pwned")));
  });

  test("commit message comes from config", () => {
    const s = synced();
    repoOption(s, "commit_message = 'Brain dump'");
    s.brain.write("notes/first.md", "updated\n");
    syncRepository(s.brain.config);
    assert.equal(s.git(["log", "-1", "--format=%s"]), "Brain dump");
  });

  test("sync pushes existing local commit", () => {
    const s = synced();
    s.brain.write("notes/first.md", "updated\n");
    s.brain.commit("Earlier edit");
    syncRepository(s.brain.config);
    assert.equal(s.git(["rev-parse", "HEAD"]), s.git(["rev-parse", "origin/main"]));
    assert.equal(s.git(["log", "-1", "--format=%s"]), "Earlier edit");
  });

  test("sync preserves other fetch head", () => {
    const s = synced();
    s.git(["fetch", "origin"]);
    const fetchHead = path.join(s.brain.root, ".git", "FETCH_HEAD");
    const shared = fs.readFileSync(fetchHead, "utf-8").repeat(2);
    fs.writeFileSync(fetchHead, shared);
    s.brain.write("notes/first.md", "updated\n");
    syncRepository(s.brain.config);
    assert.equal(fs.readFileSync(fetchHead, "utf-8"), shared);
    assert.equal(s.git(["rev-parse", "HEAD"]), s.git(["rev-parse", "refs/heads/main"], s.remote));
  });

  test("sync rebases remote change", () => {
    const s = synced();
    s.remoteEdit("notes/remote.md", "remote edit\n");
    s.brain.write("notes/first.md", "local edit\n");
    syncRepository(s.brain.config);
    assert.equal(s.brain.read("notes/remote.md"), "remote edit\n");
    assert.equal(s.brain.read("notes/first.md"), "local edit\n");
    assert.equal(s.git(["status", "--porcelain"]), "");
    assert.equal(s.git(["rev-parse", "HEAD"]), s.git(["rev-parse", "refs/heads/main"], s.remote));
  });

  test("sync leaves excluded paths uncommitted", () => {
    const s = synced();
    excludeTools(s);
    s.brain.write("scripts/tool.py", "draft\n");
    s.brain.write("notes/first.md", "updated\n");
    syncRepository(s.brain.config);
    assert.equal(s.git(["status", "--porcelain", "--untracked-files=all"]), "?? scripts/tool.py");
    assert.equal(s.git(["show", "--name-only", "--format=", "HEAD"]), "notes/first.md");
  });

  test("a foreign staged rename stays staged and out of the note commit", () => {
    const s = synced();
    excludeTools(s);
    s.brain.write("scripts/tool-old.py", "print('tool')\n");
    s.brain.commit("Add tool");
    s.git(["push", "-q"]);
    s.git(["mv", "scripts/tool-old.py", "scripts/tool-new.py"]);
    s.brain.write("notes/first.md", "updated\n");
    syncRepository(s.brain.config);
    assert.equal(s.git(["show", "--name-only", "--format=", "HEAD"]), "notes/first.md");
    assert.equal(s.git(["status", "--porcelain"]), "R  scripts/tool-old.py -> scripts/tool-new.py");
  });

  test("sync with only excluded changes creates no commit", () => {
    const s = synced();
    excludeTools(s);
    const before = s.git(["rev-parse", "HEAD"]);
    s.brain.write("tool", "cli\n");
    syncRepository(s.brain.config);
    assert.equal(s.git(["rev-parse", "HEAD"]), before);
    assert.equal(s.git(["status", "--porcelain"]), "?? tool");
  });

  test("sync rebases remote change with dirty excluded file", () => {
    const s = synced();
    excludeTools(s);
    s.brain.write("scripts/tool.py", "v1\n");
    s.brain.commit("Add tool");
    s.git(["push", "-q"]);
    s.remoteEdit("notes/remote.md", "remote edit\n");
    s.brain.write("scripts/tool.py", "v2 draft\n");
    s.brain.write("notes/first.md", "local edit\n");
    syncRepository(s.brain.config);
    assert.equal(s.brain.read("notes/remote.md"), "remote edit\n");
    assert.equal(s.brain.read("scripts/tool.py"), "v2 draft\n");
    assert.equal(s.git(["status", "--porcelain"]), "M scripts/tool.py");
  });

  test("prepare ignores excluded changes but not note changes", () => {
    const s = synced();
    excludeTools(s);
    s.brain.write("scripts/tool.py", "draft\n");
    prepareRepository(s.brain.config);
    s.brain.write("notes/first.md", "updated\n");
    const error = caught(() => prepareRepository(s.brain.config));
    assert.ok(error instanceof SyncError);
    assert.equal(error.key, "git_dirty");
  });

  test("a remote that refuses the SSH login fails as git_auth and never echoes Git's text", () => {
    const s = synced();
    const url = "git@example.invalid:me/brain.git";
    s.brain.toml = s.brain.toml.replace(s.remote, url);
    s.brain.configure("");
    s.git(["remote", "set-url", "origin", url]);
    const ssh = s.base + "/fake-ssh"; // Git runs core.sshCommand through sh, which eats backslashes.
    fs.writeFileSync(ssh, "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255\n");
    fs.chmodSync(ssh, 0o755);
    s.git(["config", "core.sshCommand", ssh]);
    s.brain.write("notes/first.md", "updated\n");
    const error = caught(() => syncRepository(s.brain.config));
    assert.ok(error instanceof SyncError);
    assert.equal(error.key, "git_auth");
    assert.ok(!error.message.includes("example.invalid"));
  });

  test("a push that loses the race against another machine fetches, rebases and pushes again", () => {
    const s = synced();
    const other = path.join(s.base, "other");
    s.git(["clone", "-q", "-b", "main", s.remote, other], s.base);
    fs.writeFileSync(path.join(other, "notes", "elsewhere.md"), document({ body: "From the other machine" }));
    s.git(["add", "-A"], other);
    s.git(["commit", "-q", "-m", "Other machine"], other);
    // The other machine pushes after this brain fetched, right before its own push lands.
    const hook = path.join(s.brain.root, ".git", "hooks", "pre-push");
    fs.writeFileSync(hook, "#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n"
      + "[ -f \"$0.done\" ] && exit 0\ntouch \"$0.done\"\ngit -C '" + other + "' push -q origin main\n");
    fs.chmodSync(hook, 0o755);
    s.brain.write("notes/first.md", "updated\n");
    syncRepository(s.brain.config);
    assert.equal(s.git(["rev-parse", "HEAD"]), s.git(["rev-parse", "refs/heads/main"], s.remote));
    assert.ok(s.brain.exists("notes/elsewhere.md"));
    assert.equal(s.git(["log", "-1", "--format=%s"]), "Update notes");
  });

  test("sync refuses other remote", () => {
    const s = synced();
    s.git(["remote", "set-url", "origin", "git@example.org:other/repo.git"]);
    s.brain.write("notes/first.md", "updated\n");
    assert.equal(caught(() => syncRepository(s.brain.config)).key, "git_remote");
    assert.notEqual(s.git(["status", "--porcelain"]), "");
  });

  test("sync refuses other branch", () => {
    const s = synced();
    s.git(["checkout", "-q", "-b", "experiment"]);
    s.brain.write("notes/first.md", "updated\n");
    assert.equal(caught(() => syncRepository(s.brain.config)).key, "git_branch");
    assert.notEqual(s.git(["status", "--porcelain"]), "");
  });

  test("auto push false commits locally only", () => {
    const s = synced();
    repoOption(s, "auto_push = false");
    s.brain.commit("Configure"); // rcllr.toml is never part of a rcllr commit
    const remoteHead = s.git(["rev-parse", "refs/heads/main"], s.remote);
    s.brain.write("notes/first.md", "updated\n");
    syncRepository(s.brain.config);
    assert.equal(s.git(["status", "--porcelain"]), "");
    assert.equal(s.git(["rev-parse", "refs/heads/main"], s.remote), remoteHead);
  });

  test("ingest commits and pushes one validated batch", () => {
    const s = synced();
    const data = packet(s);
    data.changes.push({ path: "notes/second.md", content: document(), expected: null });
    const before = Number(s.git(["rev-list", "--count", "HEAD"]));
    const result = ingest(new Access(s.brain.config), data);
    assert.equal(result.sync, "ok");
    assert.equal(Number(s.git(["rev-list", "--count", "HEAD"])), before + 1);
    assert.equal(s.git(["rev-parse", "HEAD"]), s.git(["rev-parse", "main"], s.remote));
    assert.equal(s.git(["status", "--porcelain"]), "");
  });

  test("refresh brings remote change without local commit", () => {
    const s = synced();
    s.remoteEdit("notes/remote.md", document());
    syncRepository(s.brain.config, true);
    assert.ok(s.brain.exists("notes/remote.md"));
  });

  test("remote refresh invalidates a prepared revision", () => {
    const s = synced();
    const data = packet(s, "notes/first.md", "Stale local edit");
    s.remoteEdit("notes/first.md", document({ body: "Remote content" }));
    assert.equal(caught(() => ingest(new Access(s.brain.config), data)).key, "version_conflict");
    assert.ok(s.brain.read("notes/first.md").includes("Remote content"));
    assert.equal(s.git(["status", "--porcelain"]), "");
  });

  test("sync conflict aborts rebase and preserves local commit", () => {
    const s = synced();
    s.remoteEdit("notes/first.md", document({ body: "Remote content" }));
    s.brain.write("notes/first.md", document({ body: "Local content" }));
    const error = caught(() => syncRepository(s.brain.config));
    assert.ok(error instanceof SyncError);
    assert.equal(error.key, "git_diverged");
    assert.ok(s.brain.read("notes/first.md").includes("Local content"));
    assert.equal(s.git(["status", "--porcelain"]), "");
    assert.ok(!s.brain.exists(".git/rebase-merge"));
  });

  test("sync errors never echo git output", () => {
    const s = synced();
    s.remoteEdit("notes/first.md", document({ body: "Remote SECRET content" }));
    s.brain.write("notes/first.md", document({ body: "Local SECRET content" }));
    const done = invoke(s.brain, ["sync"]);
    assert.equal(done.code, 2);
    assert.ok(!(done.out + done.err).includes("SECRET"));
    assert.ok(done.err.includes("Local commits are kept"));
  });

  test("sync failure reports saved files and exit code 3", () => {
    const s = synced();
    const result = patched("syncLocked", () => {
      throw new SyncError("git_unavailable");
    }, () => ingest(new Access(s.brain.config), packet(s)));
    assert.ok(result.sync === "failed" && result.saved);
    assert.ok(s.brain.read("notes/first.md").includes("New content"));
    s.git(["checkout", "--", "."]);
    // The CLI runs in a subprocess, so a remote that refuses the push stands in for the patch.
    const hook = path.join(s.remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const done = invoke(s.brain, ["write", "notes/first.md", "--expected", revision(s.brain, "notes/first.md").slice(0, 12),
      "--serious"], document({ body: "Third" }));
    assert.equal(done.code, 3, done.err);
    assert.ok(done.out.includes("sync: failed"));
    assert.ok(done.err.includes("Retry with `rcllr sync`"));
  });

  test("cli sync reports in tone", () => {
    const s = synced();
    assert.equal(invoke(s.brain, ["sync"]).out, "Synced.\n");
    s.brain.configure("[ui]\ntone = 'cheeky'\n");
    assert.equal(invoke(s.brain, ["sync"]).out, "Brain synced.\n");
    assert.equal(invoke(s.brain, ["sync", "--serious"]).out, "Synced.\n");
  });

  test("write failure rolls back earlier changes", () => {
    const s = synced();
    const before = fs.readFileSync(path.join(s.brain.root, "notes/first.md"));
    const data = packet(s);
    data.changes.push({ path: "notes/second.md", content: document(), expected: null });
    const error = patched("atomicWrite", (target, content) => {
      if (path.basename(target) === "second.md") throw Object.assign(new Error("Full disk"), { code: "ENOSPC", errno: -28 });
      atomicWrite(target, content);
    }, () => caught(() => ingest(new Access(s.brain.config), data, false, false)));
    assert.equal(error.key, "not_saved");
    assert.deepEqual(fs.readFileSync(path.join(s.brain.root, "notes/first.md")), before);
    assert.ok(!s.brain.exists("notes/second.md"));
  });

  test("rollback never overwrites a foreign change", () => {
    const s = synced();
    const data = packet(s);
    data.changes.push({ path: "notes/second.md", content: document(), expected: null });
    const error = patched("atomicWrite", (target, content) => {
      if (path.basename(target) === "second.md") {
        fs.writeFileSync(path.join(s.brain.root, "notes/first.md"), "Foreign change");
        throw Object.assign(new Error("Full disk"), { code: "ENOSPC", errno: -28 });
      }
      atomicWrite(target, content);
    }, () => caught(() => ingest(new Access(s.brain.config), data, false, false)));
    assert.equal(error.key, "rollback_failed");
    assert.equal(s.brain.read("notes/first.md"), "Foreign change");
  });

  test("parallel ingests accept only one version", async () => {
    const s = synced();
    const src = (name: string): string => pathToFileURL(path.join(REPO, "packages/core/src", name)).href;
    const worker = path.join(tempDir(), "worker.mjs");
    fs.writeFileSync(worker, [
      'import * as fs from "node:fs";',
      'import { Access } from "' + src("access.ts") + '";',
      'import { loadConfig } from "' + src("config.ts") + '";',
      'import { ingest } from "' + src("write.ts") + '";',
      "const packet = JSON.parse(fs.readFileSync(0, \"utf-8\"));",
      "process.stdout.write(JSON.stringify(ingest(new Access(loadConfig(process.argv[2])), packet, false, false)));",
    ].join("\n"));
    const packets = [packet(s, "notes/first.md", "First worker"), packet(s, "notes/first.md", "Second worker")];
    const codes = await Promise.all(packets.map((data) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", worker, s.brain.root],
        { stdio: ["pipe", "ignore", "ignore"] });
      child.on("exit", (code) => resolve(code ?? -1));
      child.stdin.end(JSON.stringify(data));
    })));
    assert.deepEqual(codes.map((code) => code === 0).sort(), [false, true]);
  });

  test("reader waits for writer lock", () => {
    const s = synced();
    const script = 'import { withRepositoryLock } from "'
      + pathToFileURL(path.join(REPO, "packages/core/src/lock.ts")).href + '";\n'
      + "withRepositoryLock(process.argv[1], () => {}, 0.1);\n";
    const result = withRepositoryLock(s.brain.root, () => spawnSync(process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, s.brain.root],
      { encoding: "utf-8", timeout: 10_000 }));
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("busy"), result.stderr);
  });
});

describe("commit scope and message", () => {
  test("committed paths are the note folders, content folders and generated files", () => {
    const config = defaultConfig("/brain", { links: { output: "maps/LINKS.md" } });
    assert.deepEqual(committedPaths(config), ["topics", "notes", "bookmarks", "sources", "archive", "INDEX.md",
      ".sensitive-paths", "maps/LINKS.md", "topics/curator", "routes.json", "entities.txt"]);
  });

  test("the pathspec never widens to the whole tree", () => {
    const pathspec = notePathspec(defaultConfig("/brain", { repo: { sync_exclude: ["notes/drafts/"] } }));
    assert.ok(!pathspec.includes("."));
    assert.equal(pathspec.at(-1), ":(exclude)notes/drafts/");
  });

  for (const bad of ["", " ", "a\nb", "a\rb", "a\tb", "a\u2028b", "x".repeat(201)]) {
    test("commit message " + JSON.stringify(bad.slice(0, 12)) + " is rejected", () => {
      assert.equal(caught(() => checkCommitMessage(bad)).key, "commit_message_invalid");
    });
  }

  test("a one-line message and no message pass", () => {
    checkCommitMessage("Add a note about Docker");
    checkCommitMessage("ä".repeat(200));
    checkCommitMessage(null);
  });

  test("ingest checks the message before it writes anything", () => {
    const s = synced();
    const error = caught(() => ingest(new Access(s.brain.config), packet(s), false, true, "two\nlines"));
    assert.equal(error.key, "commit_message_invalid");
    assert.equal(s.git(["status", "--porcelain"]), "");
  });
});

describe("remote failures", () => {
  test("login failures over SSH and HTTPS count as auth", () => {
    for (const stderr of [
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      "Host key verification failed.\nfatal: Could not read from remote repository.",
      "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/me/brain.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ]) assert.equal(remoteFailure(stderr), "git_auth", stderr);
  });

  test("anything else stays a plain Git failure", () => {
    for (const stderr of ["", "fatal: Could not read from remote repository.", "error: failed to push some refs"]) {
      assert.equal(remoteFailure(stderr), null, stderr);
    }
  });
});
