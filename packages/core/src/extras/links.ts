/**
 * Links extra: which topics share a month, an entity, or a month across scope barriers.
 *
 * Read-only on notes and rebuildable at any time. Sensitive notes are left out and only counted.
 * Port of extras/links.py.
 */

import type { Config } from "../config.ts";
import { Rejected } from "../errors.ts";
import { topicOf } from "../files.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { getLocale, type Locale } from "../locale.ts";
import { BOUNDARY, DIGIT, compare, compareTuples, escapeRegExp, format, ignoreCase, len, pyInt, splitlines, strip, WS } from "../py.ts";
import { PyDate } from "../pydate.ts";
import { isDir, isFile, isRelativeTo, isSymlink, join, name, parent, parts, readText, relativeTo, resolve, suffix, writeText } from "../pyos.ts";
import { openNotes, readNote, require } from "./common.ts";

/** `\\d` of a Python str pattern. */
const D = DIGIT;
const ISO_RE = new RegExp(BOUNDARY + "(" + D + "{4})-(" + D + "{2})(?:-" + D + "{2})?" + BOUNDARY, "gu");
const MONTH_YEAR_RE = new RegExp(BOUNDARY + "(" + D + "{1,2})/(" + D + "{4})" + BOUNDARY, "gu");
// re.match with `$`: a trailing newline still matches, like Python.
const PERIOD_RE = new RegExp("^" + D + "{4}-" + D + "{2}\\n?$", "u");
export const TOP_TOPICS = 10;
export const MAX_PER_SIDE = 8;

export interface TimeLink {
  month: string;
  topic_count: number;
  topics: string[];
}

export interface EntityLink {
  entity: string;
  topic_count: number;
  topics: string[];
}

export interface Collision {
  month: string;
  /** Scope -> topics, in barrier order (left side first). */
  scopes: Map<string, string[]>;
}

export interface LinksReport {
  time_links: TimeLink[];
  entity_links: EntityLink[];
  collisions: Collision[];
  sensitive_files: number;
  sensitive_topics: number;
}

export interface Entity {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly pattern: RegExp;
}

type Counter = Map<string, number>;


function month(year: string, value: number): string {
  return year + "-" + String(value).padStart(2, "0");
}

export function monthNameRe(locale: Locale): RegExp {
  const names = Object.keys(locale.months).sort((a, b) => len(b) - len(a));
  return new RegExp(BOUNDARY + "(" + names.map(ignoreCase).join("|") + ")\\.?" + WS + "+(" + D + "{4})" + BOUNDARY, "gu");
}

function global(pattern: RegExp): RegExp {
  return pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, pattern.flags + "g");
}

export function extractMonths(text: string, locale: Locale): string[] {
  const found: string[] = [];
  if (locale.dayMonthYear) {
    for (const match of text.matchAll(global(locale.dayMonthYear))) {
      const value = pyInt(match[2]!);
      if (value >= 1 && value <= 12) found.push(month(match[3]!, value));
    }
  }
  for (const match of text.matchAll(ISO_RE)) {
    const value = pyInt(match[2]!);
    if (value >= 1 && value <= 12) found.push(month(match[1]!, value));
  }
  for (const match of text.matchAll(monthNameRe(locale))) {
    const value = locale.months[match[1]!.toLowerCase()];
    if (value === undefined) throw new Error("KeyError: " + match[1]!.toLowerCase());
    found.push(month(match[2]!, value));
  }
  for (const match of text.matchAll(MONTH_YEAR_RE)) {
    const value = pyInt(match[1]!);
    if (value >= 1 && value <= 12) found.push(month(match[2]!, value));
  }
  return found;
}

/** One entity per line: `Name|alias|alias`. Prefix `i:` matches case-insensitively. */
export function loadEntities(path: string): Entity[] {
  // Like the routes file: a symlink could read names from anywhere into the links map.
  if (isSymlink(path)) throw new Rejected("entities_symlink", { file: name(path) });
  if (!isFile(path)) return [];
  const entities: Entity[] = [];
  for (const raw of splitlines(readText(path))) {
    let line = strip(raw);
    if (!line || line.startsWith("#")) continue;
    let literal = escapeRegExp;
    if (line.startsWith("i:")) {
      literal = ignoreCase;
      line = line.slice(2);
    }
    const aliases = line.split("|").map((alias) => strip(alias)).filter((alias) => alias);
    if (aliases.length > 0) {
      const pattern = new RegExp(BOUNDARY + "(?:" + aliases.map(literal).join("|") + ")" + BOUNDARY, "gu");
      entities.push({ name: aliases[0]!, aliases, pattern });
    }
  }
  return entities;
}

export function ranked(counter: Counter, limit: number): string[] {
  return [...counter].sort((a, b) => compareTuples([-a[1], a[0]], [-b[1], b[0]])).slice(0, limit).map(([name]) => name);
}

export function topicScope(config: Config, topic: string): string | null {
  if (!topic.startsWith(config.layout.topics + "/")) return null;
  const readme = join(config.root, topic, config.layout.topicReadme);
  if (!isFile(readme)) return null;
  const value = parseFrontmatter(readText(readme, "ignore")).data.get(config.frontmatter.scope);
  return typeof value === "string" ? value : null;
}

function bump(table: Map<string, Counter>, key: string, topic: string, by: number): void {
  let counter = table.get(key);
  if (counter === undefined) table.set(key, counter = new Map());
  counter.set(topic, (counter.get(topic) ?? 0) + by);
}

export function build(config: Config, minTopics: number | null = null, scope: string | null = null): LinksReport {
  require(config, "links");
  const locale = getLocale(config.ui.locale);
  const fm = config.frontmatter;
  const minimum = minTopics === null ? config.links.minTopics : minTopics;
  const entities = loadEntities(join(config.root, config.links.entitiesFile));
  const byMonth = new Map<string, Counter>();
  const byEntity = new Map<string, Counter>();
  const scan = openNotes(config, scope);
  for (const rel of scan.files) {
    const topic = topicOf(rel, config.layout);
    const [data, , text] = readNote(config, rel);
    const months = extractMonths(text, locale);
    const period = data.get(fm.period);
    if (Array.isArray(period)) months.push(...period.filter((value) => PERIOD_RE.test(value)));
    for (const item of months) bump(byMonth, item, topic, 1);
    const value = data.get(fm.entities);
    const listed = Array.isArray(value) ? value : [];
    for (const entity of entities) {
      let count = [...text.matchAll(entity.pattern)].length;
      if (count === 0 && entity.aliases.some((alias) => listed.includes(alias))) count = 1;
      if (count) bump(byEntity, entity.name, topic, count);
    }
  }
  const timeLinks: TimeLink[] = [...byMonth].filter(([, counter]) => counter.size >= minimum)
    .map(([item, counter]) => ({ month: item, topic_count: counter.size, topics: ranked(counter, TOP_TOPICS) }))
    .sort((a, b) => compare(b.month, a.month));
  const entityLinks: EntityLink[] = [...byEntity].filter(([, counter]) => counter.size >= minimum)
    .map(([name, counter]) => ({ entity: name, topic_count: counter.size, topics: ranked(counter, TOP_TOPICS) }))
    .sort((a, b) => compareTuples([-a.topic_count, a.entity], [-b.topic_count, b.entity]));
  return {
    time_links: timeLinks, entity_links: entityLinks, collisions: collisions(config, byMonth),
    sensitive_files: scan.sensitiveFiles, sensitive_topics: scan.sensitiveTopics,
  };
}

/** One entry per month and scope barrier (e.g. work>private) where both sides are busy. */
export function collisions(config: Config, byMonth: ReadonlyMap<string, Counter>): Collision[] {
  const prefix = config.layout.topics + "/";
  const result: Collision[] = [];
  for (const [item, counter] of byMonth) {
    const scopes = new Map([...counter.keys()].map((topic) => [topic, topicScope(config, topic)] as const));
    for (const barrier of config.scopes.linkBarriers) {
      const cut = barrier.indexOf(">");
      const left = cut === -1 ? barrier : barrier.slice(0, cut);
      const right = cut === -1 ? "" : barrier.slice(cut + 1);
      const sides = new Map<string, string[]>();
      for (const side of [left, right]) {
        const topics = [...scopes].filter(([, value]) => value === side).map(([topic]) => topic)
          .sort((a, b) => compareTuples([-counter.get(a)!, a], [-counter.get(b)!, b])).slice(0, MAX_PER_SIDE);
        sides.set(side, topics.map((topic) => (topic.startsWith(prefix) ? topic.slice(prefix.length) : topic)));
      }
      if ([...sides.values()].every((topics) => topics.length > 0)) result.push({ month: item, scopes: sides });
    }
  }
  return result.sort((a, b) => compare(b.month, a.month));
}

export function renderMarkdown(report: LinksReport, config: Config): string {
  const locale = getLocale(config.ui.locale);
  const orNone = (lines: string[]): string[] => (lines.length > 0 ? lines : [locale.linksNone]);
  const lines = [format(locale.linksGenerated, { date: PyDate.today().isoformat() }), "", locale.linksTime, ""];
  lines.push(...orNone(report.time_links.map((item) =>
    "- **" + item.month + "** (" + item.topic_count + " " + locale.linksTopics + "): " + item.topics.join(", "))));
  lines.push("", locale.linksEntities, "");
  lines.push(...orNone(report.entity_links.map((item) =>
    "- **" + item.entity + "** (" + item.topic_count + " " + locale.linksTopics + "): " + item.topics.join(", "))));
  lines.push("", locale.linksCollisions, "");
  lines.push(...orNone(report.collisions.map((item) => "- **" + item.month + "**: "
    + [...item.scopes].map(([scope, topics]) => scope + ": " + topics.join(", ")).join(" × "))));
  lines.push("", format(locale.linksExcluded, { files: report.sensitive_files, topics: report.sensitive_topics }));
  return lines.join("\n") + "\n";
}

/**
 * A .md file inside the brain, outside .git and the note folders, in an existing folder, no symlink.
 *
 * Inside a note folder the map (which names topics of every scope) would turn into a searchable note.
 */
export function outputPath(config: Config, out: string | null): string {
  const raw = join(config.root, out || config.links.output);
  const path = resolve(raw);
  const rel = isRelativeTo(path, config.root) ? parts(relativeTo(path, config.root)) : [];
  if (rel.length === 0 || suffix(path) !== ".md" || isSymlink(raw)
      || [".git", ...config.layout.roots].includes(rel[0]!) || !isDir(parent(path))) {
    throw new Rejected("links_output", { path: out || config.links.output });
  }
  return path;
}

export function writeLinks(config: Config, out: string | null = null, minTopics: number | null = null,
                           scope: string | null = null): string {
  const path = outputPath(config, out);
  writeText(path, renderMarkdown(build(config, minTopics, scope), config));
  return path;
}
