/**
 * A small argument parser: subcommands, options before and after the subcommand, unique prefixes,
 * `--opt=value` and negative numbers as values. Usage errors exit with code 2; help.ts lays out --help.
 */

import { message as say } from "@rcllr/core";

import { fill, type Group, type HelpCommand, type Page, render, usage, WIDTH } from "./help.ts";

export type Namespace = Record<string, unknown>;

export class UsageError extends Error {
  readonly parser: Parser;
  constructor(parser: Parser, message: string) {
    super(message);
    this.parser = parser;
  }
}

/** --help or --version was given; the text is ready to print. */
export class HelpRequested extends Error {
  readonly text: string;
  constructor(text: string) {
    super("help");
    this.text = text;
  }
}

type Kind = "value" | "flag" | "append";

interface Option {
  readonly flags: readonly string[];
  readonly dest: string;
  readonly kind: Kind;
  readonly help: string;
  readonly group: Group;
  readonly metavar?: string;
  readonly type?: "int";
  readonly choices?: readonly string[];
  readonly required?: boolean;
  /** Said after "missing <option>", so the error tells what to pass. */
  readonly missingHint?: string;
  readonly default?: unknown;
  /** Leave the destination unset when the option is absent. */
  readonly suppress?: boolean;
}

interface Positional {
  readonly dest: string;
  readonly help: string;
  readonly nargs?: "?" | "*";
  readonly choices?: readonly string[];
}

export interface OptionSpec {
  dest?: string;
  kind?: Kind;
  help: string;
  /** The help section; default: the command's own "options". */
  group?: Group;
  metavar?: string;
  type?: "int";
  choices?: readonly string[];
  required?: boolean;
  missingHint?: string;
  default?: unknown;
  suppress?: boolean;
}

/** What --help says about a command besides its options. */
export interface CommandInfo {
  purpose: string;
  examples?: string;
  notes?: string;
  /** The heading the top-level help lists the command under. */
  group?: string;
  /** What --version prints; only the top level sets it. */
  version?: string;
}

function camel(flag: string): string {
  return flag.replace(/^-+/, "").replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function isNegativeNumber(value: string): boolean {
  return /^-\d+$|^-\d*\.\d+$/.test(value);
}

function usageText(key: string, params: Record<string, unknown>): string {
  return say(key, "plain", params);
}

function label(option: Option): string {
  return option.flags.join("/");
}

export class Parser {
  readonly prog: string;
  readonly info: CommandInfo;
  private readonly options: Option[] = [];
  private readonly positionals: Positional[] = [];
  private readonly commands = new Map<string, Parser>();
  private commandDest = "";

  constructor(prog: string, info: CommandInfo) {
    this.prog = prog;
    this.info = info;
  }

  option(flags: string | readonly string[], spec: OptionSpec): this {
    const list = typeof flags === "string" ? [flags] : flags;
    const long = list.find((flag) => flag.startsWith("--")) ?? list[0]!;
    this.options.push({ flags: list, dest: spec.dest ?? camel(long), kind: spec.kind ?? "value", group: "options", ...spec });
    return this;
  }

  positional(dest: string, help: string, extra: { nargs?: "?" | "*"; choices?: readonly string[] } = {}): this {
    this.positionals.push({ dest, help, ...extra });
    return this;
  }

  command(name: string, info: CommandInfo): Parser {
    const sub = new Parser(this.prog + " " + name, info);
    this.commands.set(name, sub);
    return sub;
  }

  /** Subcommands are required and stored under `dest`. */
  commandsDest(dest: string): void {
    this.commandDest = dest;
  }

  parse(argv: readonly string[]): Namespace {
    const namespace: Namespace = {};
    const [extras, leaf] = this.parseInto(argv, namespace);
    // Leftovers count only once every parser has had its turn; the innermost one reports them.
    if (extras.length > 0) throw new UsageError(leaf, usageText("usage_unexpected", { names: extras.join(" ") }));
    return namespace;
  }

  private defaults(namespace: Namespace): void {
    for (const option of this.options) {
      if (option.suppress) continue;
      if (!(option.dest in namespace)) {
        namespace[option.dest] = option.kind === "flag" ? false : option.kind === "append" ? [] : option.default ?? null;
      }
    }
  }

  private match(arg: string): [Option, string | null] | null {
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const exact = this.options.find((option) => option.flags.includes(flag));
    if (exact) return [exact, inline];
    if (!flag.startsWith("--")) return null;
    const candidates = this.options.filter((option) => option.flags.some((name) => name.startsWith(flag)));
    if (candidates.length > 1) {
      const names = candidates.map((option) => option.flags.find((name) => name.startsWith(flag))!).join(", ");
      throw new UsageError(this, usageText("usage_ambiguous", { name: flag, choices: names }));
    }
    return candidates.length === 1 ? [candidates[0]!, inline] : null;
  }

  private choice(name: string, choices: readonly string[], value: string): UsageError {
    return new UsageError(this, usageText("usage_choice", { name, choices: choices.join(", "), value }));
  }

  private convert(option: Option, value: string): unknown {
    if (option.type === "int") {
      if (!/^[-+]?\s*\d+\s*$/.test(value.replace(/_/g, ""))) {
        throw new UsageError(this, usageText("usage_int", { name: label(option), value }));
      }
      return Number.parseInt(value.replace(/[_\s]/g, ""), 10);
    }
    if (option.choices && !option.choices.includes(value)) throw this.choice(label(option), option.choices, value);
    return value;
  }

  /** Parse into `namespace`; return the arguments nobody recognized, in their order, and the innermost parser. */
  private parseInto(argv: readonly string[], namespace: Namespace): [string[], Parser] {
    const loose: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    let onlyPositionals = false;
    while (i < argv.length) {
      const arg = argv[i]!;
      i++;
      if (!onlyPositionals && arg === "--") {
        onlyPositionals = true;
        continue;
      }
      if (!onlyPositionals && (arg === "-h" || arg === "--help")) throw new HelpRequested(this.help());
      if (!onlyPositionals && arg === "--version" && this.info.version !== undefined) {
        throw new HelpRequested(this.info.version + "\n");
      }
      if (!onlyPositionals && arg.startsWith("-") && arg !== "-" && !isNegativeNumber(arg)) {
        const found = this.match(arg);
        if (!found) {
          loose.push(arg);
          continue;
        }
        const [option, inline] = found;
        seen.add(option.dest);
        if (option.kind === "flag") {
          if (inline !== null) throw new UsageError(this, usageText("usage_no_value", { name: label(option), value: inline }));
          namespace[option.dest] = true;
          continue;
        }
        let value = inline;
        if (value === null) {
          const next = argv[i];
          if (next === undefined || (next.startsWith("-") && next !== "-" && !isNegativeNumber(next))) {
            throw new UsageError(this, usageText("usage_needs_value", { name: label(option) }));
          }
          value = next;
          i++;
        }
        const converted = this.convert(option, value);
        if (option.kind === "append") {
          const list = Array.isArray(namespace[option.dest]) ? namespace[option.dest] as unknown[] : [];
          namespace[option.dest] = [...list, converted];
        } else {
          namespace[option.dest] = converted;
        }
        continue;
      }
      if (this.commands.size > 0) {
        const sub = this.commands.get(arg);
        if (!sub) {
          throw new UsageError(this, usageText("usage_unknown_command", { value: arg, choices: [...this.commands.keys()].join(", ") }));
        }
        this.defaults(namespace);
        namespace[this.commandDest] = arg;
        const [extras, leaf] = sub.parseInto(argv.slice(i), namespace);
        return [[...loose, ...extras], leaf];
      }
      loose.push(arg);
    }
    if (this.commands.size > 0) {
      throw new UsageError(this, usageText("usage_missing", { names: "<" + this.commandDest + ">" }));
    }
    this.defaults(namespace);
    const extras = this.assignPositionals(loose, namespace);
    const missing = this.options.filter((option) => option.required && !seen.has(option.dest));
    if (missing.length > 0) {
      const hints = missing.flatMap((option) => (option.missingHint ? [option.missingHint] : []));
      throw new UsageError(this, usageText("usage_missing", { names: missing.map(label).join(", ") })
        + (hints.length > 0 ? ". " + hints.join(" ") : ""));
    }
    return [extras, this];
  }

  /** Fill the positionals; return what is left over, in order. */
  private assignPositionals(values: string[], namespace: Namespace): string[] {
    const isFlag = (value: string): boolean => value.startsWith("-") && value !== "-" && !isNegativeNumber(value);
    const rest = values.filter((value) => !isFlag(value));
    const missing: string[] = [];
    for (const positional of this.positionals) {
      if (positional.nargs === "*") {
        namespace[positional.dest] = rest.splice(0);
      } else if (positional.nargs === "?") {
        namespace[positional.dest] = rest.length > 0 ? rest.shift()! : null;
      } else if (rest.length > 0) {
        const value = rest.shift()!;
        if (positional.choices && !positional.choices.includes(value)) {
          throw this.choice("<" + positional.dest + ">", positional.choices, value);
        }
        namespace[positional.dest] = value;
      } else {
        missing.push("<" + positional.dest + ">");
      }
    }
    if (missing.length > 0) throw new UsageError(this, usageText("usage_missing", { names: missing.join(", ") }));
    const left = [...rest];
    return values.filter((value) => {
      if (isFlag(value)) return true;
      const index = left.indexOf(value);
      if (index === -1) return false;
      left.splice(index, 1);
      return true;
    });
  }

  private page(): Page {
    const commands: HelpCommand[] = [...this.commands].map(([name, sub]) => ({
      name, purpose: sub.info.purpose, group: sub.info.group ?? "",
    }));
    return {
      prog: this.prog, purpose: this.info.purpose, examples: this.info.examples ?? "", notes: this.info.notes ?? "",
      options: this.options, positionals: this.positionals, commands, version: this.info.version !== undefined,
    };
  }

  /** The help of this parser and every subcommand, as data: the site builds its command reference from it. */
  helpPages(): Page[] {
    return [this.page(), ...[...this.commands.values()].map((sub) => sub.page())];
  }

  /** The one-line usage. */
  usage(): string {
    return usage(this.page());
  }

  /** The --help text. */
  help(): string {
    return render(this.page());
  }

  /** What a usage error prints: the usage line, the error and where to find help. */
  error(message: string): string {
    const [first = "", ...rest] = fill(usageText("usage_error", { message }), WIDTH - 2);
    return [this.usage(), first, ...rest.map((line) => "  " + line), usageText("usage_hint", { prog: this.prog })]
      .join("\n") + "\n";
  }
}
