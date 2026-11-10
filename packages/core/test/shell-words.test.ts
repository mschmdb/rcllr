/** The shell splitter the permission hook uses to find `--allow-sensitive` in a Bash command. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { splitCommand, type Word } from "../src/shell-words.ts";

function texts(command: string): string[][] {
  return splitCommand(command).map((words: readonly Word[]) => words.map((word) => word.text));
}

test("plain words and quotes", () => {
  assert.deepEqual(texts(`rcllr read 'a b.md' "c d" e\\ f`), [["rcllr", "read", "a b.md", "c d", "e f"]]);
});

test("operators split subcommands", () => {
  assert.deepEqual(texts("git fetch && rcllr read x || echo no; ls | head & wait"),
    [["git", "fetch"], ["rcllr", "read", "x"], ["echo", "no"], ["ls"], ["head"], ["wait"]]);
});

test("newlines split subcommands, a backslash-newline does not", () => {
  assert.deepEqual(texts("rcllr read \\\n x\nls"), [["rcllr", "read", "x"], ["ls"]]);
});

test("command substitution and subshells open their own subcommands", () => {
  assert.deepEqual(texts("rev=$(rcllr read x --end 1) && (cd y; rcllr find z)"),
    [["rev="], ["rcllr", "read", "x", "--end", "1"], ["cd", "y"], ["rcllr", "find", "z"]]);
  assert.deepEqual(texts("echo `rcllr read x`"), [["echo", ""], ["rcllr", "read", "x"]]);
  const [outer] = splitCommand("rcllr read --allow-sensitive $(echo topics/x/)");
  assert.deepEqual(outer!.at(-1), { text: "", dynamic: true });
});

test("variables, globs, tildes and braces mark a word dynamic", () => {
  for (const word of ["$X", "${X}", "a*", "b?", "[ab]", "~/x", "{a,b}", '"$X"', '"`x`"']) {
    const [first] = splitCommand("rcllr " + word);
    assert.equal(first![1]!.dynamic, true, word);
  }
  for (const word of ["'$X'", "'a*'", "\\$X", "topics/x/", '"a b"']) {
    const [first] = splitCommand("rcllr " + word);
    assert.equal(first![1]!.dynamic, false, word);
  }
});

test("a quoted heredoc body is skipped, an unquoted one is kept as one dynamic word", () => {
  const quoted = splitCommand("rcllr ingest --input - <<'EOF'\n{\"x\": \"--allow-sensitive a\"}\nEOF\nls");
  assert.deepEqual(quoted.map((words) => words.map((word) => word.text)), [["rcllr", "ingest", "--input", "-"], ["ls"]]);
  const open = splitCommand("cat <<EOF\n$(rcllr read x)\nEOF");
  assert.deepEqual(open[0]!.map((word) => word.text), ["cat"]);
  assert.equal(open[1]![0]!.dynamic, true);
  assert.ok(open[1]![0]!.text.includes("rcllr read x"));
});

test("a heredoc with <<- strips leading tabs before the delimiter", () => {
  assert.deepEqual(texts("cat <<-EOF\n\tbody\n\tEOF\nls"), [["cat"], ["body\n"], ["ls"]]);
});

test("redirections end a word without splitting the subcommand", () => {
  assert.deepEqual(texts("rcllr read x 2>&1 >out.txt"), [["rcllr", "read", "x", "2", "1", "out.txt"]]);
});

test("comments end at the line break", () => {
  assert.deepEqual(texts("rcllr read x # --allow-sensitive y\nls"), [["rcllr", "read", "x"], ["ls"]]);
});

test("unterminated quotes, substitutions and heredocs throw", () => {
  for (const command of ["rcllr 'x", 'rcllr "x', "rcllr $(read", "cat <<EOF\nbody", "rcllr x\\"]) {
    assert.throws(() => splitCommand(command), /unparsable/, command);
  }
});
