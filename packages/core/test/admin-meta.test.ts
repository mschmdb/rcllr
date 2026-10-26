/** Port of tests/test_meta.py. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { parseFrontmatter } from "../src/frontmatter.ts";
import { generate, migrate, report, reportSummary, topicDirs } from "../src/meta.ts";
import { PyDate } from "../src/pydate.ts";
import { scrapeRows, splitRow } from "../src/tables.ts";
import { type Brain, brain, german } from "./helpers.ts";

const TODAY = PyDate.today().isoformat();
const BASE_INDEX = "# Brain index\n\nProse on top.\n\n## Topics\n\n"
  + "| Folder | About | Aliases |\n|---|---|---|\n| `topics/old/` | old | a |\n\n"
  + "## Notes (flat)\n\n"
  + "| File | Key fact | Aliases |\n|---|---|---|\n| `notes/old.md` | old | a |\n\n"
  + "## Bookmarks\n\n"
  + "| File | Key fact | Aliases |\n|---|---|---|\n| `bookmarks/old.md` | old | a |\n";

function repo(): Brain {
  const target = brain();
  target.gitInit();
  for (const folder of ["topics", "notes", "bookmarks"]) fs.mkdirSync(path.join(target.root, folder));
  return target;
}

function full(updated: string, fact: string, { alias = "", status = "active", extra = "", body = "# T\n" } = {}): string {
  const fields = "status: " + status + "\nkey_fact: " + fact + "\nsummary: " + fact + "\naliases: [" + alias
    + "]\nperiod: []\nentities: []\n";
  return "---\n" + extra + "updated: " + updated + "\n" + fields + "---\n\n" + body;
}

const data = (target: Brain, rel: string): Map<string, string | string[]> => parseFrontmatter(target.read(rel)).data;

test("split row with an escaped pipe", () => {
  assert.deepEqual(splitRow("| `a/b.md` | x \\| y | e1, e2 |"), ["`a/b.md`", "x | y", "e1, e2"]);
});

test("scrape rows", () => {
  const rows = scrapeRows("| File | Key fact | Aliases |\n|---|---|---|\n| `notes/a.md` | Fact A | al1, al2 |\n"
    + "| `topics/t/` | Topic T | tt |\n");
  assert.deepEqual(rows.get("notes/a.md"), { description: "Fact A", aliases: ["al1", "al2"] });
  assert.deepEqual(rows.get("topics/t/"), { description: "Topic T", aliases: ["tt"] });
  assert.equal(scrapeRows("|---|---|---|\n| File | Key fact | Aliases |\n").size, 0);
});

test("migrate creates frontmatter", () => {
  const target = repo();
  target.write("notes/a.md", "# A\n\nText\n");
  target.commit("add", "2026-03-04T09:00:00");
  migrate(target.config);
  const parsed = parseFrontmatter(target.read("notes/a.md"));
  assert.ok(parsed.present);
  assert.equal(parsed.data.get("updated"), "2026-03-04");
  assert.equal(parsed.data.get("status"), "active");
  assert.equal(parsed.data.get("key_fact"), "TODO");
  for (const key of ["aliases", "period", "entities"]) assert.deepEqual(parsed.data.get(key), []);
  assert.ok(parsed.body.includes("# A") && parsed.body.includes("Text"));
});

test("migrate keeps scope and order", () => {
  const target = repo();
  target.write("notes/a.md", "---\nscope: private\n---\n\n# A\n");
  target.commit();
  migrate(target.config);
  const fields = data(target, "notes/a.md");
  assert.equal(fields.get("scope"), "private");
  assert.equal([...fields.keys()][0], "scope");
});

test("migrate falls back to today without a commit", () => {
  const target = repo();
  target.write("notes/new.md", "# New\n");
  migrate(target.config);
  assert.equal(data(target, "notes/new.md").get("updated"), TODAY);
});

test("migrate derives archive status from the path", () => {
  const target = repo();
  target.write("topics/t/archive-research.md", "# X\n");
  target.write("topics/t/archive/old.md", "# X\n");
  target.write("topics/t/normal.md", "# Y\n");
  target.commit();
  migrate(target.config);
  for (const [rel, status] of [["topics/t/archive-research.md", "archived"], ["topics/t/archive/old.md", "archived"],
    ["topics/t/normal.md", "active"]] as const) {
    assert.equal(data(target, rel).get("status"), status);
  }
});

test("migrate seeds from the folder README", () => {
  const target = repo();
  target.write("topics/t/README.md", "# T\n\n## Files\n\n| File | Key fact | Aliases |\n|---|---|---|\n"
    + "| `topics/t/a.md` | Fact A | al1, al2 |\n");
  target.write("topics/t/a.md", "# A\n");
  target.write("INDEX.md", BASE_INDEX);
  target.commit();
  migrate(target.config);
  const fields = data(target, "topics/t/a.md");
  assert.equal(fields.get("key_fact"), "Fact A");
  assert.deepEqual(fields.get("aliases"), ["al1", "al2"]);
});

test("migrate seeds a topic README from the index", () => {
  const target = repo();
  target.write("INDEX.md", "# Index\n\n## Topics\n\n| Folder | About | Aliases |\n|---|---|---|\n"
    + "| `topics/t/` | What T is about | tt, tee |\n");
  target.write("topics/t/README.md", "---\nscope: work\n---\n\n# T\n");
  target.commit();
  migrate(target.config);
  const fields = data(target, "topics/t/README.md");
  assert.equal(fields.get("key_fact"), "What T is about");
  assert.deepEqual(fields.get("aliases"), ["tt", "tee"]);
  assert.equal(fields.get("scope"), "work");
});

test("migrate shortens the summary", () => {
  const target = repo();
  const long = "verylongword ".repeat(20).trim();
  target.write("topics/t/README.md", "## Files\n\n| File | Key fact | Aliases |\n|---|---|---|\n"
    + "| `topics/t/a.md` | " + long + " | x |\n");
  target.write("topics/t/a.md", "# A\n");
  target.commit();
  migrate(target.config);
  const fields = data(target, "topics/t/a.md");
  assert.equal(fields.get("key_fact"), long);
  const summary = String(fields.get("summary"));
  assert.ok([...summary].length <= 160 && summary.endsWith("…"));
});

test("migrate is idempotent, honours dry run and only", () => {
  const target = repo();
  target.write("notes/a.md", "# A\n");
  target.write("notes/b.md", "# B\n");
  target.commit();
  assert.deepEqual(migrate(target.config, true), ["notes/a.md", "notes/b.md"]);
  assert.equal(target.read("notes/a.md"), "# A\n");
  assert.deepEqual(migrate(target.config, false, ["notes/a.md"]), ["notes/a.md"]);
  assert.ok(!target.read("notes/b.md").startsWith("---"));
  const first = target.read("notes/a.md");
  assert.deepEqual(migrate(target.config, false, ["notes/a.md"]), []);
  assert.equal(target.read("notes/a.md"), first);
});

test("migrate keeps the body unchanged", () => {
  const target = repo();
  const body = "# A\n\n> SENSITIVE\n\nSecret.\n";
  target.write("notes/a.md", body);
  target.commit();
  migrate(target.config);
  assert.equal(parseFrontmatter(target.read("notes/a.md")).body.replace(/^\n+/, ""), body);
});

function seedSkill(target: Brain): void {
  target.write("topics/t/tool/SKILL.md", "---\nname: tool\ndescription: A skill.\n---\n\n# tool\n");
  target.write("topics/t/tool/references/api.md", "# API\n");
  target.write("topics/t/normal.md", "# Normal\n");
  target.write("topics/t/README.md", "# T\n\n## Files\n\n| File | Key fact | Aliases |\n|---|---|---|\n");
  target.commit();
}

test("skill folders are never touched", () => {
  const target = repo();
  seedSkill(target);
  const before = new Map(["topics/t/tool/SKILL.md", "topics/t/tool/references/api.md"].map((rel) => [rel, target.read(rel)]));
  const changed = migrate(target.config);
  for (const [rel, text] of before) {
    assert.ok(!changed.includes(rel));
    assert.equal(target.read(rel), text);
  }
  generate(target.config);
  const readme = target.read("topics/t/README.md");
  assert.ok(readme.includes("| `topics/t/normal.md` |"));
  assert.ok(!readme.includes("SKILL.md") && !readme.includes("references/api.md"));
  const text = report(target.config);
  assert.ok(!text.includes("SKILL.md") && !text.includes("api.md"));
});

test("prose mentioning a skill folder stays", () => {
  const target = repo();
  seedSkill(target);
  target.write("topics/t/README.md", target.read("topics/t/README.md") + "\nSource: `topics/t/tool/` stays mentioned.\n");
  migrate(target.config);
  generate(target.config);
  assert.ok(target.read("topics/t/README.md").includes("Source: `topics/t/tool/` stays mentioned."));
});

test("a topic with SKILL.md is not a topic", () => {
  const target = repo();
  target.write("topics/skillonly/SKILL.md", "---\nname: x\n---\n\n# X\n");
  target.write("topics/skillonly/README.md", "# X\n");
  assert.ok(!topicDirs(target.config).includes("skillonly"));
});

function seedBrain(target: Brain): void {
  target.write("INDEX.md", BASE_INDEX);
  target.write("topics/t/README.md", full("2026-05-01", '"Topic T, long"', {
    alias: "tt", extra: "scope: work\n",
    body: "# T\n\nProse.\n\n## Files\n\n| File | Key fact | Aliases |\n|---|---|---|\n"
      + "| `topics/t/gone.md` | OLD | x |\n\nAfterword in block.\n\n## Related\n\nLink.\n",
  }));
  target.write("topics/t/a.md", full("2026-02-01", "Fact A", { alias: "al1", body: "# A\n" }));
  target.write("topics/t/b.md", full("2026-09-01", "Fact B", { alias: "al2", status: "archived", body: "# B\n" }));
  target.write("notes/n.md", full("2026-04-01", "Fact N", { alias: "aln", body: "# N\n" }));
  target.write("bookmarks/bm.md", full("2026-06-01", "Fact BM", { alias: "albm", body: "# BM\n" }));
  target.commit();
}

test("generate replaces the files block", () => {
  const target = repo();
  seedBrain(target);
  generate(target.config);
  const text = target.read("topics/t/README.md");
  assert.ok(!text.includes("topics/t/gone.md"));
  for (const expected of ["Afterword in block.", "## Files", "| `topics/t/a.md` | Fact A | al1 |",
    "| `topics/t/b.md` | Fact B | al2 |", "## Related", "Link.", "Prose."]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.ok(!text.includes("topics/t/README.md`"));
  assert.ok(text.indexOf("topics/t/b.md") < text.indexOf("topics/t/a.md"), "newest first");
});

// The nearest README owns a file: a sub-folder README lists its own files, the parent lists the sub-folder README.
test("a sub-folder README lists its own files", () => {
  const target = repo();
  seedBrain(target);
  target.write("topics/t/reports/README.md", "---\nkey_fact: Reports\n---\n\n# Reports\n");
  target.write("topics/t/reports/week-1.md", "---\nkey_fact: Week one\n---\n\n# Week 1\n");
  target.write("topics/t/loose/c.md", "---\nkey_fact: Fact C\n---\n\n# C\n");
  generate(target.config);
  const parent = target.read("topics/t/README.md");
  assert.ok(parent.includes("| `topics/t/reports/README.md` | Reports |"), parent);
  assert.ok(parent.includes("| `topics/t/loose/c.md` | Fact C |"), parent);
  assert.ok(!parent.includes("week-1.md"), parent);
  const child = target.read("topics/t/reports/README.md");
  assert.ok(child.includes("## Files") && child.includes("| `topics/t/reports/week-1.md` | Week one |"), child);
  assert.ok(!child.includes("topics/t/a.md"), child);
});

test("generate appends a files block", () => {
  const target = repo();
  seedBrain(target);
  const text = target.read("topics/t/README.md");
  target.write("topics/t/README.md", text.slice(0, text.indexOf("## Files")) + "## Related\n\nLink.\n");
  generate(target.config);
  assert.ok(target.read("topics/t/README.md").includes("## Files"));
  assert.ok(target.read("topics/t/README.md").includes("| `topics/t/a.md` |"));
});

test("generate drops the auto stub", () => {
  const target = repo();
  seedBrain(target);
  target.write("topics/t/README.md", target.read("topics/t/README.md")
    + "\n---\n\n## Unfiled (auto-stub)\n\n| File | Key fact | Aliases |\n|---|---|---|\n| `topics/t/a.md` | TODO | |\n");
  generate(target.config);
  assert.ok(!target.read("topics/t/README.md").includes("auto-stub"));
  assert.ok(!target.read("topics/t/README.md").includes("| TODO |"));
});

test("generate index tables", () => {
  const target = repo();
  seedBrain(target);
  generate(target.config);
  const text = target.read("INDEX.md");
  assert.ok(text.includes("Prose on top."));
  assert.ok(!text.includes("topics/old/") && !text.includes("notes/old.md"));
  assert.ok(text.includes("| `topics/t/` | Topic T, long | tt |"));
  assert.ok(text.includes("| `notes/n.md` | Fact N | aln |"));
  assert.ok(text.includes("| `bookmarks/bm.md` | Fact BM | albm |"));
});

test("generate index status prefix", () => {
  const target = repo();
  seedBrain(target);
  target.write("topics/t/README.md", target.read("topics/t/README.md").replace("status: active", "status: archived"));
  generate(target.config);
  assert.ok(target.read("INDEX.md").includes("| `topics/t/` | [archived] Topic T, long | tt |"));
});

test("generate index without sensitive entries", () => {
  const target = repo();
  seedBrain(target);
  target.write("topics/s/README.md", full("2026-01-01", "Hidden", { body: "# S\n\n> SENSITIVE\n" }));
  target.write("notes/hidden.md", full("2026-01-01", "HiddenN", { body: "# G\n\n> SENSITIVE\n" }));
  target.configure("[sensitive]\nalways = ['topics/health/']\n");
  target.write("topics/health/README.md", full("2026-01-01", "Pulse", { body: "# H\n" }));
  generate(target.config);
  const text = target.read("INDEX.md");
  for (const absent of ["topics/s/", "notes/hidden.md", "Hidden", "topics/health/", "Pulse"]) {
    assert.ok(!text.includes(absent), absent);
  }
});

test("generate is idempotent and dry run writes nothing", () => {
  const target = repo();
  seedBrain(target);
  const before = target.read("INDEX.md");
  assert.ok(generate(target.config, true).includes("INDEX.md"));
  assert.equal(target.read("INDEX.md"), before);
  generate(target.config);
  const snapshot = ["INDEX.md", "topics/t/README.md"].map((rel) => target.read(rel));
  assert.deepEqual(generate(target.config), []);
  assert.deepEqual(["INDEX.md", "topics/t/README.md"].map((rel) => target.read(rel)), snapshot);
});

test("generate escapes pipes", () => {
  const target = repo();
  seedBrain(target);
  target.write("notes/p.md", full("2026-07-01", '"a | b"', { body: "# P\n" }));
  generate(target.config);
  assert.ok(target.read("INDEX.md").includes("| `notes/p.md` | a \\| b |"));
});

test("a marked file is dropped from an open topic README", () => {
  const target = repo();
  target.write("INDEX.md", BASE_INDEX);
  const filesBlock = "# Open\n\n## Files\n\n| File | Key fact | Aliases |\n|---|---|---|\n";
  target.write("topics/open/README.md", full("2026-05-01", "Open", { alias: "o", extra: "scope: work\n", body: filesBlock }));
  target.write("topics/open/normal.md", full("2026-01-01", "K", { alias: "a" }));
  target.write("topics/open/hidden.md", full("2026-01-01", "K", { alias: "a", body: "> SENSITIVE\n\n# T\n" }));
  target.commit();
  generate(target.config);
  const out = target.read("topics/open/README.md");
  assert.ok(out.includes("normal.md") && !out.includes("hidden.md"));
});

test("a protected topic still lists its files", () => {
  const target = repo();
  target.write("INDEX.md", BASE_INDEX);
  target.write("topics/private/README.md", full("2026-05-01", "Private", {
    alias: "p", extra: "scope: private\n",
    body: "> SENSITIVE\n\n# Private\n\n## Files\n\n| File | Key fact | Aliases |\n|---|---|---|\n",
  }));
  target.write("topics/private/one.md", full("2026-01-01", "K", { alias: "a" }));
  target.commit();
  generate(target.config);
  assert.ok(target.read("topics/private/README.md").includes("one.md"));
});

test("report lists missing, stale and TODO", () => {
  const target = repo();
  target.write("notes/without.md", "# Without\n");
  target.write("notes/old.md", full("2020-01-01", "X"));
  target.write("notes/todo.md", full(TODAY, "TODO"));
  target.write("notes/ok.md", full(TODAY, "Good"));
  target.write("notes/arch.md", full("2020-01-01", "X", { status: "archived" }));
  target.write("notes/hidden.md", "# G\n\n> SENSITIVE\n");
  target.commit();
  const text = report(target.config);
  for (const present of ["notes/without.md", "notes/old.md", "notes/todo.md", "1 sensitive file(s) skipped"]) {
    assert.ok(text.includes(present), present);
  }
  for (const absent of ["notes/ok.md", "notes/arch.md", "hidden"]) assert.ok(!text.includes(absent), absent);
});

test("a German hub generates identical German tables", () => {
  const target = german();
  target.gitInit();
  target.write("INDEX.md", "# Hub-Index\n\n## Topics\n\n| Ordner | Worum es geht | Aliase |\n|---|---|---|\n\n"
    + "## Notes (flach)\n\n| Datei | Kernfakt | Aliase |\n|---|---|---|\n\n"
    + "## Bookmarks\n\n| Datei | Kernfakt | Aliase |\n|---|---|---|\n");
  target.write("topics/t/README.md", "---\nscope: work\nstand: 2026-05-01\nstatus: aktiv\nkernfakt: Thema T\n"
    + "kurz: Thema T\naliase: [tt]\nzeitraum: []\nentitaeten: []\n---\n\n# T\n");
  target.write("topics/t/a.md", "---\nstand: 2026-02-01\nstatus: aktiv\nkernfakt: Fakt A\nkurz: Fakt A\n"
    + "aliase: [al1]\nzeitraum: []\nentitaeten: []\n---\n\n# A\n");
  target.write("topics/t/archiv-alt.md", "# Alt\n");
  target.commit();
  migrate(target.config);
  assert.equal(data(target, "topics/t/archiv-alt.md").get("status"), "archiv");
  generate(target.config);
  const readme = target.read("topics/t/README.md");
  assert.ok(readme.includes("## Dateien\n\n| Datei | Kernfakt | Aliase |"));
  assert.ok(readme.includes("| `topics/t/a.md` | Fakt A | al1 |"));
  assert.ok(target.read("INDEX.md").includes("| `topics/t/` | Thema T | tt |"));
  const snapshot = [target.read("INDEX.md"), readme];
  assert.deepEqual(generate(target.config), []);
  assert.deepEqual([target.read("INDEX.md"), target.read("topics/t/README.md")], snapshot);
});

test("the report summary stays silent without findings and counts them otherwise", () => {
  const target = repo();
  target.write("notes/ok.md", full(TODAY, "Good"));
  assert.equal(reportSummary(target.config), "");
  target.write("notes/todo.md", full(TODAY, "TODO"));
  assert.equal(reportSummary(target.config), "Report: 0 stale, 0 without date, 1 without key fact. "
    + "Run `rcllr meta report` for details.");
});

test("migrate never drops a sensitivity marker, even one in frontmatter it cannot keep", () => {
  const target = repo();
  target.write("INDEX.md", BASE_INDEX);
  const text = "---\nnotes: |\n  > SENSITIVE\n---\n\n# Hidden\n\nBody.\n";
  target.write("notes/hidden.md", text);
  migrate(target.config);
  assert.ok(target.read("notes/hidden.md").includes("> SENSITIVE"));
});

test("generate leaves a README under sources byte for byte", () => {
  const target = repo();
  target.write("INDEX.md", BASE_INDEX);
  target.write("topics/a/README.md", "---\nkey_fact: A.\n---\n\n# A\n");
  target.write("topics/a/note.md", "---\nkey_fact: Note.\n---\n\n# Note\n");
  const original = "# Original README\n\nVerbatim.\n";
  target.write("topics/a/sources/README.md", original);
  target.write("topics/a/sources/doc.md", "# Doc\n");
  generate(target.config);
  assert.equal(target.read("topics/a/sources/README.md"), original);
});
