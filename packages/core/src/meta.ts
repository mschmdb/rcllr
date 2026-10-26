/**
 * Frontmatter is the single source for INDEX.md and the README file tables.
 *
 * migrate   add or complete frontmatter on notes
 * generate  rewrite the index tables and each topic README's file table
 * report    list notes without date, stale active notes and missing key facts
 *
 * Port of meta.py.
 */

import type { Config } from "./config.ts";
import { openNotes } from "./extras/common.ts";
import { gitLastDate, isSource, isTopicReadme, iterNoteFiles, skillDirs, writeGenerated } from "./files.ts";
import { type Data, dumpFrontmatter, parseFrontmatter, shorten, textOr } from "./frontmatter.ts";
import { getLocale } from "./locale.ts";
import { text as say } from "./messages.ts";
import { compare, count, rstrip, sorted, str, strip } from "./py.ts";
import { PyDate } from "./pydate.ts";
import { isDir, isFile, isRelativeTo, isSymlink, join, listdir, parent } from "./pyos.ts";
import { effectiveScope, readRaw } from "./scopes.ts";
import { Sensitivity } from "./sensitive.ts";
import { dropSection, replaceTable, type Row, scrapeRows, sectionBounds, table } from "./tables.ts";

/** Text of a file rcllr only reads; missing, symlinked or unreadable files count as empty. */
export function readText(path: string): string {
  return readRaw(path) ?? "";
}

export function topicDirs(config: Config): string[] {
  const base = join(config.root, config.layout.topics);
  if (!isDir(base)) return [];
  const skills = skillDirs(config);
  if (isSymlink(base)) return [];
  return sorted(listdir(base).filter((entry) => {
    const path = join(base, entry);
    const readme = join(path, config.layout.topicReadme);
    return isDir(path) && !isSymlink(path) && isFile(readme) && !isSymlink(readme)
      && !skills.has(config.layout.topics + "/" + entry + "/");
  }));
}

/** Key fact and aliases from an existing table row, for notes written before frontmatter. */
function seed(config: Config, rel: string, indexRows: ReadonlyMap<string, Row>,
              cache: Map<string, Map<string, Row>>): Row | undefined {
  if (isTopicReadme(rel, config.layout)) return indexRows.get(config.layout.topics + "/" + rel.split("/")[1] + "/");
  let folder = parent(join(config.root, rel));
  while (isRelativeTo(folder, config.root) && folder !== config.root) {
    const key = join(folder, config.layout.topicReadme);
    if (!cache.has(key)) cache.set(key, scrapeRows(readText(key)));
    const row = cache.get(key)!.get(rel);
    if (row !== undefined) return row;
    folder = parent(folder);
  }
  return indexRows.get(rel);
}

export function migrate(config: Config, dryRun = false, only: readonly string[] | null = null): string[] {
  const fm = config.frontmatter;
  const hint = getLocale(config.ui.locale).archiveHint;
  const indexRows = scrapeRows(readText(join(config.root, config.layout.index)));
  const cache = new Map<string, Map<string, Row>>();
  const changed: string[] = [];
  const sensitivity = Sensitivity.load(config);
  for (const rel of iterNoteFiles(config)) {
    if ((only && only.length > 0 && !only.includes(rel)) || isSource(rel, config.layout)) continue;
    const path = join(config.root, rel);
    const raw = readRaw(path);
    if (raw === null) continue; // unreadable: never rewrite what we could not read
    const text = raw;
    const parsed = parseFrontmatter(text);
    const data = parsed.data;
    let body = parsed.body;
    if (!parsed.present) body = "\n" + text;
    if (!truthy(data.get(fm.updated))) {
      data.set(fm.updated, gitLastDate(config.root, rel) || PyDate.today().isoformat());
    }
    if (!truthy(data.get(fm.status))) {
      data.set(fm.status, rel.toLowerCase().includes(hint) ? config.status.archived : config.status.active);
    }
    if (!truthy(data.get(fm.keyFact))) {
      const found = seed(config, rel, indexRows, cache);
      data.set(fm.keyFact, found && found.description ? found.description : fm.todoPlaceholder);
      if (!data.has(fm.aliases) && found) data.set(fm.aliases, [...found.aliases]);
    }
    if (!truthy(data.get(fm.summary))) data.set(fm.summary, shorten(str(data.get(fm.keyFact)), fm.summaryMax));
    for (const key of fm.listKeys) {
      const value = data.get(key) ?? [];
      data.set(key, Array.isArray(value) ? value : value ? [value] : []);
    }
    const ordered: Data = new Map([...data].filter(([key]) => !fm.fieldOrder.includes(key)));
    for (const key of fm.fieldOrder) ordered.set(key, data.get(key)!);
    const updated = dumpFrontmatter(ordered) + body;
    // Frontmatter the parser cannot keep (a block scalar, say) may hold the marker: never unhide a note.
    if (sensitivity.hasMarker(text) && !sensitivity.hasMarker(updated)) continue;
    if (updated !== text) {
      changed.push(rel);
      if (!dryRun) writeGenerated(path, updated);
    }
  }
  return changed;
}

function truthy(value: string | string[] | undefined): boolean {
  return value !== undefined && value.length > 0;
}

export interface Entry {
  readonly rel: string;
  readonly updated: string;
  readonly status: string;
  readonly keyFact: string;
  readonly summary: string;
  readonly aliases: string;
}

export function entry(config: Config, rel: string): Entry {
  const fm = config.frontmatter;
  const data = parseFrontmatter(readText(join(config.root, rel))).data;
  const aliases = data.get(fm.aliases);
  const aliasList = !truthy(aliases) ? [] : Array.isArray(aliases) ? aliases : [aliases!];
  const keyFact = textOr(data.get(fm.keyFact), fm.todoPlaceholder);
  return {
    rel, updated: textOr(data.get(fm.updated)), status: textOr(data.get(fm.status), config.status.active),
    keyFact, summary: textOr(data.get(fm.summary), keyFact), aliases: aliasList.join(", "),
  };
}

/** Newest `updated` first; ties by path. Two stable sorts, like the Python release. */
export function newestFirst(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) => compare(a.rel, b.rel)).sort((a, b) => compare(b.updated, a.updated));
}

/** The folders under topics/ that hold a README, the topic folders and any sub-folder with its own. */
function readmeFolders(config: Config, notes: readonly string[]): Set<string> {
  const suffix = "/" + config.layout.topicReadme;
  return new Set(notes.filter((rel) => rel.startsWith(config.layout.topics + "/") && rel.endsWith(suffix))
    .map((rel) => rel.slice(0, -suffix.length)));
}

/** The nearest README folder above a file; a README belongs to the folder above its own. */
function owner(config: Config, rel: string, folders: ReadonlySet<string>): string {
  let folder = rel.slice(0, rel.lastIndexOf("/"));
  if (rel.endsWith("/" + config.layout.topicReadme)) folder = folder.slice(0, folder.lastIndexOf("/"));
  while (folder.includes("/") && !folders.has(folder)) folder = folder.slice(0, folder.lastIndexOf("/"));
  return folder;
}

/** Sub-folders of a topic with their own README, relative to topics/ like "topic/reports". */
function subTopicDirs(config: Config, notes: readonly string[]): string[] {
  const base = config.layout.topics + "/";
  return sorted([...readmeFolders(config, notes)].filter((folder) => count(folder, "/") >= 2)
    .map((folder) => folder.slice(base.length)));
}

/** `topic` is a topic folder or a sub-folder with its own README, relative to topics/. */
export function renderReadme(config: Config, topic: string, text: string, notes: readonly string[],
                             sensitivity: Sensitivity): string {
  const locale = getLocale(config.ui.locale);
  const prefix = config.layout.topics + "/" + topic + "/";
  const readme = prefix + config.layout.topicReadme;
  const folders = readmeFolders(config, notes);
  // A protected topic may list its own files. In an open topic every individually
  // sensitive file stays out, so a glance at the README reveals nothing.
  const isProtected = sensitivity.isSensitive(readme);
  // The README is readable in its own scope only; listing other scopes there would leak them.
  const scope = effectiveScope(config, readme);
  const entries = notes.filter((rel) => rel.startsWith(prefix) && rel !== readme
    && owner(config, rel, folders) === prefix.slice(0, -1)
    && (isProtected || !sensitivity.isSensitive(rel)) && effectiveScope(config, rel) === scope)
    .map((rel) => entry(config, rel));
  const rows = newestFirst(entries).map((item) => ["`" + item.rel + "`", item.keyFact, item.aliases]);
  const filesTable = table(locale.fileColumns, rows);
  const lines = dropSection(text.split("\n"), locale.stubHeading);
  if (sectionBounds(lines, locale.filesHeading) !== null) {
    // Swap only the table; prose inside the block is knowledge and stays.
    replaceTable(lines, locale.filesHeading, filesTable);
  } else {
    while (lines.length > 0 && !strip(lines[lines.length - 1]!)) lines.pop();
    lines.push("", locale.filesHeading, "", ...filesTable);
  }
  return rstrip(lines.join("\n"), "\n") + "\n";
}

export function renderIndex(config: Config, text: string, notes: readonly string[], sensitivity: Sensitivity): string {
  const locale = getLocale(config.ui.locale);
  const layout = config.layout;
  const topics: Entry[] = [];
  for (const name of topicDirs(config)) {
    const rel = layout.topics + "/" + name + "/" + layout.topicReadme;
    if (!sensitivity.isSensitive(rel)) topics.push(entry(config, rel));
  }
  const topicRows: string[][] = [];
  for (const item of newestFirst(topics)) {
    const status = item.status === config.status.active ? "" : "[" + item.status + "] ";
    topicRows.push(["`" + item.rel.slice(0, item.rel.lastIndexOf("/")) + "/`", status + item.summary, item.aliases]);
  }
  const lines = text.split("\n");
  replaceTable(lines, locale.indexTopics, table(locale.topicColumns, topicRows));
  const flat: [string, string][] = [[layout.notes, locale.indexNotes], [layout.bookmarks, locale.indexBookmarks]];
  for (const [base, heading] of flat) {
    const items = notes.filter((rel) => rel.split("/")[0] === base && count(rel, "/") === 1
      && !sensitivity.isSensitive(rel)).map((rel) => entry(config, rel));
    const rows = newestFirst(items).map((item) => ["`" + item.rel + "`", item.summary, item.aliases]);
    replaceTable(lines, heading, table(locale.fileColumns, rows));
  }
  return rstrip(lines.join("\n"), "\n") + "\n";
}

export function generate(config: Config, dryRun = false): string[] {
  const changed: string[] = [];
  const notes = iterNoteFiles(config);
  const sensitivity = Sensitivity.load(config);

  const put = (rel: string, current: string, fresh: string): void => {
    if (current !== fresh) {
      changed.push(rel);
      if (!dryRun) writeGenerated(join(config.root, rel), fresh);
    }
  };

  for (const name of [...topicDirs(config), ...subTopicDirs(config, notes)]) {
    const rel = config.layout.topics + "/" + name + "/" + config.layout.topicReadme;
    if (isSource(rel, config.layout)) continue; // originals under sources/ stay byte for byte
    const text = readRaw(join(config.root, rel));
    if (text !== null) put(rel, text, renderReadme(config, name, text, notes, sensitivity)); // unreadable or symlinked READMEs stay untouched
  }
  const index = readRaw(join(config.root, config.layout.index));
  if (index !== null) put(config.layout.index, index, renderIndex(config, index, notes, sensitivity));
  return changed;
}

/** Rewrite the sensitive-paths file if it is stale (never through a symlink). Returns true if written. */
export function refreshPathsFile(config: Config): boolean {
  const pathsFile = join(config.root, config.sensitive.pathsFile);
  const fresh = Sensitivity.generate(config);
  return readRaw(pathsFile) !== fresh && writeGenerated(pathsFile, fresh, 0o600);
}

function isoDate(value: string): PyDate | null {
  try {
    return PyDate.fromIso(value);
  } catch {
    return null;
  }
}

interface Findings {
  days: number;
  missing: string[];
  stale: [string, string][];
  todo: string[];
  skipped: number;
}

function findings(config: Config, maxAge: number | null, scope: string | null): Findings {
  const days = maxAge === null ? config.limits.staleAfterDays : maxAge;
  const limit = PyDate.today().addDays(-days);
  const notes = openNotes(config, scope);
  const found: Findings = { days, missing: [], stale: [], todo: [], skipped: notes.sensitiveFiles };
  for (const rel of notes.files) {
    const item = entry(config, rel);
    const updated = isoDate(item.updated);
    if (updated === null) found.missing.push(rel);
    else if (item.status === config.status.active && updated.compare(limit) < 0) found.stale.push([rel, item.updated]);
    if (item.keyFact === config.frontmatter.todoPlaceholder) found.todo.push(rel);
  }
  return found;
}

export function report(config: Config, maxAge: number | null = null, scope: string | null = null): string {
  const fm = config.frontmatter;
  const { days, missing, stale, todo, skipped } = findings(config, maxAge, scope);
  const out = [say("report_missing", "plain", { key: fm.updated, count: missing.length })];
  out.push(...missing.map((rel) => "- `" + rel + "`"), "");
  out.push(say("report_stale", "plain", { status: config.status.active, days, count: stale.length }));
  out.push(...stale.map(([rel, date]) => say("report_stale_item", "plain", { path: rel, key: fm.updated, date })), "");
  out.push(say("report_todo", "plain", { todo: fm.todoPlaceholder, count: todo.length }));
  out.push(...todo.map((rel) => "- `" + rel + "`"), "");
  out.push(say("report_sensitive", "plain", { count: skipped }));
  return out.join("\n");
}

/** One line for the pre-commit hook, or "" without findings. `meta report` keeps the full list. */
export interface ReportCounts {
  readonly stale: number;
  readonly missing: number;
  readonly todo: number;
}

export function reportCounts(config: Config): ReportCounts {
  const { missing, stale, todo } = findings(config, null, null);
  return { stale: stale.length, missing: missing.length, todo: todo.length };
}

/** One line for the pre-commit hook, or "" without findings. */
export function reportSummary(config: Config, counts: ReportCounts = reportCounts(config)): string {
  if (counts.missing === 0 && counts.stale === 0 && counts.todo === 0) return "";
  return say("report_summary", "plain", { ...counts });
}
