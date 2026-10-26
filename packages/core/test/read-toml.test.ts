/** Parser edge cases found by the toml-test suite (`pnpm test:toml`). */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseToml, TomlDateTime, TomlError, tomlEscape } from "../src/toml.ts";

test("date-times with out-of-range fields are rejected", () => {
  for (const value of [
    "2006-01-00", "2006-00-01", "2006-13-01", "2006-01-32", "2006-02-29", "2006-02-30", "2006-04-31",
    "2006-01-01T24:00:00", "2006-01-01T00:60:00", "2006-01-01T00:00:61", "2006-01-01T00:00:00+24:00",
    "2006-01-01T00:00:00+00:60", "24:00:00", "00:60:00", "00:00:61",
  ]) {
    assert.throws(() => parseToml("d = " + value), TomlError, value);
  }
});

test("valid edge dates parse", () => {
  for (const value of ["2000-02-29", "2004-02-29", "2006-12-31", "1979-05-27T23:59:60Z", "2006-01-01T00:00:00-23:59"]) {
    const parsed = parseToml("d = " + value);
    assert.ok(parsed.d instanceof TomlDateTime, value);
    assert.equal(parsed.d.text, value);
  }
  assert.throws(() => parseToml("d = 1900-02-29"), TomlError);
});

test("integers beyond 2^53 are rejected instead of rounded", () => {
  for (const value of ["9223372036854775807", "-9223372036854775808", "9007199254740992", "0x20000000000000"]) {
    assert.throws(() => parseToml("n = " + value), TomlError, value);
  }
  assert.equal(parseToml("n = 9007199254740991").n, Number.MAX_SAFE_INTEGER);
  assert.equal(parseToml("n = -9_007_199_254_740_991").n, -Number.MAX_SAFE_INTEGER);
});

test("TOML 1.1 syntax is rejected: the parser reads strict TOML 1.0", () => {
  for (const bad of [
    's = "\\e"', 's = """\\e"""', 's = "\\x41"', 's = "\\x"',
    "t = 07:32", "d = 1979-05-27T07:32", "d = 1979-05-27 07:32Z", "d = 1979-05-27T07:32-07:00",
    "t = {\n a = 1 }", "t = { a = 1,\n b = 2 }", "t = { a = 1, }", "t = { # c\n a = 1 }",
    "é = 1", "kéy = 1",
  ]) {
    assert.throws(() => parseToml(bad), TomlError, JSON.stringify(bad));
  }
  assert.deepEqual({ ...parseToml('s = "\\u001b\\t"') }, { s: "\x1b\t" });
  assert.deepEqual({ ...parseToml("t = { a = 1, b = { c = 2 } }").t as object }, { a: 1, b: parseToml("c = 2") });
});

test("CRLF line endings parse like LF, a bare CR is rejected", () => {
  const text = '# c\na = "x" # c\nm = """\nl1\nl2 \\\n  l3"""\nl = \'\'\'\nr1\nr2\'\'\'\nar = [\n  1, # c\n  2,\n]\n[t]\nb = 1\n';
  assert.deepEqual(parseToml(text.replace(/\n/g, "\r\n")), parseToml(text));
  assert.equal(parseToml(text).m, "l1\nl2 l3");
  for (const bad of ["a = 1\rb = 2", "# c\r\na = 1\r", 'm = """\rx"""', "l = '''x\ry'''", "# c\rx\n", "ar = [1,\r2]"]) {
    assert.throws(() => parseToml(bad), TomlError, JSON.stringify(bad));
  }
});

test("tomlEscape round-trips Windows paths, quotes and control characters in a basic string", () => {
  for (const value of ["C:\\Users\\me\\remote.git", 'a"b', "tab\there", "nul\u0000x\u007f", "über", "me@example.org:me/b.git"]) {
    assert.equal(parseToml('v = "' + tomlEscape(value) + '"').v, value, JSON.stringify(value));
  }
  assert.equal(tomlEscape("me@example.org:me/brain.git"), "me@example.org:me/brain.git");
});

test("a table reached through a dotted key cannot be opened again with a header", () => {
  assert.throws(() => parseToml("[a.b.c]\nx = 1\n[a]\nb.d = 2\n[a.b]\nx = 3\n"), TomlError);
});
