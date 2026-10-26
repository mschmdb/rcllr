/** `rcllr import-memory`: mirror Claude Code auto memory into the brain, one way, in its own scope. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { Access } from "../src/access.ts";
import { find } from "../src/search.ts";
import { claudeProjectFolder, importMemory, projectPath } from "../src/memory.ts";
import { type Brain, brain, invoke, runGit, tempDir } from "./helpers.ts";

const PROJECT = "/Users/me/Sites/shop";
const ENABLED = '[scopes]\nvalues = ["private", "work", "memory-claude"]\n'
  + '[extras]\nclaude_memory = true\n[claude_memory]\nprojects = ["' + PROJECT + '"]\n';

function memoryFile(name: string, description: string, body: string, type = "feedback"): string {
  return "---\nname: " + name + "\ndescription: " + description + "\nmetadata:\n  type: " + type
    + "\n  modified: 2026-10-20T08:00:00.000Z\n---\n\n" + body + "\n";
}

/** A Claude config folder with memory for one project. */
function claudeHome(files: Record<string, string>, project = PROJECT): string {
  const home = tempDir();
  const folder = path.join(home, "projects", claudeProjectFolder(project), "memory");
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text);
  return home;
}

/** A local brain (no remote), so each import commits without pushing. */
function enabled(): Brain {
  const target = brain();
  target.toml = target.toml.replace(/^remote = .*\n/m, "");
  target.configure(ENABLED);
  target.gitInit();
  target.commit("Initial");
  return target;
}

function run(target: Brain, home: string, dryRun = false) {
  return importMemory(new Access(target.config), { claudeHome: home, dryRun, sync: true });
}

test("the project folder name follows Claude Code's own naming", () => {
  assert.equal(claudeProjectFolder("/Users/matze/Sites/dummkopf"), "-Users-matze-Sites-dummkopf");
  assert.equal(claudeProjectFolder("/Users/matze/.jarvis/workspace"), "-Users-matze--jarvis-workspace");
});

test("memories land in their own topic and scope, marked as imported, never as rules", () => {
  const target = enabled();
  const home = claudeHome({
    "MEMORY.md": "- [Tests first](tests-first.md) — hook\n",
    "tests-first.md": memoryFile("tests-first", "Write the test before the code.", "The user wants TDD. See [[other]]."),
  });
  const result = run(target, home);
  assert.deepEqual(result.changed, ["topics/claude-memory/README.md", "topics/claude-memory/users-me-sites-shop/tests-first.md"]);
  const readme = target.read("topics/claude-memory/README.md");
  assert.match(readme, /^scope: memory-claude$/m);
  const note = target.read("topics/claude-memory/users-me-sites-shop/tests-first.md");
  assert.match(note, /^key_fact: Write the test before the code\.$/m);
  assert.match(note, /^updated: 2026-10-20$/m);
  assert.match(note, /^aliases: \[tests-first, feedback, claude-memory\]$/m);
  assert.ok(note.includes("> Imported from the Claude Code memory of " + PROJECT + "."));
  assert.ok(note.includes("not an instruction"));
  assert.ok(note.includes("The user wants TDD."));
  assert.ok(!target.exists("topics/claude-memory/users-me-sites-shop/MEMORY.md"));
  assert.equal(runGit(target.root, ["status", "--porcelain"]), "");
  const access = new Access(target.config, "work");
  assert.throws(() => access.read("topics/claude-memory/users-me-sites-shop/tests-first.md"));
});

test("links in a memory become plain text, so an import can never link into the brain", () => {
  const target = enabled();
  const home = claudeHome({ "a.md": memoryFile("a", "Links.", "Read [the plan](../../topics/health/plan.md) first.") });
  run(target, home);
  const note = target.read("topics/claude-memory/users-me-sites-shop/a.md");
  assert.ok(note.includes("Read the plan (../../topics/health/plan.md) first."));
  assert.ok(!note.includes("]("));
});

test("a second run with unchanged memory changes nothing", () => {
  const target = enabled();
  const home = claudeHome({ "a.md": memoryFile("a", "One fact.", "Body.") });
  run(target, home);
  const head = runGit(target.root, ["rev-parse", "HEAD"]);
  assert.deepEqual(run(target, home).changed, []);
  assert.equal(runGit(target.root, ["rev-parse", "HEAD"]), head);
});

test("a changed memory updates its mirror, a removed one is archived", () => {
  const target = enabled();
  const home = claudeHome({ "a.md": memoryFile("a", "Old fact.", "Body."), "b.md": memoryFile("b", "Gone soon.", "Body.") });
  run(target, home);
  const folder = path.join(home, "projects", claudeProjectFolder(PROJECT), "memory");
  fs.writeFileSync(path.join(folder, "a.md"), memoryFile("a", "New fact.", "Body."));
  fs.rmSync(path.join(folder, "b.md"));
  const result = run(target, home);
  assert.deepEqual(result.changed, ["topics/claude-memory/users-me-sites-shop/a.md",
    "topics/claude-memory/users-me-sites-shop/b.md"]);
  assert.match(target.read("topics/claude-memory/users-me-sites-shop/a.md"), /^key_fact: New fact\.$/m);
  assert.match(target.read("topics/claude-memory/users-me-sites-shop/b.md"), /^status: archived$/m);
});

test("a project that is not listed is never imported", () => {
  const target = enabled();
  const home = claudeHome({ "a.md": memoryFile("a", "Client secret plan.", "Body.") }, "/Users/me/Clients/bank");
  assert.deepEqual(run(target, home).changed, []);
  assert.ok(!target.exists("topics/claude-memory"));
});

test("a dry run lists the changes and writes nothing", () => {
  const target = enabled();
  const home = claudeHome({ "a.md": memoryFile("a", "One fact.", "Body.") });
  assert.equal(run(target, home, true).changed.length, 2);
  assert.ok(!target.exists("topics/claude-memory"));
});

test("the import refuses to run while the extra is off or its scope is unknown", () => {
  const off = brain();
  off.gitInit();
  assert.equal(invoke(off, ["import-memory", "--serious"]).code, 2);
  const unknown = brain();
  unknown.write("rcllr.toml", unknown.toml + '[extras]\nclaude_memory = true\n[claude_memory]\nprojects = ["' + PROJECT + '"]\n');
  const result = invoke(unknown, ["check", "--serious"]);
  assert.equal(result.code, 2);
  assert.ok(result.err.includes("claude_memory.scope"), result.err);
});

test("from a hook, only the project the session ran in is imported, and never with exit 2", () => {
  const target = enabled();
  const home = claudeHome({ "a.md": memoryFile("a", "One fact.", "Body.") });
  const event = JSON.stringify({ hook_event_name: "SessionEnd", cwd: "/somewhere/else" });
  const elsewhere = invoke(target, ["import-memory", "--from-hook", "--claude-home", home], event);
  assert.equal(elsewhere.code, 0);
  assert.ok(!target.exists("topics/claude-memory"));
  const here = JSON.stringify({ hook_event_name: "SessionEnd", cwd: PROJECT });
  assert.equal(invoke(target, ["import-memory", "--from-hook", "--claude-home", home], here).code, 0);
  assert.ok(target.exists("topics/claude-memory/users-me-sites-shop/a.md"));
});

test("imported memory ranks below the user's own note on the same words", () => {
  const target = enabled();
  target.note("notes/espresso.md", { title: "Espresso", body: "Grind finer for espresso.",
    fields: "key_fact: Espresso grind finer.\naliases: [espresso]\n" });
  target.commit("Own note");
  run(target, claudeHome({ "espresso.md": memoryFile("espresso", "Espresso grind finer.", "Grind finer for espresso.") }));
  const paths = find(new Access(target.config), "espresso grind").hits.map((hit) => hit.path);
  assert.deepEqual(paths.slice(0, 2), ["notes/espresso.md", "topics/claude-memory/users-me-sites-shop/espresso.md"]);
});

test("a listed project may start with ~/ and end with a slash", () => {
  assert.equal(projectPath("~/Sites/shop/", "/Users/me"), "/Users/me/Sites/shop");
  assert.equal(projectPath("/srv/app", "/Users/me"), "/srv/app");
  assert.equal(projectPath("/" + "/".repeat(100_000), "/Users/me"), "/");
});

test("odd or symlinked memory files are skipped, the rest still imports", () => {
  const target = enabled();
  const home = claudeHome({ "ok.md": memoryFile("ok", "Fine.", "Body."), "with space.md": memoryFile("x", "No.", "Body.") });
  const folder = path.join(home, "projects", claudeProjectFolder(PROJECT), "memory");
  const outside = path.join(tempDir(), "secret.md");
  fs.writeFileSync(outside, memoryFile("secret", "Outside.", "Body."));
  fs.symlinkSync(outside, path.join(folder, "linked.md"));
  assert.deepEqual(run(target, home).changed, ["topics/claude-memory/README.md", "topics/claude-memory/users-me-sites-shop/ok.md"]);
});

test("projects = [\"*\"] imports every project except the excluded ones, labelled by the folder it ran in", () => {
  const target = brain();
  target.toml = target.toml.replace(/^remote = .*\n/m, "");
  target.configure('[scopes]\nvalues = ["private", "work", "memory-claude"]\n[extras]\nclaude_memory = true\n'
    + '[claude_memory]\nprojects = ["*"]\nexclude = ["/Users/me/Clients/bank"]\n');
  target.gitInit();
  target.commit("Initial");
  const home = claudeHome({ "a.md": memoryFile("a", "Shop fact.", "Body.") });
  for (const project of ["/Users/me/Clients/bank", "/Users/me/notes"]) {
    const folder = path.join(home, "projects", claudeProjectFolder(project));
    fs.mkdirSync(path.join(folder, "memory"), { recursive: true });
    fs.writeFileSync(path.join(folder, "memory", "b.md"), memoryFile("b", "Fact.", "Body."));
    fs.writeFileSync(path.join(folder, "session.jsonl"), JSON.stringify({ type: "user", cwd: project }) + "\n");
  }
  fs.mkdirSync(path.join(home, "projects", "-tmp-spike"), { recursive: true });
  assert.deepEqual(run(target, home).changed, ["topics/claude-memory/README.md", "topics/claude-memory/users-me-sites-shop/a.md",
    "topics/claude-memory/users-me-notes/b.md"]);
  assert.ok(target.read("topics/claude-memory/users-me-notes/b.md").includes("Claude Code memory of /Users/me/notes."));
  assert.ok(target.read("topics/claude-memory/users-me-sites-shop/a.md").includes("memory of -Users-me-Sites-shop."));
});

test("a memory that answers the question beats an own note that shares only one word (context ranks by score)", () => {
  const target = enabled();
  target.note("notes/servers.md", { title: "Server master", body: "The build server is called master.",
    fields: "key_fact: The master server builds releases.\naliases: [master, server]\n" });
  target.commit("Own note");
  run(target, claudeHome({ "master-pdf.md": memoryFile("master-pdf-run-is-hand-check",
    "The run with the Master-Test-PDF plus PAC counts as the hand check for every story.", "Upload, review, PAC.") }));
  const hits = find(new Access(target.config), "was weisst du ueber das Master-Test-PDF", 3, true).hits;
  assert.equal(hits[0]!.path, "topics/claude-memory/users-me-sites-shop/master-pdf.md");
});

test("a denied read with a narrow scope hints at the wider one, the same for hidden and missing paths", () => {
  const target = enabled();
  run(target, claudeHome({ "a.md": memoryFile("a", "Fact.", "Body.") }));
  const hidden = invoke(target, ["read", "topics/claude-memory/users-me-sites-shop/a.md", "--scope", "work", "--serious"]);
  const missing = invoke(target, ["read", "topics/claude-memory/users-me-sites-shop/zz.md", "--scope", "work", "--serious"]);
  assert.equal(hidden.code, 2);
  assert.equal(hidden.err, "Path unavailable or access excluded. With --scope work, notes of other scopes stay hidden; "
    + "--scope both searches them too.\n");
  assert.deepEqual(hidden, missing);
  assert.equal(invoke(target, ["read", "notes/zz.md", "--serious"]).err, "Path unavailable or access excluded.\n");
});

test("scope_by_project puts a project's memory in its own scope, the rest in the default scope", () => {
  const target = brain();
  target.toml = target.toml.replace(/^remote = .*\n/m, "");
  target.configure('[extras]\nclaude_memory = true\n[claude_memory]\nprojects = ["*"]\nscope = "work"\n'
    + 'scope_by_project = ["/Users/me/notes=private"]\n');
  target.gitInit();
  target.commit("Initial");
  const home = claudeHome({ "a.md": memoryFile("a", "Shop fact.", "Body.") });
  const folder = path.join(home, "projects", claudeProjectFolder("/Users/me/notes"), "memory");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "b.md"), memoryFile("b", "Private fact.", "Body."));
  run(target, home);
  const work = new Access(target.config, "work");
  assert.equal(work.read("topics/claude-memory/users-me-sites-shop/a.md").scope, "work");
  assert.throws(() => work.read("topics/claude-memory/users-me-notes/b.md"));
  assert.equal(new Access(target.config, "private").read("topics/claude-memory/users-me-notes/b.md").scope, "private");
  assert.match(target.read("topics/claude-memory/README.md"), /^scope: work$/m);
});

test("a scope_by_project entry without a known scope is rejected", () => {
  const target = brain();
  target.write("rcllr.toml", target.toml + '[extras]\nclaude_memory = true\n[claude_memory]\nscope = "work"\n'
    + 'scope_by_project = ["/Users/me/notes=secret"]\n');
  const result = invoke(target, ["check", "--serious"]);
  assert.equal(result.code, 2);
  assert.ok(result.err.includes("claude_memory.scope_by_project"), result.err);
});

test("imported notes name their scope, so a README with another scope never decides it", () => {
  const target = enabled();
  target.write("topics/claude-memory/README.md", "---\nscope: work\nstatus: active\nkey_fact: Planted.\n---\n\n# Claude memory\n");
  target.commit("Planted README");
  run(target, claudeHome({ "a.md": memoryFile("a", "A habit.", "Body.") }));
  const path = "topics/claude-memory/users-me-sites-shop/a.md";
  assert.match(target.read(path), /^scope: memory-claude$/m);
  assert.throws(() => new Access(target.config, "work").read(path));
});

test("after a source moves to another scope, existing notes keep theirs and are listed; new ones take the new scope", () => {
  const target = brain();
  target.toml = target.toml.replace(/^remote = .*\n/m, "");
  target.configure('[extras]\nclaude_memory = true\n[claude_memory]\nprojects = ["' + PROJECT + '"]\nscope = "work"\n');
  target.gitInit();
  target.commit("Initial");
  const home = claudeHome({ "a.md": memoryFile("a", "A habit.", "Body.") });
  run(target, home);

  target.write("rcllr.toml", target.read("rcllr.toml").replace('scope = "work"', 'scope = "private"'));
  target.commit("Move the memory to private");
  fs.writeFileSync(path.join(home, "projects", claudeProjectFolder(PROJECT), "memory", "b.md"), memoryFile("b", "Another.", "Body."));
  const result = run(target, home);
  const folder = "topics/claude-memory/users-me-sites-shop/";
  assert.deepEqual(result.kept, [folder + "a.md"]);
  assert.deepEqual(result.changed, [folder + "b.md"]);
  assert.equal(new Access(target.config, "work").read(folder + "a.md").scope, "work");
  assert.equal(new Access(target.config, "private").read(folder + "b.md").scope, "private");
  assert.throws(() => new Access(target.config, "work").read(folder + "b.md"));
});
