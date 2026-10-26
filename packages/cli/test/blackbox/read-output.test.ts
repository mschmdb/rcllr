/** Read commands: header and text format of `read`, and the JSON packet and hit keys. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Sandbox, note, revOf } from "./harness.ts";
import type { Brain } from "./harness.ts";

const HEADER = /^(?<path>\S+) \| rev=(?<rev>[0-9a-f]{12}) \| updated=(?<updated>\S+) \| status=(?<status>\S+) \| scope=(?<scope>\S+)$/;
const HIT_KEYS = ["path", "title", "updated", "status", "scope", "key_fact", "lines", "revision"];
const PACKET_KEYS = ["hits", "match", "more", "truncated"];
const DOC = "---\nupdated: 2026-10-04\nstatus: active\nkey_fact: Fact here.\n---\n\n# Docker\n\npnpm esbuild fails\n\n"
  + "## Open questions\n\nOne\n\n## Other\n\nTwo\n";

function brain(): Brain {
  return new Sandbox().brain();
}

function docker(): Brain {
  const target = brain();
  target.write("notes/docker.md", DOC);
  return target;
}

/** Python's str.splitlines(): no empty last line after a final newline. */
function splitlines(value: string): string[] {
  if (value === "") return [];
  return (value.endsWith("\n") ? value.slice(0, -1) : value).split("\n");
}

function linesOf(output: string): [number, string][] {
  const found: [number, string][] = [];
  for (const line of splitlines(output)) {
    const match = /^(\d+): ?(.*)$/.exec(line);
    if (match) found.push([Number(match[1]), match[2]!]);
  }
  return found;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

// --- header and text format -------------------------------------------------------------------------------------

test("read prints a header with path, rev, updated, status and scope", () => {
  const result = docker().run(["read", "notes/docker.md"]);
  assert.equal(result.code, 0);
  const match = HEADER.exec(splitlines(result.out)[0]!);
  assert.ok(match !== null);
  assert.equal(match.groups!.path, "notes/docker.md");
  assert.deepEqual([match.groups!.updated, match.groups!.status, match.groups!.scope], ["2026-10-04", "active", "mixed"]);
});

test("read prints the key fact after the header", () => {
  assert.equal(splitlines(docker().run(["read", "notes/docker.md"]).out)[1], "Key fact: Fact here.");
});

test("read omits the key fact line without a key fact", () => {
  const target = brain();
  target.write("notes/plain.md", note({ title: "Plain" }));
  assert.ok(!target.run(["read", "notes/plain.md"]).out.includes("Key fact:"));
});

test("header shows question marks for missing updated and status", () => {
  const target = brain();
  target.write("notes/bare.md", "# Bare\n\ntext\n");
  const header = splitlines(target.run(["read", "notes/bare.md"]).out)[0]!;
  assert.ok(header.includes(" | updated=? | status=? | scope=mixed"), header);
});

test("read output starts after the frontmatter with physical line numbers", () => {
  const numbered = linesOf(docker().run(["read", "notes/docker.md"]).out);
  assert.deepEqual(numbered[0], [7, "# Docker"]);
  assert.deepEqual(numbered.at(-1), [17, "Two"]);
  const fileLines = splitlines(DOC);
  assert.ok(numbered.every(([number, text]) => fileLines[number - 1] === text));
});

test("read without frontmatter starts at line 1", () => {
  const target = brain();
  target.write("notes/bare.md", "# Bare\n\ntext\n");
  assert.deepEqual(linesOf(target.run(["read", "notes/bare.md"]).out)[0], [1, "# Bare"]);
});

test("rev in the header is the start of the JSON revision", () => {
  const target = docker();
  const text = target.run(["read", "notes/docker.md"]).out;
  const revision: string = JSON.parse(target.run(["read", "notes/docker.md", "--json"]).out).hits[0].revision;
  assert.match(revision, /^[0-9a-f]{64}$/);
  assert.ok(revision.startsWith(revOf(text, "notes/docker.md")));
});

test("revision changes when the file changes", () => {
  const target = docker();
  const before = revOf(target.run(["read", "notes/docker.md"]).out, "notes/docker.md");
  target.write("notes/docker.md", DOC + "\nMore\n");
  assert.notEqual(revOf(target.run(["read", "notes/docker.md"]).out, "notes/docker.md"), before);
});

test("revision is sha256 of the file bytes", () => {
  const target = docker();
  const expected = createHash("sha256").update(fs.readFileSync(path.join(target.root, "notes/docker.md"))).digest("hex");
  assert.equal(JSON.parse(target.run(["read", "notes/docker.md", "--json"]).out).hits[0].revision, expected);
});

// --- JSON ---------------------------------------------------------------------------------------------------------

test("read JSON has the packet and hit keys", () => {
  const packet = JSON.parse(docker().run(["read", "notes/docker.md", "--json"]).out);
  // A single read names the revision at the top too, ready for write --expected.
  assert.deepEqual(sorted(Object.keys(packet)), sorted([...PACKET_KEYS, "revision"]));
  assert.equal(packet.revision, packet.hits[0].revision);
  assert.deepEqual([packet.match, packet.more, packet.truncated], ["direct", false, false]);
  const hit = packet.hits[0];
  assert.deepEqual(sorted(Object.keys(hit)), sorted(HIT_KEYS));
  assert.deepEqual([hit.path, hit.title, hit.updated, hit.status, hit.scope, hit.key_fact],
    ["notes/docker.md", "Docker", "2026-10-04", "active", "mixed", "Fact here."]);
});

test("read JSON lines carry n and text", () => {
  const lines: Record<string, unknown>[] = JSON.parse(docker().run(["read", "notes/docker.md", "--json"]).out).hits[0].lines;
  assert.deepEqual(lines[0], { n: 7, text: "# Docker" });
  assert.ok(lines.every((line) => JSON.stringify(sorted(Object.keys(line))) === JSON.stringify(["n", "text"])));
});

test("JSON output is compact on one line", () => {
  const out = docker().run(["read", "notes/docker.md", "--json"]).out;
  assert.equal(out.split("\n").length - 1, 1);
  assert.ok(!out.split('"lines"')[0]!.includes(", "));
});

test("title falls back to the file name without heading", () => {
  const target = brain();
  target.write("notes/headless.md", "no heading\n");
  assert.equal(JSON.parse(target.run(["read", "notes/headless.md", "--json"]).out).hits[0].title, "headless");
});

test("find JSON without hits has the missing terms", () => {
  const packet = JSON.parse(docker().run(["find", "zzz", "--json"]).out);
  assert.deepEqual(packet, { hits: [], match: "none", more: false, truncated: false, missing: ["zzz"] });
});

test("find JSON partial match lists missing terms", () => {
  const packet = JSON.parse(docker().run(["find", "docker pnpm zzz", "--json"]).out);
  assert.equal(packet.match, "partial");
  assert.deepEqual(packet.missing, ["zzz"]);
  assert.ok(!("ignored" in packet));
});

test("context JSON lists ignored filler words", () => {
  const packet = JSON.parse(docker().run(["context", "What is the docker thing?", "--json"]).out);
  assert.deepEqual(packet.ignored, ["what", "is", "the"]);
  assert.deepEqual(packet.missing, ["thing"]);
  assert.equal(packet.match, "partial");
});
