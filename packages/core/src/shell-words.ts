/**
 * Split a Bash command into subcommands of words, well enough to find rcllr flags in it.
 *
 * This is no full shell parser. It exists for the permission hook, which must fail closed: whatever it
 * cannot read for sure comes back as `dynamic` (the shell computes it at run time) or throws
 * `UnparsableCommand`. Callers treat both as "unknown" and ask the user.
 */

export interface Word {
  readonly text: string;
  /** The shell would expand this word at run time: variables, substitutions, globs, tildes, braces. */
  readonly dynamic: boolean;
}

export class UnparsableCommand extends Error {
  constructor() {
    super("unparsable shell command");
  }
}

interface Heredoc {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
}

const SEPARATORS = new Set([";", "&", "|"]);
const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);
const GLOB = new Set(["*", "?", "[", "{"]);

class Lexer {
  private readonly src: string;
  private i = 0;
  private readonly groups: Word[][] = [];
  private current: Word[] = [];
  private buf = "";
  private inWord = false;
  private dynamic = false;
  /** Open substitutions and subshells, by the character that closes them. */
  private readonly open: string[] = [];
  private readonly heredocs: Heredoc[] = [];

  constructor(src: string) {
    this.src = src;
  }

  run(): Word[][] {
    while (this.i < this.src.length) this.step(this.src[this.i]!);
    if (this.open.length > 0 || this.heredocs.length > 0) throw new UnparsableCommand();
    this.endCommand();
    return this.groups;
  }

  private step(c: string): void {
    if (c === "\\") return this.escaped();
    if (c === "'") return this.singleQuoted();
    if (c === '"') return this.doubleQuoted();
    if (c === "`") return this.backtick();
    if (c === "$") return this.dollar();
    if (c === "(") return this.openGroup(1);
    if (c === ")") return this.closeGroup(")");
    if (c === "#" && !this.inWord) return this.comment();
    if (c === "\n") return this.newline();
    if (c === " " || c === "\t") {
      this.endWord();
      this.i++;
      return;
    }
    if (SEPARATORS.has(c)) {
      this.endCommand();
      this.i++;
      return;
    }
    if (c === "<" || c === ">") return this.redirect(c);
    if (GLOB.has(c) || (c === "~" && !this.inWord)) this.dynamic = true;
    this.add(c);
    this.i++;
  }

  private add(text: string): void {
    this.buf += text;
    this.inWord = true;
  }

  private endWord(): void {
    if (this.inWord) this.current.push({ text: this.buf, dynamic: this.dynamic });
    this.buf = "";
    this.inWord = false;
    this.dynamic = false;
  }

  private endCommand(): void {
    this.endWord();
    if (this.current.length > 0) this.groups.push(this.current);
    this.current = [];
  }

  private escaped(): void {
    const next = this.src[this.i + 1];
    if (next === undefined) throw new UnparsableCommand();
    if (next !== "\n") this.add(next);
    this.i += 2;
  }

  private singleQuoted(): void {
    const end = this.src.indexOf("'", this.i + 1);
    if (end === -1) throw new UnparsableCommand();
    this.add(this.src.slice(this.i + 1, end));
    this.i = end + 1;
  }

  private doubleQuoted(): void {
    this.inWord = true;
    this.i++;
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) throw new UnparsableCommand();
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === "\\") {
        const next = this.src[this.i + 1];
        if (next === undefined) throw new UnparsableCommand();
        if (next !== "\n") this.add('$`"\\'.includes(next) ? next : "\\" + next);
        this.i += 2;
      } else if (c === "$" && this.src[this.i + 1] === "(") {
        this.dynamic = true;
        const end = skipBalanced(this.src, this.i + 2);
        this.add(this.src.slice(this.i, end));
        this.i = end;
      } else if (c === "`") {
        this.dynamic = true;
        const end = this.src.indexOf("`", this.i + 1);
        if (end === -1) throw new UnparsableCommand();
        this.add(this.src.slice(this.i, end + 1));
        this.i = end + 1;
      } else {
        if (c === "$") this.dynamic = true;
        this.add(c);
        this.i++;
      }
    }
  }

  /**
   * A backtick opens a substitution, or closes the innermost one it opened. Like `$(`, the opening leaves a
   * dynamic word behind, so a flag value made by a substitution never looks empty.
   */
  private backtick(): void {
    if (this.open.at(-1) === "`") {
      this.open.pop();
    } else {
      this.open.push("`");
      this.inWord = true;
      this.dynamic = true;
    }
    this.endCommand();
    this.i++;
  }

  private dollar(): void {
    const next = this.src[this.i + 1];
    this.dynamic = true;
    if (next === "(") {
      this.inWord = true;
      this.openGroup(2);
      return;
    }
    if (next === "{") {
      const end = this.src.indexOf("}", this.i + 2);
      if (end === -1) throw new UnparsableCommand();
      this.add(this.src.slice(this.i, end + 1));
      this.i = end + 1;
      return;
    }
    this.add("$");
    this.i++;
  }

  private openGroup(width: number): void {
    this.endCommand();
    this.open.push(")");
    this.i += width;
  }

  private closeGroup(closer: string): void {
    if (this.open.at(-1) !== closer) throw new UnparsableCommand();
    this.open.pop();
    this.endCommand();
    this.i++;
  }

  private comment(): void {
    const end = this.src.indexOf("\n", this.i);
    this.i = end === -1 ? this.src.length : end;
  }

  private newline(): void {
    this.endCommand();
    this.i++;
    for (const heredoc of this.heredocs.splice(0)) this.body(heredoc);
  }

  private redirect(c: string): void {
    this.endWord();
    const src = this.src;
    if (c === "<" && src[this.i + 1] === "<" && src[this.i + 2] !== "<") return this.heredoc();
    if (src[this.i + 1] === "(") {
      this.openGroup(2);
      return;
    }
    this.i++;
    while (src[this.i] === c || src[this.i] === "&" || src[this.i] === "|") this.i++;
  }

  private heredoc(): void {
    this.i += 2;
    const stripTabs = this.src[this.i] === "-";
    if (stripTabs) this.i++;
    while (this.src[this.i] === " " || this.src[this.i] === "\t") this.i++;
    let delimiter = "";
    let quoted = false;
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined || WORD_END.has(c)) break;
      if (c === "'" || c === '"') {
        const end = this.src.indexOf(c, this.i + 1);
        if (end === -1) throw new UnparsableCommand();
        delimiter += this.src.slice(this.i + 1, end);
        quoted = true;
        this.i = end + 1;
      } else if (c === "\\") {
        quoted = true;
        delimiter += this.src[this.i + 1] ?? "";
        this.i += 2;
      } else {
        delimiter += c;
        this.i++;
      }
    }
    if (!delimiter) throw new UnparsableCommand();
    this.heredocs.push({ delimiter, quoted, stripTabs });
  }

  /** Read a heredoc body up to its delimiter line. Only an unquoted body is expanded, so only that one counts. */
  private body(heredoc: Heredoc): void {
    let text = "";
    for (;;) {
      if (this.i >= this.src.length) throw new UnparsableCommand();
      const end = this.src.indexOf("\n", this.i);
      const stop = end === -1 ? this.src.length : end;
      let line = this.src.slice(this.i, stop);
      this.i = end === -1 ? stop : stop + 1;
      if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
      if (line === heredoc.delimiter) break;
      text += line + "\n";
    }
    if (!heredoc.quoted) this.groups.push([{ text, dynamic: true }]);
  }
}

/** Index right after the `)` that closes a `$(` whose content starts at `start`; quotes inside count. */
function skipBalanced(src: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) return i + 1;
    i++;
  }
  throw new UnparsableCommand();
}

/** Subcommands of `command`, each a list of words. Throws `UnparsableCommand` on unbalanced input. */
export function splitCommand(command: string): Word[][] {
  return new Lexer(command).run();
}
