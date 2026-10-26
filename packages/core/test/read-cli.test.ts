/** Port of tests/test_cli_read.py. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

import { Access } from "../src/access.ts";
import { len, splitlines } from "../src/py.ts";
import { bounded } from "../src/render.ts";
import { contextPacket, find, type Packet } from "../src/search.ts";
import { brain, documentText, german, invoke, revision, spawnDev, tempDir } from "./helpers.ts";

process.setMaxListeners(0);

const paths = (packet: Packet): string[] => packet.hits.map((hit) => hit.path);
const json = (text: string): Packet => JSON.parse(text) as Packet;

describe("cli read", () => {
  test("all terms rank ahead of partial match and path is tiebreaker", () => {
    const b = brain();
    b.note("notes/partial.md", { body: "pnpm only" });
    b.note("notes/z.md");
    b.note("notes/a.md");
    const result = find(new Access(b.config), "pnpm esbuild");
    assert.deepEqual(paths(result), ["notes/a.md", "notes/z.md"]);
    assert.equal(result.match, "all");
  });

  test("partial results are explicit", () => {
    const b = brain();
    b.note("notes/partial.md", { body: "pnpm only" });
    assert.equal(find(new Access(b.config), "pnpm esbuild").match, "partial");
  });

  test("unicode search handles accents and case", () => {
    const b = brain();
    b.note("notes/uml.md", { title: "Überblick", body: "Straße und Café" });
    assert.equal(find(new Access(b.config), "STRASSE cafe").hits.length, 1);
  });

  test("configured weights change ranking", () => {
    const b = brain();
    b.note("notes/a.md", { title: "Other", body: "pnpm" });
    b.note("notes/b.md", { title: "Other", body: "nothing", fields: "aliases: [pnpm]\n" });
    assert.equal(find(new Access(b.config), "pnpm").hits[0]!.path, "notes/b.md");
    const config = b.configure("[search.weights]\naliases = 0\nbody = 50\n");
    assert.equal(find(new Access(config), "pnpm").hits[0]!.path, "notes/a.md");
  });

  test("cli blocks sensitive read without leaking", () => {
    const b = brain();
    b.write(".sensitive-paths", "notes/listed.md\n");
    b.note("notes/listed.md", { body: "SECRET listed" });
    const result = invoke(b, ["read", "notes/listed.md"]);
    assert.equal(result.code, 2);
    assert.ok(!(result.out + result.err).includes("SECRET"));
    assert.ok(!(result.out + result.err).includes("notes/listed.md"));
  });

  test("denied message follows tone", () => {
    const b = brain();
    b.write(".sensitive-paths", "notes/listed.md\n");
    b.note("notes/listed.md");
    assert.ok(invoke(b, ["read", "notes/listed.md"]).err.startsWith("Path unavailable"));
    b.configure("[ui]\ntone = 'cheeky'\n");
    assert.ok(invoke(b, ["read", "notes/listed.md"]).err.startsWith("Nice try."));
    assert.ok(invoke(b, ["read", "notes/listed.md", "--serious"]).err.startsWith("Path unavailable"));
  });

  const invalid = [["find", "!!!"], ["read", "notes/a.md", "--start", "0"], ["read", "notes/a.md", "--start", "4", "--end", "2"],
    ["find", "pnpm", "--limit", "11"], ["find", "pnpm", "--max-chars", "100"]];
  for (const args of invalid) {
    test("empty query and invalid ranges fail: " + args.join(" "), () => {
      const b = brain();
      b.note("notes/a.md");
      assert.equal(invoke(b, args).code, 2);
    });
  }

  test("read range json budget and no mutations", () => {
    const b = brain();
    const target = b.note("notes/a.md", { body: "pnpm esbuild ".repeat(300) + "\nlast" });
    const original = fs.readFileSync(target);
    const result = invoke(b, ["read", "notes/a.md", "--start", "8", "--end", "9", "--json", "--max-chars", "700"]);
    assert.deepEqual([result.code, result.err], [0, ""]);
    assert.ok(len(result.out) <= 700);
    const packet = json(result.out);
    assert.ok(packet.truncated);
    assert.equal(packet.hits[0]!.lines[0]!.n, 8);
    assert.deepEqual(fs.readFileSync(target), original);
  });

  test("find budget keeps valid json and reports more results", () => {
    const b = brain();
    for (let index = 0; index < 5; index++) b.note("notes/" + index + ".md", { body: "pnpm esbuild\n" + "x".repeat(2000) });
    const result = invoke(b, ["find", "pnpm esbuild", "--json", "--max-chars", "800"]);
    assert.deepEqual([result.code, result.err], [0, ""]);
    assert.ok(len(result.out) <= 800);
    const packet = json(result.out);
    assert.ok(packet.more && packet.truncated && packet.hits.length > 0);
  });

  test("topic filter and no results", () => {
    const b = brain();
    b.note("topics/build/a.md");
    b.note("notes/a.md");
    const result = invoke(b, ["find", "pnpm esbuild", "--topic", "build", "--json"]);
    assert.deepEqual([result.code, result.err], [0, ""]);
    assert.deepEqual(paths(json(result.out)), ["topics/build/a.md"]);
    assert.deepEqual(find(new Access(b.config), "absent").hits, []);
  });

  test("no results text follows tone", () => {
    const b = brain();
    b.note("notes/a.md");
    assert.ok(!invoke(b, ["find", "absent"]).out.includes("Knowing what you don't know"));
    b.configure("[ui]\ntone = 'cheeky'\n");
    assert.ok(invoke(b, ["find", "absent"]).out.includes("Knowing what you don't know is a start."));
    assert.ok(!invoke(b, ["find", "absent", "--serious"]).out.includes("Knowing what you don't know"));
  });

  test("read larger budget can return a full long line", () => {
    const b = brain();
    b.note("notes/a.md", { body: "x".repeat(1200) });
    const result = invoke(b, ["read", "notes/a.md", "--start", "8", "--json", "--max-chars", "2000"]);
    assert.deepEqual([result.code, result.err], [0, ""]);
    const packet = json(result.out);
    assert.ok(!packet.truncated);
    assert.equal(packet.hits[0]!.lines[0]!.text, "x".repeat(1200));
  });

  test("excerpt prefers explanation over matching heading", () => {
    const b = brain();
    b.note("notes/a.md", { title: "pnpm esbuild", body: "Intro\n\npnpm esbuild needs approved builds." });
    const hit = find(new Access(b.config), "pnpm esbuild").hits[0]!;
    assert.ok(hit.lines.some((line) => line.text.includes("needs approved builds")));
  });

  test("read section supports date suffix and nested headings", () => {
    const b = brain();
    b.note("notes/a.md", { body: "Intro\n## Review, 2026-10-04\nTarget\n### Details\nNested\n## End\nOTHER" });
    const result = invoke(b, ["read", "notes/a.md", "--section", "Review", "--json"]);
    assert.deepEqual([result.code, result.err], [0, ""]);
    const hit = json(result.out).hits[0]!;
    assert.ok(hit.revision);
    const text = hit.lines.map((line) => line.text).join("\n");
    assert.ok(text.includes("Target") && text.includes("Nested") && !text.includes("OTHER"));
    const original = splitlines(b.read("notes/a.md"));
    for (const line of hit.lines) assert.equal(line.text, original[line.n - 1]);
  });

  test("read --json names the revision at the top, ready for write --expected", () => {
    const b = brain();
    b.note("notes/a.md", { body: "Text" });
    const packet = JSON.parse(invoke(b, ["read", "notes/a.md", "--json"]).out);
    assert.equal(packet.revision, packet.hits[0].revision);
    assert.equal(JSON.parse(invoke(b, ["find", "Text", "--json"]).out).revision, undefined);
  });

  test("a write without --expected says what to pass, also for --append", () => {
    const b = brain();
    const result = invoke(b, ["write", "notes/a.md", "--append"]);
    assert.equal(result.code, 2);
    assert.ok(result.err.replace(/\s+/g, " ").includes("error: missing --expected. Pass new for a new file, otherwise the "
      + "rev from read or context; --append needs it too."), result.err);
  });

  test("read section does not match code and rejects ambiguity", () => {
    const b = brain();
    b.note("notes/a.md", { body: "```md\n## Review\nfake\n```\n## Review, today\nActual" });
    const result = invoke(b, ["read", "notes/a.md", "--section", "Review", "--json"]);
    assert.deepEqual([result.code, result.err], [0, ""]);
    assert.ok(!result.out.includes("fake"));
    b.note("notes/a.md", { body: "## Review, today\nA\n## Review, yesterday\nB" });
    assert.equal(invoke(b, ["read", "notes/a.md", "--section", "Review"]).code, 2);
  });

  for (const args of [["read", "notes/a.md", "--section", "Missing"], ["read", "notes/a.md", "--section", "Docker", "--start", "2"]]) {
    test("read section rejects missing or conflicting range: " + args.join(" "), () => {
      const b = brain();
      b.note("notes/a.md");
      assert.equal(invoke(b, args).code, 2);
    });
  }

  test("text output shows short revision in header", () => {
    const b = brain();
    b.write("notes/a.md", documentText({ body: "pnpm esbuild" }));
    const rev = revision(b, "notes/a.md").slice(0, 12);
    for (const args of [["find", "pnpm"], ["read", "notes/a.md"], ["context", "pnpm esbuild"]]) {
      const result = invoke(b, args);
      assert.equal(result.code, 0);
      assert.ok(result.out.includes("notes/a.md | rev=" + rev + " |"));
    }
  });

  test("context reports ignored and missing terms", () => {
    const b = brain();
    b.write("notes/a.md", documentText({ body: "pnpm esbuild" }));
    const packet = contextPacket(new Access(b.config), "What is there about pnpm quantum?");
    assert.deepEqual(packet.ignored, ["what", "is", "there", "about"]);
    assert.deepEqual(packet.missing, ["quantum"]);
    const output = bounded(packet, 6000, false, "plain");
    assert.ok(output.includes("Ignored: what, is, there, about"));
    assert.ok(output.includes("Not found: quantum"));
  });

  test("german locale uses german stopwords", () => {
    const g = german();
    g.write("notes/a.md", "---\nstand: 2026-01-01\n---\n\n# A\n\npnpm esbuild\n");
    assert.deepEqual(contextPacket(new Access(g.config), "Was steht zu pnpm quantum?").ignored, ["was", "steht", "zu"]);
  });

  test("find without gaps prints no hint lines", () => {
    const b = brain();
    b.write("notes/a.md", documentText({ body: "pnpm esbuild" }));
    const output = bounded(find(new Access(b.config), "pnpm"), 6000, false, "plain");
    assert.ok(!output.includes("Ignored") && !output.includes("Not found"));
  });

  test("topic readme ranks first when query names the topic", () => {
    const b = brain();
    b.write("bookmarks/agentic-engineering.md", documentText({
      title: "Bookmarks: agentic-engineering", body: "agentic engineering links agentic engineering" }));
    b.write("topics/agentic-engineering/README.md",
      documentText({ title: "Agentic Engineering" }).replace("---\n\n", "scope: work\n---\n\n"));
    b.write("topics/agentic-engineering/detail.md", documentText({ title: "Agentic Engineering Detail" }));
    const access = new Access(b.config);
    for (const packet of [find(access, "agentic engineering"), contextPacket(access, "What is there about agentic engineering?")]) {
      assert.equal(packet.hits[0]!.path, "topics/agentic-engineering/README.md");
    }
  });

  for (const command of ["context", "find"]) {
    for (const asJson of [false, true]) {
      test("single long missing term keeps source and respects budget: " + command + " " + asJson, () => {
        const b = brain();
        b.write("notes/a.md", documentText({ body: "pnpm esbuild" }));
        const result = invoke(b, [command, "pnpm " + "x".repeat(800), "--max-chars", "500", ...(asJson ? ["--json"] : [])]);
        assert.deepEqual([result.code, result.err], [0, ""]);
        assert.ok(len(result.out) <= 500);
        assert.ok(result.out.includes("notes/a.md") && result.out.includes("pnpm esbuild"));
        if (asJson) {
          const packet = json(result.out);
          assert.ok(packet.truncated);
          assert.ok(packet.missing![0]!.endsWith("…"));
        } else {
          assert.ok(result.out.includes("Not found: xxx"));
          assert.ok(result.out.includes("Output truncated"));
        }
      });

      test("single long missing term without hits respects budget: " + command + " " + asJson, () => {
        const b = brain();
        const result = invoke(b, [command, "x".repeat(800), "--max-chars", "500", "--serious", ...(asJson ? ["--json"] : [])]);
        assert.deepEqual([result.code, result.err], [0, ""]);
        assert.ok(len(result.out) <= 500);
        if (asJson) {
          const packet = json(result.out);
          assert.deepEqual(packet.hits, []);
          assert.ok(packet.truncated);
          assert.ok(packet.missing![0]!.endsWith("…"));
        } else {
          assert.ok(result.out.includes("Nothing found"));
          assert.ok(result.out.includes("Not found: xxx"));
        }
      });
    }
  }

  for (const asJson of [false, true]) {
    test("long first term and hint lists preserve packet and source: " + asJson, () => {
      const b = brain();
      b.write("notes/a.md", documentText({ body: "pnpm esbuild" }));
      const missing = Array.from({ length: 150 }, (_, i) => "missing" + i).join(" ");
      const packet = contextPacket(new Access(b.config), "What is there about pnpm " + "x".repeat(800) + " " + missing);
      const before = JSON.stringify(packet);
      const output = bounded(packet, 500, asJson, "plain");
      assert.ok(len(output) <= 500);
      assert.ok(output.includes("notes/a.md") && output.includes("pnpm esbuild"));
      assert.equal(JSON.stringify(packet), before);
    });
  }

  test("long search hints stay within budget and keep hits", () => {
    const b = brain();
    b.write("notes/a.md", documentText({ body: "pnpm esbuild" }));
    const query = "pnpm " + Array.from({ length: 150 }, (_, i) => "missing" + String(i).padStart(3, "0")).join(" ");
    const access = new Access(b.config);
    const output = bounded(contextPacket(access, query), 500, false, "plain");
    assert.ok(len(output) <= 500);
    assert.ok(output.includes("notes/a.md"));
    assert.ok(output.includes("Not found: missing000"));
    const packet = json(bounded(contextPacket(access, query), 500, true, "plain"));
    assert.equal(packet.hits[0]!.path, "notes/a.md");
    assert.ok(packet.truncated);
  });

  test("read end without start also skips frontmatter", () => {
    const b = brain();
    b.write("notes/a.md", documentText({ body: "One\nTwo" }));
    const packet = json(invoke(b, ["read", "notes/a.md", "--end", "12", "--json"]).out);
    assert.deepEqual(packet.hits[0]!.lines.map((line) => line.n), [11, 12]);
  });

  test("read end inside frontmatter returns those lines", () => {
    const b = brain();
    b.write("notes/a.md", documentText());
    const packet = json(invoke(b, ["read", "notes/a.md", "--end", "3", "--json"]).out);
    assert.deepEqual(packet.hits[0]!.lines.map((line) => line.n), [1, 2, 3]);
  });

  test("read skips frontmatter by default", () => {
    const b = brain();
    b.write("notes/a.md", documentText({ body: "Content" }));
    const hit = json(invoke(b, ["read", "notes/a.md", "--json"]).out).hits[0]!;
    assert.equal(hit.lines[0]!.n, 11);
    assert.ok(!hit.lines.map((line) => line.text).join("").includes("key_fact:"));
    assert.equal(hit.key_fact, "Proven content.");
  });

  test("read start one still returns frontmatter", () => {
    const b = brain();
    b.write("notes/a.md", documentText());
    const packet = json(invoke(b, ["read", "notes/a.md", "--start", "1", "--json"]).out);
    assert.deepEqual(packet.hits[0]!.lines[0], { n: 1, text: "---" });
  });

  test("root option and missing config", () => {
    const b = brain();
    b.write("notes/a.md", documentText({ body: "pnpm" }));
    const run = (args: string[]): number | null => spawnDev(args, { cwd: b.root, encoding: "utf-8" }).status;
    assert.equal(run(["--root", b.root, "find", "pnpm", "--json"]), 0);
    assert.equal(run(["find", "pnpm", "--root", b.root, "--json"]), 0);
    const empty = path.join(tempDir(), "empty");
    fs.mkdirSync(empty);
    assert.equal(run(["--root", empty, "find", "pnpm"]), 2);
  });

  test("read help explains end before body and shows example", () => {
    const result = spawnDev(["read", "--help"], { encoding: "utf-8" });
    assert.equal(result.status, 0);
    const help = result.stdout.replace(/\s+/g, " ");
    assert.ok(help.includes("If --end lies before the first body line"));
    assert.ok(help.includes("rcllr read notes/topic.md --end 3"));
  });
});
