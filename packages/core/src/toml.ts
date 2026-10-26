/**
 * TOML 1.0 reader for rcllr.toml. Node has no TOML parser, and rcllr has no dependencies.
 * Strict 1.0: TOML 1.1 additions (`\e` and `\xHH` escapes, times without seconds, newlines and
 * trailing commas in inline tables, Unicode bare keys) are syntax errors.
 * Floats come back as TomlFloat and date-times as TomlDateTime, so the config check can tell
 * `1` from `1.0` the way Python's tomllib does.
 */

import { dateTimeProblem } from "./tomldate.ts";

export class TomlError extends Error {}

export class TomlFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export class TomlDateTime {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export type TomlValue = string | number | boolean | TomlFloat | TomlDateTime | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?/;

/** Tables defined by a header or by a dotted key are closed for later headers of the same name. */
interface Meta {
  defined: Set<TomlTable>;
  implicit: Set<TomlTable>;
  inline: Set<object>;
  arrays: Set<TomlValue[]>;
  dotted: Set<TomlTable>;
}

export function parseToml(source: string): TomlTable {
  return new Parser(source).document();
}

class Parser {
  private readonly text: string;
  private pos = 0;
  private readonly root: TomlTable = newTable();
  private readonly meta: Meta = {
    defined: new Set(), implicit: new Set(), inline: new Set(), arrays: new Set(), dotted: new Set(),
  };

  constructor(text: string) {
    this.text = text;
  }

  private fail(message: string): never {
    const before = this.text.slice(0, this.pos);
    const line = before.split("\n").length;
    const column = this.pos - before.lastIndexOf("\n");
    throw new TomlError(message + " (at line " + line + ", column " + column + ")");
  }

  private peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }

  private eof(): boolean {
    return this.pos >= this.text.length;
  }

  private skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (!this.eof() && this.peek() !== "\n") {
      const code = this.text.charCodeAt(this.pos);
      if ((code < 0x20 && code !== 0x09 && !(code === 0x0d && this.peek(1) === "\n")) || code === 0x7f) {
        this.fail("Illegal character in comment");
      }
      this.pos++;
    }
  }

  private endOfLine(): void {
    this.skipSpaces();
    this.skipComment();
    if (this.eof()) return;
    if (this.peek() === "\n") {
      this.pos++;
      return;
    }
    if (this.peek() === "\r" && this.peek(1) === "\n") {
      this.pos += 2;
      return;
    }
    this.fail("Expected newline or end of document after a statement");
  }

  document(): TomlTable {
    let current = this.root;
    while (!this.eof()) {
      this.skipSpaces();
      const char = this.peek();
      if (char === "\n" || char === "#" || (char === "\r" && this.peek(1) === "\n") || this.eof()) {
        this.endOfLine();
        continue;
      }
      if (char === "[") {
        current = this.peek(1) === "[" ? this.arrayTableHeader() : this.tableHeader();
      } else {
        this.keyValue(current);
      }
      this.endOfLine();
    }
    return this.root;
  }

  private key(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipSpaces();
      const char = this.peek();
      if (char === '"') keys.push(this.basicString(false));
      else if (char === "'") keys.push(this.literalString(false));
      else {
        const start = this.pos;
        while (BARE_KEY.test(this.peek())) this.pos++;
        if (this.pos === start) this.fail("Invalid initial character for a key part");
        keys.push(this.text.slice(start, this.pos));
      }
      this.skipSpaces();
      if (this.peek() !== ".") return keys;
      this.pos++;
    }
  }

  private tableHeader(): TomlTable {
    this.pos++;
    const keys = this.key();
    if (this.peek() !== "]") this.fail("Expected ']' at the end of a table declaration");
    this.pos++;
    let table = this.root;
    keys.forEach((key, index) => {
      const last = index === keys.length - 1;
      const existing = table[key];
      if (existing === undefined) {
        const created = newTable();
        table[key] = created;
        if (!last) this.meta.implicit.add(created);
        table = created;
        return;
      }
      if (Array.isArray(existing) && this.meta.arrays.has(existing) && !last) {
        table = existing[existing.length - 1] as TomlTable;
        return;
      }
      if (!isTable(existing) || this.meta.inline.has(existing)) this.fail("Cannot declare " + keys.join(".") + " twice");
      if (last) {
        if (this.meta.defined.has(existing) || this.meta.dotted.has(existing)) this.fail("Cannot declare " + keys.join(".") + " twice");
      }
      table = existing;
    });
    this.meta.defined.add(table);
    this.meta.implicit.delete(table);
    return table;
  }

  private arrayTableHeader(): TomlTable {
    this.pos += 2;
    const keys = this.key();
    if (this.peek() !== "]" || this.peek(1) !== "]") this.fail("Expected ']]' at the end of an array declaration");
    this.pos += 2;
    let table = this.root;
    keys.forEach((key, index) => {
      const last = index === keys.length - 1;
      const existing = table[key];
      if (last) {
        if (existing === undefined) {
          const list: TomlValue[] = [];
          table[key] = list;
          this.meta.arrays.add(list);
        } else if (!Array.isArray(existing) || !this.meta.arrays.has(existing)) {
          this.fail("Cannot declare " + keys.join(".") + " twice");
        }
        const list = table[key] as TomlValue[];
        const created = newTable();
        list.push(created);
        table = created;
        return;
      }
      if (existing === undefined) {
        const created = newTable();
        table[key] = created;
        this.meta.implicit.add(created);
        table = created;
      } else if (Array.isArray(existing) && this.meta.arrays.has(existing)) {
        table = existing[existing.length - 1] as TomlTable;
      } else if (isTable(existing) && !this.meta.inline.has(existing)) {
        table = existing;
      } else {
        this.fail("Cannot declare " + keys.join(".") + " twice");
      }
    });
    return table;
  }

  private keyValue(table: TomlTable): void {
    const keys = this.key();
    if (this.peek() !== "=") this.fail("Expected '=' after a key in a key/value pair");
    this.pos++;
    this.skipSpaces();
    const value = this.value();
    let target = table;
    for (const key of keys.slice(0, -1)) {
      const existing = target[key];
      if (existing === undefined) {
        const created = newTable();
        target[key] = created;
        this.meta.dotted.add(created);
        target = created;
      } else if (isTable(existing) && !this.meta.inline.has(existing) && !this.meta.defined.has(existing)) {
        // An implicit table extended by a dotted key counts as defined by it: a later [header] may not reopen it.
        this.meta.dotted.add(existing);
        target = existing;
      } else {
        this.fail("Cannot overwrite a value");
      }
    }
    const last = keys[keys.length - 1]!;
    if (last in target) this.fail("Cannot overwrite a value");
    target[last] = value;
  }

  private value(): TomlValue {
    const char = this.peek();
    if (char === '"') return this.peek(1) === '"' && this.peek(2) === '"' ? this.multilineBasic() : this.basicString(true);
    if (char === "'") return this.peek(1) === "'" && this.peek(2) === "'" ? this.multilineLiteral() : this.literalString(true);
    if (char === "[") return this.array();
    if (char === "{") return this.inlineTable();
    if (this.text.startsWith("true", this.pos) && !BARE_KEY.test(this.peek(4))) {
      this.pos += 4;
      return true;
    }
    if (this.text.startsWith("false", this.pos) && !BARE_KEY.test(this.peek(5))) {
      this.pos += 5;
      return false;
    }
    const rest = this.text.slice(this.pos);
    const dateTime = DATE_TIME.exec(rest);
    if (dateTime) {
      const problem = dateTimeProblem(dateTime[0]);
      if (problem) this.fail(problem);
      this.pos += dateTime[0].length;
      return new TomlDateTime(dateTime[0]);
    }
    return this.number(rest);
  }

  private number(rest: string): TomlValue {
    const special = /^[+-]?(?:inf|nan)(?![A-Za-z0-9_])/.exec(rest);
    if (special) {
      this.pos += special[0].length;
      const negative = special[0].startsWith("-");
      return new TomlFloat(special[0].endsWith("inf") ? (negative ? -Infinity : Infinity) : NaN);
    }
    const radix = /^0(x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)(?![A-Za-z0-9_.])/.exec(rest);
    if (radix) {
      this.pos += radix[0].length;
      return this.integer(Number(radix[0].replace(/_/g, "")));
    }
    const decimal = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?(?![A-Za-z0-9_.:-])/.exec(rest);
    if (!decimal) this.fail("Invalid value");
    this.pos += decimal[0].length;
    const clean = decimal[0].replace(/_/g, "");
    return /[.eE]/.test(clean) ? new TomlFloat(Number(clean)) : this.integer(Number(clean));
  }

  /** JavaScript numbers hold integers exactly only up to 2^53; larger ones are refused, not rounded. */
  private integer(value: number): number {
    if (!Number.isSafeInteger(value)) this.fail("Integer out of range");
    return value;
  }

  private escape(): string {
    const char = this.peek();
    this.pos++;
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (char in simple) return simple[char]!;
    if (char === "u" || char === "U") {
      const size = char === "u" ? 4 : 8;
      const hex = this.text.slice(this.pos, this.pos + size);
      if (!new RegExp("^[0-9A-Fa-f]{" + size + "}$").test(hex)) this.fail("Invalid hex value");
      const code = parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail("Escaped character is not a Unicode scalar value");
      this.pos += size;
      return String.fromCodePoint(code);
    }
    this.pos--;
    return this.fail("Unescaped '\\' in a string");
  }

  private checkChar(multiline: boolean): void {
    const code = this.text.charCodeAt(this.pos);
    if (code === 0x09) return;
    if (multiline && (code === 0x0a || (code === 0x0d && this.peek(1) === "\n"))) return;
    if (code < 0x20 || code === 0x7f) this.fail("Illegal character in string");
  }

  private basicString(allowNewline: boolean): string {
    void allowNewline;
    this.pos++;
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("Unterminated string");
      const char = this.peek();
      if (char === '"') {
        this.pos++;
        return out;
      }
      if (char === "\\") {
        this.pos++;
        out += this.escape();
        continue;
      }
      this.checkChar(false);
      out += char;
      this.pos++;
    }
  }

  private literalString(allowNewline: boolean): string {
    void allowNewline;
    this.pos++;
    const start = this.pos;
    for (;;) {
      if (this.eof()) this.fail("Unterminated string");
      if (this.peek() === "'") {
        const value = this.text.slice(start, this.pos);
        this.pos++;
        return value;
      }
      this.checkChar(false);
      this.pos++;
    }
  }

  private skipFirstNewline(): void {
    if (this.peek() === "\n") this.pos++;
    else if (this.peek() === "\r" && this.peek(1) === "\n") this.pos += 2;
  }

  private multilineBasic(): string {
    this.pos += 3;
    this.skipFirstNewline();
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("Unterminated string");
      if (this.text.startsWith('"""', this.pos)) {
        let quotes = 3;
        while (this.peek(quotes) === '"' && quotes < 5) quotes++;
        out += '"'.repeat(quotes - 3);
        this.pos += quotes;
        return out;
      }
      const char = this.peek();
      if (char === "\\") {
        const after = /^\\[ \t]*\r?\n/.exec(this.text.slice(this.pos));
        if (after) {
          this.pos += after[0].length;
          while (/[ \t\n]/.test(this.peek()) || (this.peek() === "\r" && this.peek(1) === "\n")) this.pos++;
          continue;
        }
        this.pos++;
        out += this.escape();
        continue;
      }
      this.checkChar(true);
      if (char === "\r") {
        out += "\n";
        this.pos += 2;
        continue;
      }
      out += char;
      this.pos++;
    }
  }

  private multilineLiteral(): string {
    this.pos += 3;
    this.skipFirstNewline();
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("Unterminated string");
      if (this.text.startsWith("'''", this.pos)) {
        let quotes = 3;
        while (this.peek(quotes) === "'" && quotes < 5) quotes++;
        out += "'".repeat(quotes - 3);
        this.pos += quotes;
        return out;
      }
      this.checkChar(true);
      if (this.peek() === "\r") {
        out += "\n";
        this.pos += 2;
        continue;
      }
      out += this.peek();
      this.pos++;
    }
  }

  private skipArraySpace(): void {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (this.peek() === "\n") this.pos++;
      else if (this.peek() === "\r" && this.peek(1) === "\n") this.pos += 2;
      else return;
    }
  }

  private array(): TomlValue[] {
    this.pos++;
    const items: TomlValue[] = [];
    for (;;) {
      this.skipArraySpace();
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      if (this.eof()) this.fail("Unclosed array");
      items.push(this.value());
      this.skipArraySpace();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      this.fail("Unclosed array");
    }
  }

  private inlineTable(): TomlTable {
    this.pos++;
    const table = newTable();
    this.meta.inline.add(table);
    this.skipSpaces();
    if (this.peek() === "}") {
      this.pos++;
      return table;
    }
    for (;;) {
      this.keyValue(table);
      this.skipSpaces();
      if (this.peek() === "}") {
        this.pos++;
        this.freeze(table);
        return table;
      }
      if (this.peek() !== ",") this.fail("Unclosed inline table");
      this.pos++;
      this.skipSpaces();
    }
  }

  private freeze(table: TomlTable): void {
    for (const value of Object.values(table)) {
      if (isTable(value)) {
        this.meta.inline.add(value);
        this.freeze(value);
      }
    }
  }
}

/** Tables without a prototype, so keys like `constructor` are plain keys. */
function newTable(): TomlTable {
  return Object.create(null) as TomlTable;
}

/** The inside of a TOML basic string for `value`: backslashes, quotes and control characters escaped. */
export function tomlEscape(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\" || char === '"') out += "\\" + char;
    else if (code < 0x20 || code === 0x7f) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += char;
  }
  return out;
}

export function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && !(value instanceof TomlFloat) && !(value instanceof TomlDateTime);
}
