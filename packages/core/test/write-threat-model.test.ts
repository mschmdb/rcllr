/** Port of tests/test_threat_model.py: findings from an adversarial review and a cross-provider review. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

import { Access } from "../src/access.ts";
import { AccessDenied, ConfigError, RcllrError } from "../src/errors.ts";
import { preCommit } from "../src/hook.ts";
import { references } from "../src/links.ts";
import { generate, migrate } from "../src/meta.ts";
import { PyDate } from "../src/pydate.ts";
import { contextPacket, find } from "../src/search.ts";
import { check, ingest, seams } from "../src/write.ts";
import { type Brain, brain, documentText as document, invoke, NO_FILE_MODES, revision, synced, tempDir } from "./helpers.ts";

process.setMaxListeners(0);

function caught(body: () => unknown): RcllrError {
  try {
    body();
  } catch (error) {
    assert.ok(error instanceof RcllrError, String(error));
    return error;
  }
  assert.fail("no error");
}

const silent = { out: (): void => {}, err: (): void => {} };

describe("sensitivity", () => {
  const variants = [
    "\ufeff> SENSITIVE\n\n# t\n\nzorkmid\n",
    "# t\n\n  > SENSITIVE\n\nzorkmid\n",
    "# t\n\n\t> SENSITIVE\n\nzorkmid\n",
    "# t\ntext\r> SENSITIVE\rzorkmid\n",
    "# t\r\n\r\n> SENSITIVE\r\nzorkmid\r\n",
  ];
  variants.forEach((text, index) => {
    test("marker variant hides the note #" + index, () => {
      const b = brain();
      b.write("notes/a.md", text);
      assert.deepEqual(find(new Access(b.config), "zorkmid").hits, []);
    });
  });

  test("marker variant in readme hides the topic", () => {
    const b = brain();
    b.write("topics/t/README.md", "\ufeff  > SENSITIVE\n# T\n");
    b.note("topics/t/a.md", { body: "zorkmid" });
    assert.deepEqual(find(new Access(b.config), "zorkmid").hits, []);
  });

  test("unicode normalization cannot bypass always", () => {
    const b = brain();
    b.configure("[sensitive]\nalways = ['topics/" + "café".normalize("NFC") + "/']\n");
    b.note("topics/" + "café".normalize("NFD") + "/a.md", { body: "zorkmid" });
    assert.deepEqual(find(new Access(b.config), "zorkmid").hits, []);
  });
});

describe("scope", () => {
  test("new sub readme cannot move private notes into work", () => {
    const b = brain();
    b.write("topics/pub/README.md", document({ scope: "private" }));
    b.write("topics/pub/sub/b.md", document({ body: "wibble" }));
    const readme = { path: "topics/pub/sub/README.md", expected: null, content: document({ scope: "work" }) };
    assert.equal(caught(() => ingest(new Access(b.config, "work"), { changes: [readme] }, false, false)).key, "topic_unavailable");
    assert.deepEqual(find(new Access(b.config, "work"), "wibble").hits, []);
  });

  test("sub readme with the inherited scope is fine", () => {
    const b = brain();
    b.write("topics/pub/README.md", document({ scope: "private" }));
    b.write("topics/pub/sub/b.md", document({ body: "wibble" }));
    const readme = { path: "topics/pub/sub/README.md", expected: null, content: document({ scope: "private" }) };
    ingest(new Access(b.config, "private"), { changes: [readme] }, false, false);
  });

  test("readme table lists only notes of its own scope", () => {
    const b = brain();
    b.gitInit();
    b.write("topics/wk/README.md", document({ scope: "work" }));
    b.write("topics/wk/p.md", document({ scope: "private" }).replaceAll("Proven content.", "divorce lawyer"));
    b.write("topics/wk/w.md", document());
    generate(b.config);
    const readme = b.read("topics/wk/README.md");
    assert.ok(readme.includes("topics/wk/w.md"));
    assert.ok(!readme.includes("divorce") && !readme.includes("topics/wk/p.md"));
  });

  test("mixed readme does not list scoped notes", () => {
    const b = brain();
    b.gitInit();
    b.write("topics/mix/README.md", document());
    b.write("topics/mix/p.md", document({ scope: "private" }).replaceAll("Proven content.", "divorce lawyer"));
    generate(b.config);
    assert.ok(!b.read("topics/mix/README.md").includes("divorce"));
  });
});

function linkResult(b: Brain, target: string): string {
  const data = { changes: [{ path: "notes/x.md", expected: null, content: document({ body: "[x](" + target + ")" }) }] };
  try {
    ingest(new Access(b.config), data, true, false);
  } catch (error) {
    if (error instanceof RcllrError) return error.message;
    throw error;
  }
  return "accepted";
}

describe("existence oracles", () => {
  test("folders and files outside notes give no existence signal", () => {
    const b = brain();
    b.write("topics/health/README.md", document({ body: "> SENSITIVE" }));
    b.write("archive/old.md", "# Old\n");
    const absent = linkResult(b, "../topics/nonexist");
    for (const target of ["../topics/health", "../archive/old.md", "../.sensitive-paths", "../.git", "../rcllr.toml",
      "../nonexist-dir", "../.git/nonexist"]) {
      assert.equal(linkResult(b, target), absent, target);
    }
  });

  test("link to a readable topic folder resolves to its readme", () => {
    const b = brain();
    b.write("topics/open/README.md", document({ scope: "work" }));
    assert.equal(linkResult(b, "../topics/open"), "accepted");
    assert.equal(linkResult(b, "../topics/open/"), "accepted");
  });

  test("new file in hidden and missing topic look identical", () => {
    const b = brain();
    b.write("topics/health/README.md", document({ body: "> SENSITIVE" }));
    b.write("topics/pub/README.md", document({ scope: "private" }));
    const messages = new Set<string>();
    for (const [rel, scope] of [["topics/health/zz.md", null], ["topics/nonexist/zz.md", null],
      ["topics/pub/zz.md", "work"], ["topics/nonexist/zz.md", "work"]] as const) {
      const data = { changes: [{ path: rel, expected: null, content: document() }] };
      messages.add(caught(() => ingest(new Access(b.config, scope), data, true, false)).message);
    }
    assert.equal(messages.size, 1);
  });
});

describe("symlinks and robustness", () => {
  test("meta index refuses a symlinked paths file", () => {
    const b = brain();
    const victim = path.join(tempDir(), "victim.txt");
    fs.writeFileSync(victim, "keep\n");
    fs.unlinkSync(path.join(b.root, ".sensitive-paths"));
    fs.symlinkSync(victim, path.join(b.root, ".sensitive-paths"));
    b.note("notes/a.md", { body: "> SENSITIVE" });
    invoke(b, ["meta", "index"]);
    assert.equal(fs.readFileSync(victim, "utf-8"), "keep\n");
  });

  test("symlinked index is never read into notes", () => {
    const b = brain();
    const outside = path.join(tempDir(), "index.md");
    fs.writeFileSync(outside, "## Notes (flat)\n\n| File | Key fact | Aliases |\n|---|---|---|\n"
      + "| `notes/a.md` | OUTSIDE-SECRET | x |\n");
    b.gitInit();
    fs.symlinkSync(outside, path.join(b.root, "INDEX.md"));
    b.write("notes/a.md", "# A\n");
    migrate(b.config);
    assert.ok(!b.read("notes/a.md").includes("OUTSIDE-SECRET"));
  });

  // Root reads files without read permission, so the case cannot arise; Python's test fails as root too.
  test("unreadable note is never overwritten", { skip: process.getuid?.() === 0 || NO_FILE_MODES }, () => {
    const b = brain();
    b.gitInit();
    const note = b.write("notes/a.md", "# A\n\nprecious\n");
    fs.chmodSync(note, 0o200);
    try {
      migrate(b.config);
      generate(b.config);
    } finally {
      fs.chmodSync(note, 0o600);
    }
    assert.equal(b.read("notes/a.md"), "# A\n\nprecious\n");
  });

  test("migrate never touches sources", () => {
    const b = brain();
    b.gitInit();
    b.write("topics/t/sources/original.md", "Original text.\n");
    migrate(b.config);
    assert.equal(b.read("topics/t/sources/original.md"), "Original text.\n");
  });

  test("long bracket runs are checked in linear time", () => {
    const start = performance.now();
    references("[[".repeat(40000) + "\n" + "[".repeat(80000));
    assert.ok(performance.now() - start < 2000);
  });

  test("broken url is an issue, not a crash", () => {
    const b = brain();
    b.write("notes/a.md", document({ body: "[x](http://[)" }));
    assert.ok(check(new Access(b.config)).issues.some((problem) => problem.code === "link-invalid"));
  });
});

function routeBrain(b: Brain, alias: string): void {
  b.write("topics/meals/README.md", "---\nscope: private\n---\n> SENSITIVE\n# Meals\n");
  b.write("routes.json", JSON.stringify({ routes: [{ aliases: [alias], sources: "topics/meals/plan-*.md",
    scope: "private", kind: "dated-plan", allow_sensitive: true }] }));
}

function planBrain(b: Brain, allow: boolean | null): void {
  b.write("topics/meals/README.md", "---\nscope: private\n---\n> SENSITIVE\n# Meals\n");
  const route: Record<string, unknown> = { aliases: ["meal plan"], sources: "topics/meals/plan-*.md", scope: "private",
    kind: "dated-plan" };
  if (allow !== null) route.allow_sensitive = allow;
  b.write("routes.json", JSON.stringify({ routes: [route] }));
  b.write("topics/meals/plan-2020-01-06-to-12.md", "# Plan\n| Mon 01-06 | SOUP |\n");
}

describe("routes", () => {
  for (const alias of ["what", "the", "a", "is it"]) {
    test("stopword alias is rejected: " + alias, () => {
      const b = brain();
      routeBrain(b, alias);
      assert.throws(() => contextPacket(new Access(b.config), "What changed?"), AccessDenied);
    });
  }

  test("newest unreadable plan does not hide an older readable one", () => {
    const b = brain();
    routeBrain(b, "meal plan");
    b.write("topics/meals/plan-2020-01-06-to-12.md", "# Old plan\n| Mon 01-06 | OLD |\n");
    b.write("topics/meals/plan-2020-02-03-to-09.md", "---\nscope: work\n---\n# New plan\n");
    const packet = contextPacket(new Access(b.config, "private"), "meal plan", new PyDate(2020, 3, 1));
    assert.deepEqual(packet.hits.map((hit) => hit.path), ["topics/meals/plan-2020-01-06-to-12.md"]);
  });

  for (const allow of [null, false]) {
    test("route without opt-in never opens sensitive plans: " + String(allow), () => {
      const b = brain();
      planBrain(b, allow);
      assert.deepEqual(contextPacket(new Access(b.config, "private"), "meal plan", new PyDate(2020, 1, 7)).hits, []);
    });
  }

  test("route with opt-in opens sensitive plans", () => {
    const b = brain();
    planBrain(b, true);
    const packet = contextPacket(new Access(b.config, "private"), "meal plan", new PyDate(2020, 1, 7));
    assert.deepEqual(packet.hits.map((hit) => hit.path), ["topics/meals/plan-2020-01-06-to-12.md"]);
  });

  for (const value of ["yes", 1]) {
    test("route opt-in must be a boolean: " + String(value), () => {
      const b = brain();
      planBrain(b, true);
      const data = JSON.parse(b.read("routes.json"));
      data.routes[0].allow_sensitive = value;
      b.write("routes.json", JSON.stringify(data));
      assert.throws(() => contextPacket(new Access(b.config, "private"), "meal plan"), AccessDenied);
    });
  }

  const invalid: [Record<string, unknown>, string][] = [
    [{ aliases: ["meal plan"], sources: "topics/meals/plan-*.md", scope: "private", kind: "dated-plan",
      allow_sensitve: true }, "route 1: unknown key 'allow_sensitve'"],
    [{ aliases: ["meal plan"], sources: "topics/meals/plan-*.md", scope: "private", kind: "dated-plan",
      allow_sensitive: "yes" }, "route 1: allow_sensitive must be true or false"],
    [{ aliases: ["what"], sources: "topics/meals/plan-*.md", scope: "private", kind: "dated-plan" },
      "route 1: alias 'what' needs a real word"],
    [{ aliases: ["meal plan"], sources: "../x/*.md", scope: "private", kind: "dated-plan" }, "route 1: sources"],
    [{ aliases: ["meal plan"], sources: "topics/meals/plan-*.md", scope: "nope", kind: "dated-plan" }, "route 1: scope"],
  ];
  for (const [route, expected] of invalid) {
    test("invalid route names route and key: " + expected, () => {
      const b = brain();
      b.write("routes.json", JSON.stringify({ routes: [route] }));
      const done = invoke(b, ["context", "meal plan", "--serious"]);
      assert.equal(done.code, 2);
      assert.ok(done.err.includes("routes.json") && done.err.includes(expected), done.err);
    });
  }

  test("broken routes json is named", () => {
    const b = brain();
    b.write("routes.json", "{not json");
    const error = invoke(b, ["context", "meal plan", "--serious"]).err;
    assert.ok(error.includes("routes.json") && error.includes("JSON"));
  });
});

describe("pre-commit", () => {
  test("pre-commit never stages unstaged readme prose", () => {
    const s = synced();
    const b = s.brain;
    b.write("INDEX.md", "# Index\n\n## Topics\n\n## Notes (flat)\n\n## Bookmarks\n");
    b.write("topics/t/README.md", document({ scope: "work" }));
    b.commit("Topic");
    b.write("topics/t/README.md", document({ scope: "work" }) + "\nHALF WRITTEN DRAFT\n");
    b.write("topics/t/new.md", document());
    s.git(["add", "topics/t/new.md", "INDEX.md"]);
    preCommit(b.config, silent);
    assert.ok(!s.git(["show", ":topics/t/README.md"]).includes("HALF WRITTEN DRAFT"));
    assert.ok(b.read("topics/t/README.md").includes("HALF WRITTEN DRAFT"));
  });

  test("pre-commit never migrates partly staged notes", () => {
    const s = synced();
    const b = s.brain;
    b.write("INDEX.md", "# Index\n\n## Topics\n\n## Notes (flat)\n\n## Bookmarks\n");
    b.write("notes/raw.md", "# Raw\n");
    s.git(["add", "-A"]);
    b.write("notes/raw.md", "# Raw\n\nUNSTAGED\n");
    preCommit(b.config, silent);
    assert.ok(!s.git(["show", ":notes/raw.md"]).includes("UNSTAGED"));
  });
});

describe("write refresh", () => {
  test("saved write survives a deleted paths file upstream", () => {
    const b = brain();
    b.write("notes/a.md", document());
    const original = { ...seams };
    seams.prepareRepository = () => {};
    seams.syncLocked = () => fs.unlinkSync(path.join(b.root, ".sensitive-paths"));
    try {
      const result = ingest(new Access(b.config), { changes: [
        { path: "notes/a.md", expected: revision(b, "notes/a.md"), append: "More." }] });
      assert.ok(result.saved && result.sync === "ok");
      assert.deepEqual(result.revisions, {});
    } finally {
      Object.assign(seams, original);
    }
  });
});

function scopedTopics(b: Brain): void {
  b.gitInit();
  b.write("topics/job/README.md", document({ scope: "work", body: "August 2026, TODO ship it" }));
  b.write("topics/diary/README.md", document({ scope: "private", body: "August 2026, TODO call the divorce lawyer" }));
  b.commit("seed", "2020-01-01T12:00:00");
}

describe("extras and links.allow_outside", () => {
  test("extras and report respect the scope", () => {
    const b = brain();
    scopedTopics(b);
    for (const args of [["links", "--json", "--min-topics", "1"], ["curator", "--json", "--open-days", "1"],
      ["meta", "report"]]) {
      const done = invoke(b, [...args, "--scope", "work"]);
      assert.equal(done.code, 0, args.join(" ") + done.err);
      assert.ok(!done.out.includes("diary") && !done.out.includes("divorce"), args.join(" "));
    }
    const done = invoke(b, ["links", "--json", "--min-topics", "1", "--scope", "private"]);
    assert.ok(done.out.includes("diary") && !done.out.includes("job"));
  });

  test("extras default to query default", () => {
    const b = brain();
    b.configure("[scopes]\nquery_default = 'work'\n");
    scopedTopics(b);
    const done = invoke(b, ["curator", "--json", "--open-days", "1"]);
    assert.ok(done.code === 0 && !done.out.includes("divorce"));
  });

  test("links into allowed outside folders are fine", () => {
    const b = brain();
    b.configure("[links]\nallow_outside = ['archive', 'assets']\n");
    b.write("archive/old.md", "# Old\n");
    b.write("assets/diagram.png", "png");
    assert.equal(linkResult(b, "../archive/old.md"), "accepted");
    assert.equal(linkResult(b, "../assets/diagram.png"), "accepted");
  });

  test("allow outside keeps everything else closed", () => {
    const b = brain();
    b.configure("[links]\nallow_outside = ['archive']\n");
    b.write("archive/sub/x.md", "# X\n");
    const secret = path.join(tempDir(), "secret.md");
    fs.writeFileSync(secret, "x");
    fs.symlinkSync(secret, path.join(b.root, "archive", "link.md"));
    const absent = linkResult(b, "../archive/absent.md");
    assert.ok(absent.includes("link-unavailable"));
    for (const target of ["../archive/link.md", "../archive", "../archive/sub", "../.git/HEAD", "../rcllr.toml",
      "../archiveX/x.md"]) {
      assert.equal(linkResult(b, target), absent, target);
    }
    assert.equal(linkResult(b, "../archive/sub/x.md"), "accepted");
  });

  test("a symlinked non-markdown file looks like a missing one, wherever it points", () => {
    const b = brain();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "id_rsa"), "secret");
    fs.mkdirSync(path.join(b.root, "notes"), { recursive: true });
    fs.symlinkSync(path.join(outside, "id_rsa"), path.join(b.root, "notes", "present.bin"));
    fs.symlinkSync(path.join(outside, "absent"), path.join(b.root, "notes", "absent.bin"));
    const missing = linkResult(b, "nothing.bin");
    assert.ok(missing.includes("link-unavailable"), missing);
    assert.equal(linkResult(b, "present.bin"), missing);
    assert.equal(linkResult(b, "absent.bin"), missing);
  });

  test("non-markdown files inside note folders are fine", () => {
    const b = brain();
    b.write("notes/chart.png", "png");
    assert.equal(linkResult(b, "chart.png"), "accepted");
  });

  for (const value of ["['.git']", "['rcllr.toml']", "['../x']", "['notes']", "['./archive']"]) {
    test("allow outside rejects " + value, () => {
      const b = brain();
      assert.throws(() => b.configure("[links]\nallow_outside = " + value + "\n"),
        (error: unknown) => error instanceof ConfigError && /links\.allow_outside/.test(error.message));
    });
  }
});

describe("install", () => {
  test("install replace-command removes old hooks", () => {
    const b = brain();
    b.gitInit();
    b.write(".claude/settings.json", JSON.stringify({ hooks: {
      PostToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash",
        hooks: [{ type: "command", command: "python3 \"$X/scripts/old_hook.py\"" }] },
      { matcher: "Read", hooks: [{ type: "command", command: "keep-me" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "python3 \"$X/scripts/old_hook.py\"" }] }] } }));
    b.write(".codex/hooks.json", JSON.stringify({ hooks: { PostToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "python3 scripts/old_codex.py" }] }] } }));
    const done = invoke(b, ["install", "--replace-command", "scripts/old_hook.py", "--replace-command",
      "scripts/old_codex.py"]);
    assert.equal(done.code, 0, done.err);
    const claude = b.read(".claude/settings.json");
    const codex = b.read(".codex/hooks.json");
    assert.ok(!claude.includes("old_hook") && !codex.includes("old_codex"));
    assert.ok(claude.includes("keep-me") && claude.includes("hook agent") && codex.includes("hook agent"));
    assert.ok(done.out.includes("Removed"));
  });
});
