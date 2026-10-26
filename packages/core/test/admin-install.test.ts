/** Port of tests/test_install.py. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.ts";
import { type Brain, brain, GIT_ENV, german, type Invoked, invoke, runGit, spawnDev, tempDir } from "./helpers.ts";

function repo(): Brain {
  const target = brain();
  target.gitInit();
  return target;
}

function hookPath(target: Brain): string {
  return path.join(target.root, runGit(target.root, ["rev-parse", "--git-path", "hooks"]).trim(), "pre-commit");
}

/** The CLI without a brain, like main([...]) in Python. */
function cli(args: readonly string[], cwd: string): Invoked {
  const done = spawnDev(args, { cwd, encoding: "utf-8", env: { ...process.env, ...GIT_ENV } });
  return { code: done.status ?? -1, out: done.stdout, err: done.stderr };
}

const json = (target: Brain, rel: string): any => JSON.parse(target.read(rel));

test("install writes the Git hook and the agent hooks", () => {
  const target = repo();
  const result = invoke(target, ["install"]);
  assert.deepEqual([result.code, result.err], [0, ""]);
  const hook = hookPath(target);
  assert.ok(fs.statSync(hook).isFile());
  fs.accessSync(hook, fs.constants.X_OK);
  const script = fs.readFileSync(hook, "utf-8");
  assert.ok(script.includes("rcllr hook pre-commit"));
  assert.ok(!script.includes("/Users/") && !script.includes(target.root));
  const settings = json(target, ".claude/settings.json");
  const post = settings.hooks.PostToolUse[0];
  assert.equal(post.matcher, "Write|Edit|MultiEdit|Bash");
  assert.ok(post.hooks[0].command.includes("hook agent"));
  assert.ok(post.hooks[0].command.includes("$CLAUDE_PROJECT_DIR"));
  assert.ok(settings.hooks.SessionEnd[0].hooks[0].command.includes("hook agent"));
  assert.equal(json(target, ".codex/hooks.json").hooks.PostToolUse[0].matcher, "Bash|apply_patch|Edit|Write");
  assert.ok(result.out.includes("Installed"));
});

test("install is idempotent and keeps foreign settings", () => {
  const target = repo();
  target.write(".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls)"] },
    hooks: { PostToolUse: [{ matcher: "Read", hooks: [] }] } }));
  assert.equal(invoke(target, ["install"]).code, 0);
  const first = target.read(".claude/settings.json");
  assert.equal(invoke(target, ["install"]).code, 0);
  assert.equal(target.read(".claude/settings.json"), first);
  const settings = JSON.parse(first);
  assert.deepEqual(settings.permissions.allow, ["Bash(ls)", "Bash(rcllr *)", "Bash(dummkopf *)", "Bash(dk *)"]);
  assert.equal(settings.hooks.PostToolUse.length, 2);
});

test("install lets headless agents call rcllr, but asks before sensitive reads", () => {
  const target = repo();
  assert.equal(invoke(target, ["install"]).code, 0);
  assert.deepEqual(json(target, ".claude/settings.json").permissions, {
    allow: ["Bash(rcllr *)", "Bash(dummkopf *)", "Bash(dk *)"],
    ask: ["Bash(rcllr *--allow-sensitive*)", "Bash(dummkopf *--allow-sensitive*)", "Bash(dk *--allow-sensitive*)"],
  });
});

test("install keeps foreign permission rules and adds its own once", () => {
  const target = repo();
  target.write(".claude/settings.json", JSON.stringify({
    permissions: { allow: ["Bash(dk *)"], ask: ["Bash(rm *)"], deny: ["Bash(rcllr *)"] },
  }));
  assert.equal(invoke(target, ["install"]).code, 0);
  assert.deepEqual(json(target, ".claude/settings.json").permissions, {
    allow: ["Bash(dk *)", "Bash(rcllr *)", "Bash(dummkopf *)"],
    ask: ["Bash(rm *)", "Bash(rcllr *--allow-sensitive*)", "Bash(dummkopf *--allow-sensitive*)",
      "Bash(dk *--allow-sensitive*)"],
    deny: ["Bash(rcllr *)"],
  });
});

test("install rejects permissions that are not lists and changes nothing", () => {
  const target = repo();
  const broken = JSON.stringify({ permissions: { allow: "Bash(ls)" } });
  target.write(".claude/settings.json", broken);
  assert.equal(invoke(target, ["install", "--serious"]).code, 2);
  assert.equal(target.read(".claude/settings.json"), broken);
  assert.ok(!fs.existsSync(hookPath(target)));
});

test("install skips Codex when disabled", () => {
  const target = repo();
  target.configure("[extras]\ncodex_sync = false\n");
  assert.equal(invoke(target, ["install"]).code, 0);
  assert.ok(!target.exists(".codex/hooks.json"));
});

test("install never overwrites a foreign Git hook", () => {
  const target = repo();
  const hook = hookPath(target);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho mine\n");
  const result = invoke(target, ["install", "--serious"]);
  assert.equal(result.code, 2);
  assert.ok(result.err.includes("pre-commit"));
  assert.equal(fs.readFileSync(hook, "utf-8"), "#!/bin/sh\necho mine\n");
});

test("install replaces a pre-commit hook written by dummkopf before the rename", () => {
  const target = repo();
  const hook = hookPath(target);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\n# managed-by: dummkopf\ndummkopf hook pre-commit || true\n");
  assert.equal(invoke(target, ["install"]).code, 0);
  const script = fs.readFileSync(hook, "utf-8");
  assert.ok(script.includes("# managed-by: rcllr") && script.includes("rcllr hook pre-commit"));
});

test("install respects core.hooksPath", () => {
  const target = repo();
  runGit(target.root, ["config", "core.hooksPath", "githooks"]);
  assert.equal(invoke(target, ["install"]).code, 0);
  assert.ok(fs.statSync(path.join(target.root, "githooks/pre-commit")).isFile());
});

test("install outside a Git repo fails", () => {
  assert.equal(invoke(brain(), ["install"]).code, 2);
});

test("init scaffolds a brain", () => {
  const base = tempDir();
  const target = path.join(base, "my-brain");
  assert.equal(cli(["init", target, "--remote", "git@example.org:me/brain.git"], base).code, 0);
  assert.equal(loadConfig(target).repo.remote, "git@example.org:me/brain.git");
  for (const rel of ["AGENTS.md", "CLAUDE.md", ".gitignore", "INDEX.md", ".sensitive-paths", "topics", "notes",
    "bookmarks", "sources", "archive"]) {
    assert.ok(fs.existsSync(path.join(target, rel)), rel);
  }
  assert.ok(fs.readFileSync(path.join(target, "CLAUDE.md"), "utf-8").includes("AGENTS.md"));
  assert.ok(fs.statSync(path.join(target, ".git")).isDirectory());
  assert.equal(runGit(target, ["symbolic-ref", "--short", "HEAD"]).trim(), "main");
  const index = fs.readFileSync(path.join(target, "INDEX.md"), "utf-8");
  for (const heading of ["## Topics", "## Notes (flat)", "## Bookmarks"]) assert.ok(index.includes(heading));
});

test("init with the German locale uses German headings", () => {
  const base = tempDir();
  const target = path.join(base, "hub");
  assert.equal(cli(["init", target, "--locale", "de"], base).code, 0);
  assert.ok(fs.readFileSync(path.join(target, "INDEX.md"), "utf-8").includes("## Notes (flach)"));
  assert.equal(loadConfig(target).ui.locale, "de");
});

test("init refuses an existing brain", () => {
  const base = tempDir();
  assert.equal(cli(["init", base], base).code, 0);
  const before = fs.readFileSync(path.join(base, "rcllr.toml"), "utf-8");
  assert.equal(cli(["init", base], base).code, 2);
  assert.equal(fs.readFileSync(path.join(base, "rcllr.toml"), "utf-8"), before);
});

test("init without a remote creates a local brain and names the remote only in a comment", () => {
  const base = tempDir();
  const result = cli(["init", base], base);
  assert.equal(result.code, 0);
  const toml = fs.readFileSync(path.join(base, "rcllr.toml"), "utf-8");
  assert.ok(toml.includes('# To sync, set a private repository: remote = "git@github.com:you/your-brain.git"'));
  assert.ok(!/^remote\s*=/m.test(toml));
  assert.ok(result.out.includes("It stays local"));
});

test("init with a remote does not ask for it again", () => {
  const base = tempDir();
  const result = cli(["init", base, "--remote", "git@example.org:me/brain.git"], base);
  assert.equal(result.code, 0);
  assert.ok(!result.out.includes("set repo.remote") && result.out.includes("rcllr install"));
});

test("AGENTS rules are rendered for the config", () => {
  const base = tempDir();
  assert.equal(cli(["init", path.join(base, "en")], base).code, 0);
  const text = fs.readFileSync(path.join(base, "en", "AGENTS.md"), "utf-8");
  assert.ok(text.includes("> SENSITIVE") && text.includes("`private`, `work`") && text.includes("key_fact"));
  assert.ok(text.includes("a `work` note must not link to a `private` note"));
  assert.ok(!/\{[a-z_]+\}/.test(text), "unfilled placeholder");
  const result = invoke(german(), ["meta", "agents"]);
  assert.equal(result.code, 0);
  for (const expected of ["> SENSIBEL", "`topics/vertraulich/`", "kernfakt", "quellen/", "Optional: Claude desktop app"]) {
    assert.ok(result.out.includes(expected), expected);
  }
});

test("hook commands find uv tool installs without fixed paths", () => {
  const target = repo();
  assert.equal(invoke(target, ["install"]).code, 0);
  const texts = [fs.readFileSync(hookPath(target), "utf-8"), target.read(".claude/settings.json"), target.read(".codex/hooks.json")];
  for (const text of texts) {
    assert.ok(text.includes("$HOME/.local/bin"));
    assert.ok(!text.includes("/Users/") && !text.includes(target.root));
  }
});

test("hook commands find node in the usual places when the agent starts them with a narrow PATH", () => {
  const target = repo();
  assert.equal(invoke(target, ["install"]).code, 0);
  const texts = [fs.readFileSync(hookPath(target), "utf-8"), target.read(".claude/settings.json"), target.read(".codex/hooks.json")];
  for (const text of texts) {
    assert.ok(text.includes('PATH=\\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\\"')
      || text.includes('PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'), text);
  }
});

test("reinstall upgrades older rcllr hook commands", () => {
  const target = repo();
  const old = 'rcllr --root "$CLAUDE_PROJECT_DIR" hook agent';
  target.write(".claude/settings.json", JSON.stringify({ hooks: {
    PostToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash", hooks: [{ type: "command", command: old }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: old }] }] } }));
  assert.equal(invoke(target, ["install"]).code, 0);
  const settings = json(target, ".claude/settings.json");
  const commands: string[] = [];
  for (const entries of Object.values(settings.hooks) as any[][]) {
    for (const entry of entries) for (const hook of entry.hooks) commands.push(hook.command);
  }
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command.includes("$HOME/.local/bin")));
});

test("a failed install changes nothing", () => {
  const target = repo();
  const hook = hookPath(target);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho mine\n");
  assert.equal(invoke(target, ["install", "--serious"]).code, 2);
  assert.ok(!target.exists(".claude/settings.json"));
  assert.ok(!target.exists(".codex/hooks.json"));
});

test("a failed install on broken settings changes nothing", () => {
  const target = repo();
  target.write(".codex/hooks.json", "{broken");
  assert.equal(invoke(target, ["install", "--serious"]).code, 2);
  assert.ok(!target.exists(".claude/settings.json"));
  assert.ok(!fs.existsSync(hookPath(target)));
});

test("init with a remote in an existing Git repo adds the Git remote", () => {
  const base = tempDir();
  const target = path.join(base, "existing");
  fs.mkdirSync(target);
  runGit(target, ["init", "-q", "-b", "main"]);
  assert.equal(cli(["init", target, "--remote", "git@example.org:me/brain.git"], base).code, 0);
  // Read the raw config: a url.insteadOf rewrite in the environment must not change the answer.
  assert.equal(runGit(target, ["config", "--get", "remote.origin.url"]).trim(), "git@example.org:me/brain.git");
});

test("install never writes through a symlink planted in the brain", () => {
  for (const plant of ["file", "folder"] as const) {
    const target = repo();
    const outside = tempDir();
    const victim = path.join(outside, "settings.json");
    fs.writeFileSync(victim, "{}\n");
    if (plant === "file") {
      fs.mkdirSync(path.join(target.root, ".claude"));
      fs.symlinkSync(victim, path.join(target.root, ".claude", "settings.json"));
    } else {
      fs.symlinkSync(outside, path.join(target.root, ".claude"));
    }
    const result = invoke(target, ["install"]);
    assert.equal(result.code, 2, plant);
    assert.ok(result.err.includes("symlink"), result.err);
    assert.equal(fs.readFileSync(victim, "utf-8"), "{}\n", plant);
    assert.ok(!fs.existsSync(hookPath(target)), "nothing is written before the check");
  }
});
