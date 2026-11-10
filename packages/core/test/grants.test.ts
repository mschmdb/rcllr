/** Session grants for sensitive notes: which topics a prompt names, where grants live, what they cover. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { addGrants, covers, grantsFile, loadGrants, MAX_SESSIONS, matchPrompt, normalizeTerm } from "../src/grants.ts";
import { type Brain, brain, NO_FILE_MODES, tempDir } from "./helpers.ts";

/** A Git brain with a sensitive topic folder that has aliases, and a sensitive single note. */
function hub(): Brain {
  const b = brain();
  b.gitInit();
  b.write(".sensitive-paths", "# generated\ntopics/haus-ulm/\nnotes/dating-kapazitaet.md\n");
  b.write("topics/haus-ulm/README.md", "---\nscope: privat\naliases: [Wärmepumpe, Vaterhaus, WP]\n---\n\n> SENSIBEL\n\n# Haus\n");
  b.write("notes/dating-kapazitaet.md", "---\naliases: [Partnersuche]\n---\n\n> SENSIBEL\n\n# Dating\n");
  b.write("topics/rezepte/README.md", "---\nscope: privat\naliases: [Kochen]\n---\n\n# Rezepte\n");
  return b;
}

// --- normalizeTerm -------------------------------------------------------------------------------------------

test("normalizeTerm folds case, umlauts, accents and separators", () => {
  assert.equal(normalizeTerm("Wärmepumpe"), "waermepumpe");
  assert.equal(normalizeTerm("WÄRMEPUMPE"), "waermepumpe");
  assert.equal(normalizeTerm("Wa\u0308rmepumpe"), "waermepumpe");
  assert.equal(normalizeTerm("Straße"), "strasse");
  assert.equal(normalizeTerm("Café"), "cafe");
  assert.equal(normalizeTerm("haus-ulm"), "haus ulm");
  assert.equal(normalizeTerm("  Haus_Ulm!? "), "haus ulm");
});

// --- matchPrompt ---------------------------------------------------------------------------------------------

test("a prompt names a topic by its folder name", () => {
  assert.deepEqual(matchPrompt(hub().config, "Wie steht es ums Haus Ulm?"), ["topics/haus-ulm"]);
});

test("a prompt names a topic by an alias, in any case and umlaut spelling", () => {
  const config = hub().config;
  for (const prompt of ["die wärmepumpe", "Die WAERMEPUMPE", "Vaterhaus: was fehlt?"]) {
    assert.deepEqual(matchPrompt(config, prompt), ["topics/haus-ulm"], prompt);
  }
});

test("a single sensitive note matches by file name and by its own aliases", () => {
  const config = hub().config;
  assert.deepEqual(matchPrompt(config, "dating kapazitaet"), ["notes/dating-kapazitaet.md"]);
  assert.deepEqual(matchPrompt(config, "Partnersuche"), ["notes/dating-kapazitaet.md"]);
});

test("no topic named, a word only containing the name, or a short alias match nothing", () => {
  const config = hub().config;
  for (const prompt of ["Wie wird das Wetter?", "Hausulmer Wärmepumpenförderung", "wp", "Kochen"]) {
    assert.deepEqual(matchPrompt(config, prompt), [], prompt);
  }
});

test("sensitive.always folders match even before the paths file lists them", () => {
  const b = hub();
  b.configure("[sensitive]\nalways = ['topics/gesundheit/']\n");
  assert.deepEqual(matchPrompt(b.config, "Gesundheit: neue Blutwerte"), ["topics/gesundheit"]);
});

test("a symlinked README contributes no aliases", () => {
  const b = hub();
  const outside = path.join(tempDir(), "README.md");
  fs.writeFileSync(outside, "---\naliases: [Geheimwort]\n---\n\n# X\n");
  fs.rmSync(path.join(b.root, "topics/haus-ulm/README.md"));
  fs.symlinkSync(outside, path.join(b.root, "topics/haus-ulm/README.md"));
  assert.deepEqual(matchPrompt(b.config, "Geheimwort"), []);
});

// --- covers --------------------------------------------------------------------------------------------------

test("a grant covers its own path and everything below it", () => {
  const granted = new Set(["topics/haus-ulm"]);
  for (const request of ["topics/haus-ulm", "topics/haus-ulm/", "topics/haus-ulm/angebot.md", "Topics/Haus-Ulm/"]) {
    assert.ok(covers(granted, request), request);
  }
});

test("a grant covers nothing beside, above or outside it", () => {
  const granted = new Set(["topics/haus-ulm", "notes/dating-kapazitaet.md"]);
  for (const request of ["topics/finanzen/", "topics/", "topics", "topics/haus-ulm-alt/", "notes/dating-kapazitaet.md/x",
    "topics/haus-ulm/../finanzen/", "/topics/haus-ulm/", "./topics/haus-ulm/", "topics\\haus-ulm", "", "C:/topics/haus-ulm"]) {
    assert.ok(!covers(granted, request), request);
  }
  assert.ok(covers(granted, "notes/dating-kapazitaet.md"));
});

test("no grants cover nothing", () => {
  assert.ok(!covers(new Set(), "topics/haus-ulm/"));
});

// --- storage -------------------------------------------------------------------------------------------------

test("grants live in the Git folder and are kept per session", () => {
  const config = hub().config;
  addGrants(config, "session-a", ["topics/haus-ulm"]);
  addGrants(config, "session-a", ["notes/dating-kapazitaet.md"]);
  assert.deepEqual([...loadGrants(config, "session-a")].sort(), ["notes/dating-kapazitaet.md", "topics/haus-ulm"]);
  assert.deepEqual([...loadGrants(config, "session-b")], []);
  assert.equal(path.resolve(grantsFile(config) ?? ""), path.resolve(config.root, ".git", "rcllr", "grants.json"));
});

test("the grants file is private", { skip: NO_FILE_MODES }, () => {
  const config = hub().config;
  addGrants(config, "s", ["topics/haus-ulm"]);
  assert.equal(fs.statSync(grantsFile(config)!).mode & 0o777, 0o600);
});

test("nothing to grant writes nothing", () => {
  const config = hub().config;
  addGrants(config, "s", []);
  assert.ok(!fs.existsSync(grantsFile(config)!));
});

test("a broken grants file counts as empty and the next grant replaces it", () => {
  const config = hub().config;
  for (const broken of ["not json", "[]", '{"sessions": []}', '{"sessions": {"s": "topics/haus-ulm"}}',
    '{"sessions": {"s": [5]}}']) {
    fs.mkdirSync(path.dirname(grantsFile(config)!), { recursive: true });
    fs.writeFileSync(grantsFile(config)!, broken);
    assert.deepEqual([...loadGrants(config, "s")], [], broken);
  }
  addGrants(config, "s", ["topics/haus-ulm"]);
  assert.deepEqual([...loadGrants(config, "s")], ["topics/haus-ulm"]);
});

test("a symlinked grants file is neither read nor written", () => {
  const config = hub().config;
  const outside = path.join(tempDir(), "grants.json");
  fs.writeFileSync(outside, JSON.stringify({ sessions: { s: ["topics/haus-ulm"] } }));
  fs.mkdirSync(path.dirname(grantsFile(config)!), { recursive: true });
  fs.symlinkSync(outside, grantsFile(config)!);
  assert.deepEqual([...loadGrants(config, "s")], []);
  addGrants(config, "s", ["notes/dating-kapazitaet.md"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(outside, "utf-8")), { sessions: { s: ["topics/haus-ulm"] } });
});

test("a symlinked grants folder is neither read nor written", () => {
  const config = hub().config;
  const outside = tempDir();
  fs.writeFileSync(path.join(outside, "grants.json"), JSON.stringify({ sessions: { s: ["topics/haus-ulm"] } }));
  fs.symlinkSync(outside, path.join(config.root, ".git", "rcllr"));
  assert.deepEqual([...loadGrants(config, "s")], []);
  addGrants(config, "t", ["topics/haus-ulm"]);
  assert.deepEqual(fs.readdirSync(outside), ["grants.json"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outside, "grants.json"), "utf-8")).sessions.t, undefined);
});

test("a brain without Git keeps no grants", () => {
  const b = brain();
  addGrants(b.config, "s", ["topics/haus-ulm"]);
  assert.equal(grantsFile(b.config), null);
  assert.deepEqual([...loadGrants(b.config, "s")], []);
});

test("unusable session ids keep no grants", () => {
  const config = hub().config;
  for (const id of ["", "x".repeat(300), "a\nb"]) {
    addGrants(config, id, ["topics/haus-ulm"]);
    assert.deepEqual([...loadGrants(config, id)], [], JSON.stringify(id));
  }
});

test("a session id like __proto__ stays plain data", () => {
  const config = hub().config;
  addGrants(config, "__proto__", ["topics/haus-ulm"]);
  assert.deepEqual([...loadGrants(config, "__proto__")], ["topics/haus-ulm"]);
  assert.deepEqual([...loadGrants(config, "other")], []);
});

test("only the most recent sessions keep their grants", () => {
  const config = hub().config;
  for (let i = 0; i <= MAX_SESSIONS; i++) addGrants(config, "s" + i, ["topics/haus-ulm"]);
  assert.deepEqual([...loadGrants(config, "s0")], []);
  assert.deepEqual([...loadGrants(config, "s" + MAX_SESSIONS)], ["topics/haus-ulm"]);
});
