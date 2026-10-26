/** Keyword search and the `context` entry point. Results carry exact physical line numbers. */

import type { Access, Note } from "./access.ts";
import { AccessDenied, Rejected } from "./errors.ts";
import { getLocale } from "./locale.ts";
import { compare, lstrip, slice, splitlines, strip, unique, WS } from "./py.ts";
import { PyDate } from "./pydate.ts";
import { parts, stripTrailingSlashes } from "./pyos.ts";
import { planLines, select } from "./routes.ts";
import { words } from "./text.ts";

/** Keys match the JSON output, so they stay snake_case. */
export interface SourceLine {
  n: number;
  text: string;
}

export interface Hit {
  path: string;
  title: string;
  updated: string;
  status: string;
  scope: string;
  key_fact: string;
  lines: SourceLine[];
  revision: string;
}

export interface DateRange {
  start: string;
  end: string;
}

/** A read result. Key order is the JSON order: hits, match, more, truncated, then the optional keys. */
export interface Packet {
  /** Only for `read` of one note: its revision, the same as `hits[0].revision`. */
  revision?: string;
  hits: Hit[];
  match: string;
  more: boolean;
  truncated: boolean;
  period?: DateRange;
  missing_dates?: string[];
  ignored?: string[];
  missing?: string[];
}

/** len(note.text.splitlines()): the number of physical lines. */
export function lineCount(note: Note): number {
  return splitlines(note.text).length;
}

export function sourceHit(note: Note, start: number, end: number): Hit {
  const lines: SourceLine[] = [];
  splitlines(note.text).forEach((line, index) => {
    if (start <= index + 1 && index + 1 <= end) lines.push({ n: index + 1, text: line });
  });
  return {
    path: note.path, title: slice(note.title, 0, 160), updated: slice(note.updated, 0, 40),
    status: slice(note.status, 0, 40), scope: note.scope, key_fact: slice(note.keyFact, 0, 260), lines,
    revision: note.revision,
  };
}

const FENCE_RE = new RegExp("^" + WS + "{0,3}(`{3,}|~{3,})", "u");
const HEADING_RE = new RegExp("^(#{1,6})" + WS + "+([^\\n]+)", "u");

/** items[:len(prefix)] == prefix. */
function samePrefix(items: readonly string[], prefix: readonly string[]): boolean {
  return items.length >= prefix.length && prefix.every((item, index) => items[index] === item);
}

export function headingRange(text: string, section: string): [number, number] {
  const terms = words(section);
  if (terms.length === 0) throw new Rejected("section_needs_heading");
  const headings: [number, number, string[]][] = [];
  let fence: [string, number] | null = null;
  const lines = splitlines(text);
  lines.forEach((line, index) => {
    const number = index + 1;
    const marker = FENCE_RE.exec(line);
    if (marker) {
      const token = marker[1]!;
      if (fence === null) fence = [token[0]!, token.length];
      else if (token[0] === fence[0] && token.length >= fence[1]) fence = null;
      return;
    }
    if (fence) return;
    const match = HEADING_RE.exec(line);
    if (match) headings.push([number, match[1]!.length, words(match[2]!)]);
  });
  const selected = headings.filter((heading) => samePrefix(heading[2], terms));
  if (selected.length !== 1) throw new Rejected("section_ambiguous");
  const [start, level] = selected[0]!;
  const next = headings.find(([number, depth]) => number > start && depth <= level);
  return [start, next ? next[0] - 1 : lines.length];
}

/** Line number where the frontmatter ends and the body begins (1-based). */
function frontmatterLines(note: Note): number {
  const head = note.text.slice(0, note.text.length - note.body.length);
  return head.split("\n").length;
}

export function bodyStart(note: Note): number {
  const lines = splitlines(note.text);
  let first = frontmatterLines(note);
  while (first <= lines.length && strip(lines[first - 1]!) === "") first++;
  return first <= lines.length ? first : 1;
}

function plainLine(line: string): boolean {
  const start = lstrip(line);
  return !(start.startsWith("#") || start.startsWith("```") || start.startsWith("|"));
}

export function searchExcerpt(note: Note, terms: readonly string[]): Hit {
  const first = frontmatterLines(note);
  const bodyLines = splitlines(note.body);
  if (bodyLines.length === 0) return sourceHit(note, first, first);
  const wanted = new Set(terms);
  const coverage = bodyLines.map((line) => new Set(words(line).filter((word) => wanted.has(word))).size);
  // max() keeps the first of equal keys: (coverage, not a heading, fence or table row).
  let anchor = 0;
  for (let index = 1; index < bodyLines.length; index++) {
    const better = coverage[index]! - coverage[anchor]!
      || Number(plainLine(bodyLines[index]!)) - Number(plainLine(bodyLines[anchor]!));
    if (better > 0) anchor = index;
  }
  if (!coverage[anchor]) {
    const found = bodyLines.findIndex((line) => strip(line) !== "" && !line.startsWith("#"));
    anchor = found === -1 ? 0 : found;
  }
  return sourceHit(note, first + Math.max(0, anchor - 2), first + Math.min(bodyLines.length - 1, anchor + 2));
}

export function find(access: Access, query: string, limit = 3, natural = false): Packet {
  const config = access.config;
  const weights = config.search.weights;
  const stopwords = getLocale(config.ui.locale).stopwords;
  let terms = unique(words(query));
  let ignored: string[] = [];
  if (natural) {
    ignored = terms.filter((term) => stopwords.has(term));
    terms = terms.filter((term) => !stopwords.has(term));
  }
  if (terms.length === 0) throw new Rejected("search_needs_term");
  const reports = stripTrailingSlashes(config.curator.reportDir) + "/";
  // A question about the curator wants its reports; otherwise they rank below the notes they summarize.
  const curatorWords = new Set(["curator", ...words(parts(reports).at(-1) ?? "")]);
  const lowerReports = !terms.some((term) => curatorWords.has(term));
  // Agent memory repeats what the user's own notes say; it ranks below them.
  const imported = [[config.extras.claudeMemory, config.claudeMemory.topic], [config.extras.codexMemory, config.codexMemory.topic]]
    .filter(([on]) => on).map(([, topic]) => config.layout.topics + "/" + topic + "/");
  const ranked: [number, number, Note][] = [];
  const found = new Set<string>();
  for (const path of access.paths()) {
    let note: Note;
    try {
      note = access.read(path);
    } catch (error) {
      if (error instanceof AccessDenied) continue;
      throw error;
    }
    const fields: [string, number][] = [
      [note.title, weights.title], [note.aliases.join(" "), weights.aliases], [note.keyFact, weights.keyFact],
      [note.path, weights.path], [note.body, weights.body],
    ];
    const tokens = fields.map(([text, weight]) => [new Set(words(text)), weight] as const);
    const matched = terms.filter((term) => tokens.some(([field]) => field.has(term)));
    if (matched.length === 0) continue;
    for (const term of matched) found.add(term);
    let score = 0;
    for (const [field, weight] of tokens) {
      for (const term of terms) if (field.has(term)) score += weight;
    }
    const items = parts(note.path);
    // A query naming a topic is best answered by that topic's README.
    if (items[0] === config.layout.topics && items[items.length - 1] === config.layout.topicReadme
        && words(items[1]!).every((word) => terms.includes(word))) {
      score += weights.topicReadmeBonus;
    }
    if (lowerReports && note.path.startsWith(reports)) score = score * weights.curatorReportPercent / 100;
    if (imported.some((prefix) => note.path.startsWith(prefix))) score = score * weights.importedPercent / 100;
    ranked.push([matched.length, score, note]);
  }
  ranked.sort((a, b) => (natural ? b[1] - a[1] || b[0] - a[0] : b[0] - a[0] || b[1] - a[1])
    || compare(a[2].path, b[2].path));
  const complete = ranked.filter((item) => item[0] === terms.length);
  const selected = natural ? ranked : complete.length > 0 ? complete : ranked;
  const hits: Hit[] = [];
  for (const [, , note] of selected.slice(0, limit)) {
    // Check again before output: markers and scope can change in parallel.
    try {
      hits.push(searchExcerpt(access.read(note.path), terms));
    } catch (error) {
      if (error instanceof AccessDenied) continue;
      throw error;
    }
  }
  const allSelected = selected.length > 0 && selected.slice(0, limit).every((item) => item[0] === terms.length);
  const packet: Packet = {
    hits, match: allSelected ? "all" : ranked.length > 0 ? "partial" : "none", more: selected.length > limit,
    truncated: false,
  };
  if (ignored.length > 0) packet.ignored = ignored;
  const missing = terms.filter((term) => !found.has(term));
  if (missing.length > 0) packet.missing = missing;
  return packet;
}

export function contextPacket(access: Access, query: string, today: PyDate | null = null,
                              limit: number | null = null): Packet {
  if (words(query).length === 0) throw new Rejected("query_needs_word");
  const selection = select(access, query, words, today ?? PyDate.today());
  if (selection === null) {
    try {
      return find(access, query, limit || access.config.limits.findLimit, true);
    } catch (error) {
      if (error instanceof Rejected) return { hits: [], match: "none", more: false, truncated: false };
      throw error;
    }
  }
  const packet: Packet = { hits: [], match: "routed", more: false, truncated: false };
  const covered = new Set<number>();
  for (const note of selection.notes) {
    const hit = sourceHit(note, 1, lineCount(note));
    if (selection.period) {
      const [kept, dates] = planLines(note, selection.period, access.config);
      const keep = new Set(kept);
      hit.lines = hit.lines.filter((line) => keep.has(line.n));
      // The whole-note key fact can describe days outside the requested period.
      hit.key_fact = "";
      for (const date of dates) covered.add(date.ordinal());
    }
    packet.hits.push(hit);
  }
  if (selection.period) {
    const [start, end] = selection.period;
    packet.period = { start: start.isoformat(), end: end.isoformat() };
    const days: string[] = [];
    for (let day = start; day.compare(end) <= 0; day = day.addDays(1)) {
      if (!covered.has(day.ordinal())) days.push(day.isoformat());
    }
    packet.missing_dates = days;
  }
  return packet;
}
