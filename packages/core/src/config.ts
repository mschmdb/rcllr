/** Load and validate rcllr.toml. Unknown keys fail, so a typo never disables a rule. */

import { ConfigError, ConfigMissing } from "./errors.ts";
import { strip } from "./py.ts";
import { asPosix, isAbsolute, isFile, isSymlink, join, parents, parts, readBytesText, resolve,
  stripTrailingSlashes, windowsUnsafe } from "./pyos.ts";
import { validateMemorySources } from "./config-memory.ts";
import { isTable, parseToml, TomlDateTime, TomlError, TomlFloat } from "./toml.ts";

export const CONFIG_NAME = "rcllr.toml";
/** The name before the rename to rcllr. Brains that still use it keep working. */
export const LEGACY_CONFIG_NAME = "dummkopf.toml";
export const SCHEMA_VERSION = 1;
export const ROOT_ENV = "RCLLR_ROOT";
export const LEGACY_ROOT_ENV = "DUMMKOPF_ROOT";
export const LOCALES = ["en", "de"] as const;
export const TONES = ["cheeky", "plain"] as const;
export const REPORT_MODES = ["changes", "always", "never"] as const;

const NAME_RE = /^[\p{L}\p{N}_.][\p{L}\p{N}_.-]*$/u;
const SCOPE_RE = /^[\p{L}\p{N}_-]+$/u;
const FRONTMATTER_KEY_RE = /^[A-Za-z0-9_.\-]+$/;

export interface RepoConfig {
  /** Empty means a local brain: rcllr commits, but never fetches or pushes. */
  readonly remote: string;
  readonly remoteName: string;
  readonly branch: string;
  readonly autoPush: boolean;
  readonly commitMessage: string;
  readonly syncExclude: readonly string[];
  /** True without a remote. Nothing leaves the machine. */
  readonly local: boolean;
}

export interface LayoutConfig {
  readonly topics: string;
  readonly topicReadme: string;
  readonly notes: string;
  readonly bookmarks: string;
  readonly archive: string;
  readonly sources: string;
  readonly index: string;
  /** Folders that hold notes; everything else in the repo is invisible to agents. */
  readonly roots: readonly [string, string, string];
  readonly flatRoots: readonly [string, string];
}

export interface ScopesConfig {
  readonly values: readonly string[];
  readonly all: string;
  readonly queryDefault: string;
  readonly mixedLabel: string;
  readonly requireOnNewTopic: boolean;
  readonly linkBarriers: readonly string[];
  /** The all-scopes keyword followed by every scope value. */
  readonly choices: readonly string[];
}

export interface StatusConfig {
  readonly active: string;
  readonly archived: string;
}

export interface SensitiveConfig {
  readonly marker: string;
  readonly pathsFile: string;
  readonly always: readonly string[];
}

export interface FrontmatterConfig {
  readonly keyFact: string;
  readonly summary: string;
  readonly aliases: string;
  readonly updated: string;
  readonly status: string;
  readonly period: string;
  readonly entities: string;
  readonly scope: string;
  readonly todoPlaceholder: string;
  readonly summaryMax: number;
  readonly mappedKeys: readonly string[];
  readonly listKeys: readonly [string, string, string];
  /** Order of the managed keys when rcllr writes frontmatter. */
  readonly fieldOrder: readonly string[];
}

export interface UiConfig {
  readonly locale: string;
  readonly tone: string;
}

export interface HooksConfig {
  /** When the pre-commit hook prints its report line: "changes", "always" or "never". */
  readonly report: string;
}

export interface LimitsConfig {
  readonly maxChars: number;
  readonly findLimit: number;
  readonly maxInputChars: number;
  readonly maxChanges: number;
  readonly lockTimeoutS: number;
  readonly gitTimeoutS: number;
  readonly staleAfterDays: number;
}

export interface SearchWeights {
  readonly title: number;
  readonly aliases: number;
  readonly keyFact: number;
  readonly path: number;
  readonly body: number;
  readonly topicReadmeBonus: number;
  /** Curator reports repeat the terms of many notes; their score counts this many percent. */
  readonly curatorReportPercent: number;
  /** Imported agent memory ranks below the user's own notes; its score counts this many percent. */
  readonly importedPercent: number;
}

export interface SearchConfig {
  readonly weights: SearchWeights;
}

export interface ContextConfig {
  readonly routesFile: string;
  /** True when rcllr.toml names the file; then `check` warns if it is missing. */
  readonly routesFileSet: boolean;
}

export interface LinksOptions {
  readonly output: string;
  readonly entitiesFile: string;
  /** True when rcllr.toml names the file; then `check` warns if it is missing. */
  readonly entitiesFileSet: boolean;
  readonly minTopics: number;
  readonly allowOutside: readonly string[];
}

export interface CuratorOptions {
  readonly openDays: number;
  readonly staleDays: number;
  readonly reportDir: string;
  /** Frontmatter key whose date hides a note from the curator until that day. */
  readonly keepKey: string;
}

export interface MemorySourceOptions {
  /** Project folders whose agent memory gets mirrored; `*` means every project. Nothing else is imported. */
  readonly projects: readonly string[];
  /** Project folders left out, also when `projects` is `*`. */
  readonly exclude: readonly string[];
  /** Scope of a note unless `scope_by_project` names its project. */
  readonly scope: string;
  /** `<project folder>=<scope>` entries, e.g. `~/Sites/blog=private`. */
  readonly scopeByProject: readonly string[];
  readonly topic: string;
}

export interface ExtrasConfig {
  readonly links: boolean;
  readonly curator: boolean;
  readonly codexSync: boolean;
  readonly claudeMemory: boolean;
  readonly codexMemory: boolean;
}

export interface Config {
  readonly root: string;
  readonly repo: RepoConfig;
  readonly layout: LayoutConfig;
  readonly scopes: ScopesConfig;
  readonly status: StatusConfig;
  readonly sensitive: SensitiveConfig;
  readonly frontmatter: FrontmatterConfig;
  readonly ui: UiConfig;
  readonly hooks: HooksConfig;
  readonly limits: LimitsConfig;
  readonly search: SearchConfig;
  readonly context: ContextConfig;
  readonly extras: ExtrasConfig;
  readonly links: LinksOptions;
  readonly curator: CuratorOptions;
  readonly claudeMemory: MemorySourceOptions;
  readonly codexMemory: MemorySourceOptions;
}

/** A leaf type and its default, or a nested section. TOML keys stay snake_case. */
type Leaf = ["str", string] | ["bool", boolean] | ["int", number] | ["list", readonly string[]];
interface Section {
  readonly [tomlKey: string]: Leaf | Section;
}

const SCHEMA: Section = {
  repo: {
    remote: ["str", ""], remote_name: ["str", "origin"], branch: ["str", "main"], auto_push: ["bool", true],
    commit_message: ["str", "Update notes"], sync_exclude: ["list", []],
  },
  layout: {
    topics: ["str", "topics"], topic_readme: ["str", "README.md"], notes: ["str", "notes"],
    bookmarks: ["str", "bookmarks"], archive: ["str", "archive"], sources: ["str", "sources"],
    index: ["str", "INDEX.md"],
  },
  scopes: {
    values: ["list", ["private", "work"]], all: ["str", "both"], query_default: ["str", "both"],
    mixed_label: ["str", "mixed"], require_on_new_topic: ["bool", true], link_barriers: ["list", ["work>private"]],
  },
  status: { active: ["str", "active"], archived: ["str", "archived"] },
  sensitive: { marker: ["str", "> SENSITIVE"], paths_file: ["str", ".sensitive-paths"], always: ["list", []] },
  frontmatter: {
    key_fact: ["str", "key_fact"], summary: ["str", "summary"], aliases: ["str", "aliases"],
    updated: ["str", "updated"], status: ["str", "status"], period: ["str", "period"],
    entities: ["str", "entities"], scope: ["str", "scope"], todo_placeholder: ["str", "TODO"],
    summary_max: ["int", 160],
  },
  ui: { locale: ["str", "en"], tone: ["str", "plain"] },
  hooks: { report: ["str", "changes"] },
  limits: {
    max_chars: ["int", 6000], find_limit: ["int", 3], max_input_chars: ["int", 2_000_000],
    max_changes: ["int", 50], lock_timeout_s: ["int", 10], git_timeout_s: ["int", 60],
    stale_after_days: ["int", 56],
  },
  search: {
    weights: {
      title: ["int", 8], aliases: ["int", 12], key_fact: ["int", 4], path: ["int", 3], body: ["int", 1],
      topic_readme_bonus: ["int", 30], curator_report_percent: ["int", 25], imported_percent: ["int", 60],
    },
  },
  context: { routes_file: ["str", "routes.json"] },
  extras: { links: ["bool", true], curator: ["bool", true], codex_sync: ["bool", true], claude_memory: ["bool", false],
    codex_memory: ["bool", false] },
  links: {
    output: ["str", "LINKS.md"], entities_file: ["str", "entities.txt"], min_topics: ["int", 2],
    allow_outside: ["list", []],
  },
  curator: {
    open_days: ["int", 28], stale_days: ["int", 56], report_dir: ["str", "topics/curator"],
    keep_key: ["str", "curator_keep"],
  },
  claude_memory: { projects: ["list", []], exclude: ["list", []], scope: ["str", "memory-claude"], scope_by_project: ["list", []],
    topic: ["str", "claude-memory"] },
  codex_memory: { projects: ["list", []], exclude: ["list", []], scope: ["str", "memory-codex"], scope_by_project: ["list", []],
    topic: ["str", "codex-memory"] },
};

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function invalid(key: string, problem: string): ConfigError {
  return new ConfigError("config_invalid", { key, problem });
}

function isLeaf(spec: Leaf | Section): spec is Leaf {
  return Array.isArray(spec);
}

function defaults(section: Section): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(section)) {
    out[camel(key)] = isLeaf(spec) ? spec[1] : defaults(spec);
  }
  return out;
}

function build(section: Section, table: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const values = defaults(section);
  for (const [key, raw] of Object.entries(table)) {
    const dotted = prefix ? prefix + "." + key : key;
    const spec = Object.hasOwn(section, key) ? section[key] : undefined;
    if (spec === undefined) throw invalid(dotted, "unknown key");
    values[camel(key)] = coerce(spec, raw, dotted);
  }
  return values;
}

function coerce(spec: Leaf | Section, raw: unknown, key: string): unknown {
  if (!isLeaf(spec)) {
    if (!isTable(raw)) throw invalid(key, "must be a table");
    return build(spec, raw, key);
  }
  switch (spec[0]) {
    case "bool":
      if (typeof raw !== "boolean") throw invalid(key, "must be true or false");
      return raw;
    case "int":
      if (typeof raw !== "number" || !Number.isInteger(raw)) throw invalid(key, "must be an integer");
      if (raw < 0) throw invalid(key, "must not be negative");
      return raw;
    case "str":
      if (typeof raw !== "string") throw invalid(key, "must be a string");
      return raw;
    case "list":
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
        throw invalid(key, "must be a list of strings");
      }
      return [...raw];
  }
}

/** Relative, normalized (no `./`, no `//`), inside the brain. Prefix matching relies on the exact form. */
function relativePath(value: string, key: string, allowDir = false, written = false): void {
  const plain = allowDir ? stripTrailingSlashes(value) : value;
  const items = parts(plain);
  if (!plain || isAbsolute(plain) || items.includes("..") || value.includes("\\") || items.length === 0
      || value.startsWith("~") || asPosix(plain) !== plain || windowsUnsafe(plain)
      || (written && (items[0] === ".git" || items[0] === CONFIG_NAME || items[0] === LEGACY_CONFIG_NAME))) {
    throw invalid(key, "must be a normalized relative path inside the brain");
  }
}

function validate(config: Config): void {
  if (!NAME_RE.test(config.repo.branch) || !NAME_RE.test(config.repo.remoteName)) {
    throw invalid("repo.branch", "must be a plain branch name");
  }
  for (const item of config.repo.syncExclude) relativePath(item, "repo.sync_exclude", true);

  const layout = config.layout;
  const named: [string, string][] = [
    ["topics", layout.topics], ["notes", layout.notes], ["bookmarks", layout.bookmarks],
    ["archive", layout.archive], ["sources", layout.sources], ["topic_readme", layout.topicReadme],
    ["index", layout.index],
  ];
  for (const [name, value] of named) {
    if (!NAME_RE.test(value) || value === "." || value === "..") {
      throw invalid("layout." + name, "must be a single file or folder name");
    }
  }
  if (new Set(layout.roots).size !== layout.roots.length) {
    throw invalid("layout", "topics, notes and bookmarks need distinct folders");
  }
  if (!layout.topicReadme.endsWith(".md")) throw invalid("layout.topic_readme", "must be a .md file");

  const scopes = config.scopes;
  if (scopes.values.length === 0) throw invalid("scopes.values", "needs at least one scope");
  if (new Set(scopes.values).size !== scopes.values.length) throw invalid("scopes.values", "must not repeat a scope");
  if (scopes.values.some((value) => !SCOPE_RE.test(value))) {
    throw invalid("scopes.values", "use letters, digits, - and _ only");
  }
  if (!SCOPE_RE.test(scopes.all) || scopes.values.includes(scopes.all)) {
    throw invalid("scopes.all", "must be a plain word that is not a scope value");
  }
  if (!scopes.choices.includes(scopes.queryDefault)) {
    throw invalid("scopes.query_default", "must be scopes.all or one of scopes.values");
  }
  if (!strip(scopes.mixedLabel)) throw invalid("scopes.mixed_label", "must not be empty");
  for (const barrier of scopes.linkBarriers) {
    const cut = barrier.indexOf(">");
    const source = cut === -1 ? barrier : barrier.slice(0, cut);
    const target = cut === -1 ? "" : barrier.slice(cut + 1);
    if (!scopes.values.includes(source) || !scopes.values.includes(target) || source === target) {
      throw invalid("scopes.link_barriers", "'" + barrier + "' must read <scope>><other scope>, "
        + "using scopes.values; set link_barriers when you rename scopes");
    }
  }

  if (!strip(config.status.active) || !strip(config.status.archived)) {
    throw invalid("status", "values must not be empty");
  }

  const sensitive = config.sensitive;
  if (!strip(sensitive.marker) || sensitive.marker.includes("\n") || sensitive.marker.includes("\r")) {
    throw invalid("sensitive.marker", "must be one non-empty line");
  }
  if (!NAME_RE.test(sensitive.pathsFile)) throw invalid("sensitive.paths_file", "must be a single file name");
  for (const item of sensitive.always) relativePath(item, "sensitive.always", true);

  const fm = config.frontmatter;
  const keys: [string, string][] = [
    ["key_fact", fm.keyFact], ["summary", fm.summary], ["aliases", fm.aliases], ["updated", fm.updated],
    ["status", fm.status], ["period", fm.period], ["entities", fm.entities], ["scope", fm.scope],
  ];
  for (const [name, value] of keys) {
    if (!FRONTMATTER_KEY_RE.test(value)) throw invalid("frontmatter." + name, "must be a plain frontmatter key");
  }
  if (new Set(fm.mappedKeys).size !== fm.mappedKeys.length) throw invalid("frontmatter", "two fields map to the same key");
  if (!strip(fm.todoPlaceholder) || fm.summaryMax < 20) throw invalid("frontmatter.summary_max", "must be at least 20");

  if (!(LOCALES as readonly string[]).includes(config.ui.locale)) {
    throw invalid("ui.locale", "must be one of " + LOCALES.join(", "));
  }
  if (!(TONES as readonly string[]).includes(config.ui.tone)) throw invalid("ui.tone", "must be one of " + TONES.join(", "));
  if (!(REPORT_MODES as readonly string[]).includes(config.hooks.report)) {
    throw invalid("hooks.report", "must be one of " + REPORT_MODES.join(", "));
  }

  const limits = config.limits;
  const lows: [string, number, number][] = [
    ["max_chars", limits.maxChars, 500], ["find_limit", limits.findLimit, 1],
    ["max_input_chars", limits.maxInputChars, 1], ["max_changes", limits.maxChanges, 1],
    ["lock_timeout_s", limits.lockTimeoutS, 1], ["git_timeout_s", limits.gitTimeoutS, 1],
    ["stale_after_days", limits.staleAfterDays, 1],
  ];
  for (const [name, value, low] of lows) {
    if (value < low) throw invalid("limits." + name, "must be at least " + low);
  }
  if (limits.maxChars > 20000) throw invalid("limits.max_chars", "must be at most 20000");
  if (limits.findLimit > 10) throw invalid("limits.find_limit", "must be at most 10");
  if (config.search.weights.curatorReportPercent > 100) {
    throw invalid("search.weights.curator_report_percent", "must be at most 100");
  }

  relativePath(config.context.routesFile, "context.routes_file");
  relativePath(config.links.output, "links.output", false, true);
  if (!config.links.output.endsWith(".md")) throw invalid("links.output", "must be a .md file");
  if ((layout.roots as readonly string[]).includes(parts(config.links.output)[0]!)) {
    throw invalid("links.output", "must lie outside the note folders, or it becomes a searchable note");
  }
  relativePath(config.links.entitiesFile, "links.entities_file");
  // Entity names land in the links map: a file among the notes could carry names from a hidden note.
  if ((layout.roots as readonly string[]).includes(parts(config.links.entitiesFile)[0]!)) {
    throw invalid("links.entities_file", "must lie outside the note folders");
  }
  // The hooks overwrite the paths file, so it must not be any other file rcllr reads or writes.
  const taken = [CONFIG_NAME, LEGACY_CONFIG_NAME, layout.index, config.links.output, config.context.routesFile,
    config.links.entitiesFile, "AGENTS.md", "CLAUDE.md"];
  if (taken.includes(sensitive.pathsFile) || sensitive.pathsFile.endsWith(".md")) {
    throw invalid("sensitive.paths_file", "must not be the config, a Markdown file or another file rcllr uses");
  }
  relativePath(config.curator.reportDir, "curator.report_dir", true, true);
  validateMemorySources(config);

  for (const folder of config.links.allowOutside) {
    relativePath(folder, "links.allow_outside", true, true);
    if ((layout.roots as readonly string[]).includes(parts(stripTrailingSlashes(folder))[0]!)) {
      throw invalid("links.allow_outside", "note folders are always allowed; list only folders outside them");
    }
  }
  if (config.links.minTopics < 1) throw invalid("links.min_topics", "must be at least 1");
}

/** Add the derived properties to the plain values from TOML and defaults. */
function assemble(root: string, values: Record<string, unknown>, data: Record<string, unknown> = {}): Config {
  const raw = values as unknown as Omit<Config, "root">;
  const set = (table: string, key: string): boolean => isTable(data[table]) && data[table][key] !== undefined;
  const repo = raw.repo as Omit<RepoConfig, "local">;
  const layout = raw.layout as Omit<LayoutConfig, "roots" | "flatRoots">;
  const scopes = raw.scopes as Omit<ScopesConfig, "choices">;
  const fm = raw.frontmatter as Omit<FrontmatterConfig, "mappedKeys" | "listKeys" | "fieldOrder">;
  return {
    ...raw,
    root,
    repo: { ...repo, local: !strip(repo.remote) },
    layout: { ...layout, roots: [layout.topics, layout.notes, layout.bookmarks], flatRoots: [layout.notes, layout.bookmarks] },
    scopes: { ...scopes, choices: [scopes.all, ...scopes.values] },
    context: { ...raw.context, routesFileSet: set("context", "routes_file") },
    links: { ...raw.links, entitiesFileSet: set("links", "entities_file") },
    frontmatter: {
      ...fm,
      mappedKeys: [fm.keyFact, fm.summary, fm.aliases, fm.updated, fm.status, fm.period, fm.entities, fm.scope],
      listKeys: [fm.aliases, fm.period, fm.entities],
      fieldOrder: [fm.updated, fm.status, fm.keyFact, fm.summary, fm.aliases, fm.period, fm.entities],
    },
  };
}

/** A config with every default, for tests and tools that have no rcllr.toml. */
export function defaultConfig(root: string, overrides: Record<string, unknown> = {}): Config {
  const config = assemble(root, build(SCHEMA, { repo: { remote: "git@example.org:me/brain.git" }, ...overrides }, ""),
                          overrides);
  validate(config);
  return config;
}

/**
 * The config file of a brain: rcllr.toml, else the old rcllr.toml. A symlink counts as present, so a
 * symlinked rcllr.toml is rejected instead of quietly falling back to the old name.
 */
export function configFile(rootPath: string): string {
  const root = resolve(rootPath);
  const legacy = join(root, LEGACY_CONFIG_NAME);
  const current = join(root, CONFIG_NAME);
  if (isFile(current) || isSymlink(current)) return current;
  return isFile(legacy) || isSymlink(legacy) ? legacy : current;
}

export function loadConfig(rootPath: string): Config {
  const root = resolve(rootPath);
  const file = configFile(root);
  if (isSymlink(file)) throw new ConfigError("config_unreadable", { detail: CONFIG_NAME + " must not be a symlink" });
  if (!isFile(file)) throw new ConfigMissing("config_missing", { start: root });
  let data: Record<string, unknown>;
  try {
    // Raw text: TOML defines its own newlines (LF or CRLF) and forbids a bare CR, so no normalising here.
    data = { ...parseToml(readBytesText(file)) };
  } catch (error) {
    if (error instanceof TomlError) throw new ConfigError("config_unreadable", { detail: error.message });
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError("config_unreadable", { detail });
  }
  const version = data.schema_version;
  delete data.schema_version;
  if (version === undefined) throw invalid("schema_version", "is required");
  // Python compares with ==, so 1.0 and true pass as version 1.
  const number = version instanceof TomlFloat ? version.value : typeof version === "boolean" ? Number(version) : version;
  if (number !== SCHEMA_VERSION) throw invalid("schema_version", "unsupported version; this rcllr reads version 1");
  const config = assemble(root, build(SCHEMA, data, ""), data);
  validate(config);
  return config;
}

export function findRoot(cwd: string, explicit: string | null, env: Record<string, string | undefined> = process.env): string {
  let candidates: string[];
  if (explicit !== null) candidates = [explicit];
  else if (env[ROOT_ENV] || env[LEGACY_ROOT_ENV]) candidates = [(env[ROOT_ENV] || env[LEGACY_ROOT_ENV])!];
  else {
    const start = resolve(cwd);
    candidates = [start, ...parents(start)];
  }
  for (const candidate of candidates) {
    if (isFile(join(candidate, CONFIG_NAME)) || isFile(join(candidate, LEGACY_CONFIG_NAME))) return resolve(candidate);
  }
  throw new ConfigMissing("config_missing", { start: asPosix(candidates[0]!) });
}

export { TomlDateTime, TomlFloat };
