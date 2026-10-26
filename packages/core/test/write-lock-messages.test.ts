/** Port of tests/test_lock.py and tests/test_messages.py. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

import { AccessDenied, RcllrError, Rejected } from "../src/errors.ts";
import { lockPath, withRepositoryLock } from "../src/lock.ts";
import { CHEEKY, INFO_KEYS, PLAIN, text } from "../src/messages.ts";
import { tempDir } from "./helpers.ts";

function fields(template: string): Set<string> {
  return new Set([...template.replaceAll("{{", "").replaceAll("}}", "").matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!));
}

describe("lock", () => {
  test("lock blocks a second writer", () => {
    const root = tempDir();
    let error: unknown;
    withRepositoryLock(root, () => {
      try {
        withRepositoryLock(root, () => {}, 0.1);
      } catch (caught) {
        error = caught;
      }
    });
    assert.ok(error instanceof RcllrError);
    assert.equal(error.key, "busy");
  });

  test("a lock path that cannot be read gives up after the timeout instead of spinning", () => {
    const root = tempDir();
    const lock = lockPath(root);
    fs.mkdirSync(lock);
    try {
      const started = Date.now();
      let error: unknown;
      try {
        withRepositoryLock(root, () => {}, 0.2);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof RcllrError && error.key === "busy", String(error));
      assert.ok(Date.now() - started < 5000);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  });

  test("lock is released", () => {
    const root = tempDir();
    withRepositoryLock(root, () => {});
    withRepositoryLock(root, () => {}, 0.1);
  });

  test("lock is released after an error", () => {
    const root = tempDir();
    assert.throws(() => withRepositoryLock(root, () => {
      throw new Error("boom");
    }), /boom/);
    withRepositoryLock(root, () => {}, 0.1);
  });

  test("different brains do not block each other", () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "a"));
    fs.mkdirSync(path.join(root, "b"));
    withRepositoryLock(path.join(root, "a"), () => withRepositoryLock(path.join(root, "b"), () => {}, 0.1));
  });
});

describe("messages", () => {
  test("every cheeky message has a plain twin", () => {
    for (const key of Object.keys(CHEEKY)) assert.ok(key in PLAIN, key);
  });

  test("cheeky errors keep the precise plain text", () => {
    for (const [key, template] of Object.entries(CHEEKY)) {
      if (!INFO_KEYS.has(key)) assert.ok(template.includes("{plain}"), key);
    }
  });

  test("plain tone never jokes", () => {
    for (const [key, template] of Object.entries(PLAIN)) {
      assert.ok(!template.toLowerCase().includes("rcllr!"), key);
      assert.ok(!template.includes("Dummkopf"), key);
    }
  });

  test("no tone calls the user names", () => {
    for (const [key, template] of Object.entries(CHEEKY)) assert.ok(!template.includes("Dummkopf"), key);
  });

  test("cheeky uses no extra parameters", () => {
    for (const [key, template] of Object.entries(CHEEKY)) {
      const allowed = fields(PLAIN[key]!);
      for (const name of fields(template)) assert.ok(name === "plain" || allowed.has(name), key);
    }
  });

  const cases: [string, Record<string, unknown>][] = [["path_denied", {}], ["no_results", {}], ["sync_ok", {}],
    ["version_conflict", { rev: "abc123abc123" }]];
  for (const [key, params] of cases) {
    test("tone switch: " + key, () => {
      const plain = text(key, "plain", params);
      const cheeky = text(key, "cheeky", params);
      assert.notEqual(plain, cheeky);
      assert.ok(cheeky.includes(plain) || key === "sync_ok");
    });
  }

  test("brief examples", () => {
    assert.ok(text("no_results", "cheeky").endsWith("Knowing what you don't know is a start."));
    assert.equal(text("sync_ok", "cheeky"), "Brain synced.");
    const conflict = text("version_conflict", "cheeky", { rev: "abc123abc123" });
    assert.ok(conflict.startsWith("Someone else touched this note. Read it again."));
    assert.ok(conflict.includes("rev=abc123abc123"));
  });

  test("denied path does not reveal whether it is sensitive or missing", () => {
    for (const tone of ["plain", "cheeky"]) assert.ok(!text("path_denied", tone).toLowerCase().includes("sensitive"));
  });

  test("unknown tone falls back to plain", () => {
    assert.equal(text("no_results", "unknown"), text("no_results", "plain"));
  });

  test("missing message key is a programming error", () => {
    assert.throws(() => text("does-not-exist", "plain"));
  });

  test("errors render plain by default and by tone on request", () => {
    const error = new AccessDenied("path_denied");
    assert.equal(String(error), text("path_denied", "plain"));
    assert.equal(error.render("cheeky"), text("path_denied", "cheeky"));
    assert.ok(error instanceof RcllrError);
    assert.equal(error.exitCode, 2);
    assert.equal(new Rejected("search_needs_term").exitCode, 2);
  });

  test("every template formats with its own fields", () => {
    for (const [key, template] of Object.entries(PLAIN)) {
      const params = Object.fromEntries([...fields(template)].map((name) => [name, "x"]));
      text(key, "plain", params);
      if (key in CHEEKY) text(key, "cheeky", params);
    }
  });
});
