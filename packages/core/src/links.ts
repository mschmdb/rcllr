/** Link checks for write packets: no dead links, no links across sensitivity or scope barriers. */

import { type Access, exactSpelling, type Note } from "./access.ts";
import { AccessDenied } from "./errors.ts";
import { insideWithoutSymlinks } from "./files.ts";
import { text as say } from "./messages.ts";
import { len, rstrip, sorted, strip, WS, WS_CHARS } from "./py.ts";
import { isDir, isFile, join, parts, stem, suffix, windowsUnsafe } from "./pyos.ts";
import { dirname, isabs, joinPosix, normpath, unquote, UrlError, urlsplit } from "./pyurl.ts";

export const ALLOWED_SCHEMES: readonly string[] = ["http", "https", "mailto"];
/** Longer lines are skipped: link regexes are cheap per line, but a line of 80 000 `[` would make them crawl. */
export const MAX_LINK_LINE = 10_000;
/** An ambiguous wikilink names this many candidates and counts the rest. */
const MAX_CANDIDATES = 3;

export interface Issue {
  path: string;
  code: string;
  severity: string;
  message: string;
  line?: number;
  /** For `link-ambiguous`: the readable notes a wikilink matches. */
  candidates?: string[];
}

export function issue(path: string, code: string, message: string, severity = "error",
                      line: number | null = null): Issue {
  const result: Issue = { path, code, severity, message };
  if (line) result.line = line;
  return result;
}

const MARKDOWN_LINK = new RegExp("!?\\[[^\\]\\n]{0,500}\\]\\((<[^>\\n]{1,1000}>|[^" + WS_CHARS + ")]{1,2000})(?:"
  + WS + "+[\"'][^)\\n]{0,500})?\\)", "gu");
const WIKI_LINK = /\[\[([^\]\n]{1,500})\]\]/gu;
/** `(?ms)^```.*?^```[^\n]*` with Python's `^`, which only follows `\n`. */
const CODE_BLOCK = /(?:^|(?<=\n))```[\s\S]*?(?:^|(?<=\n))```[^\n]*/gu;
const INLINE_CODE = /`[^`\n]*`/gu;

/** A link target and the 1-based line it stands on. */
export interface Reference {
  target: string;
  line: number;
}

/** Every link occurrence with its own line; a link used twice appears twice. */
export function referencesWithLines(text: string): Reference[] {
  // Code samples are not links of the note. Blank them but keep their newlines, so line numbers stay true.
  const cleaned = text.replace(CODE_BLOCK, (block) => block.replace(/[^\n]/gu, ""));
  const found: Reference[] = [];
  cleaned.split("\n").forEach((raw, index) => {
    if (len(raw) > MAX_LINK_LINE) return;
    const line = raw.replace(INLINE_CODE, "");
    for (const match of line.matchAll(MARKDOWN_LINK)) found.push({ target: strip(match[1]!, "<>"), line: index + 1 });
    for (const match of line.matchAll(WIKI_LINK)) {
      found.push({ target: "wiki:" + match[1]!.split("|")[0]!, line: index + 1 });
    }
  });
  // Markdown links first, then wikilinks, as before; each group in reading order.
  return [...found.filter((item) => !item.target.startsWith("wiki:")), ...found.filter((item) => item.target.startsWith("wiki:"))];
}

export function references(text: string): string[] {
  return referencesWithLines(text).map((item) => item.target);
}

/** The first line that holds `reference`, for callers that only have the target. */
export function referenceLine(text: string, reference: string): number | null {
  return referencesWithLines(text).find((item) => item.target === reference)?.line ?? null;
}

export const HINTS: Readonly<Record<string, string>> = {
  "link-unavailable": "hint_link_unavailable",
  "link-scope": "hint_link_scope",
};

/**
 * An existing file, no symlink on the way, under a folder listed in links.allow_outside.
 *
 * The owner declared these folders public, so a link there reveals nothing hidden.
 */
export function allowedOutside(access: Access, rel: string): boolean {
  const folders = access.config.links.allowOutside.map((folder) => rstrip(folder, "/"));
  if (!folders.some((folder) => rel.startsWith(folder + "/"))) return false;
  const path = join(access.root, rel);
  return isFile(path) && insideWithoutSymlinks(access.root, path);
}

export function readable(access: Access, rel: string, overlay: ReadonlyMap<string, string>): boolean {
  try {
    if (overlay.has(rel)) access.preview(rel, overlay.get(rel)!, overlay);
    else access.read(rel);
  } catch (error) {
    if (error instanceof AccessDenied) return false;
    throw error;
  }
  return true;
}

/** `work>private` in scopes.link_barriers: a work note must not link to a private one. */
export function crossesBarrier(barriers: readonly string[], note: Note, source: Note): boolean {
  return barriers.includes(note.scope + ">" + source.scope);
}

/**
 * Problems are errors for links new in this write and warnings for links that were already there.
 * Unsafe links (schemes, paths leaving the brain) are always errors. A link across a sensitivity or
 * scope barrier is an error when the write adds it, and in `check` (keepOldBarriers).
 *
 * A missing target and a hidden target give the same issue, so a link check never reveals
 * that a sensitive or out-of-scope note exists.
 */
export function linkIssues(access: Access, note: Note, overlay: ReadonlyMap<string, string>,
                           previous: Note | null = null, keepOldBarriers = false): Issue[] {
  const layout = access.config.layout;
  const problems: Issue[] = [];
  const old = new Set(previous ? references(previous.text) : []);
  for (const { target: reference, line } of referencesWithLines(note.text)) {
    const problem = (code: string, key: string, security = false): void => {
      // A write must not add a barrier link; one that was already there only warns, so it cannot
      // block unrelated edits (`check` reports it as an error through keepOldBarriers).
      const oldBarrier = code === "link-scope" && old.has(reference) && !keepOldBarriers;
      const severity = (security && !oldBarrier) || !old.has(reference) ? "error" : "warning";
      problems.push(issue(note.path, code, say(key, "plain"), severity, line));
    };

    if (reference.startsWith("#")) continue;
    let rel: string;
    if (reference.startsWith("wiki:")) {
      const name = reference.slice(5).split("#")[0]!;
      let candidates = new Set([...new Set([...access.paths(), ...overlay.keys()])]
        .filter((path) => stem(path) === name || path === name || path === name + ".md"));
      for (const candidate of [layout.topics + "/" + name + "/" + layout.topicReadme,
        layout.notes + "/" + name + ".md", layout.bookmarks + "/" + name + ".md"]) {
        if (overlay.has(candidate) || isFile(join(access.root, candidate))) candidates.add(candidate);
      }
      candidates = new Set([...candidates].filter((path) => readable(access, path, overlay)));
      if (candidates.size > 1) {
        // Only readable notes are left, so naming them reveals nothing hidden.
        const names = sorted(candidates);
        const shown = names.slice(0, MAX_CANDIDATES).join(", ");
        const paths = names.length > MAX_CANDIDATES
          ? say("link_ambiguous_more", "plain", { paths: shown, more: names.length - MAX_CANDIDATES }) : shown;
        const severity = !old.has(reference) ? "error" : "warning";
        problems.push({ ...issue(note.path, "link-ambiguous", say("link_ambiguous", "plain", { paths }), severity, line),
          candidates: names });
        continue;
      }
      if (candidates.size === 0) {
        problem("link-unavailable", "link_unavailable");
        continue;
      }
      rel = [...candidates][0]!;
    } else {
      let parsed;
      try {
        parsed = urlsplit(reference);
      } catch (error) {
        if (!(error instanceof UrlError)) throw error;
        problem("link-invalid", "link_scheme", true);
        continue;
      }
      if (ALLOWED_SCHEMES.includes(parsed.scheme)) continue;
      if (parsed.scheme || parsed.netloc) {
        problem("link-invalid", "link_scheme", true);
        continue;
      }
      const target = unquote(parsed.path);
      if (!target) continue;
      // Normalize without following symlinks: a symlink must look like any other unavailable target.
      const joined = normpath(joinPosix(dirname(note.path), target));
      if (joined === ".." || joined.startsWith("../") || isabs(joined)) {
        problem("link-invalid", "link_escapes", true);
        continue;
      }
      rel = joined;
    }
    // A backslash is a separator on Windows: `public/..\notes\x.md` would pass the `../` check above and climb out.
    if (rel.includes("\\")) {
      problem("link-invalid", "link_escapes", true);
      continue;
    }
    // Ask the disk only about the exact spelling. Windows also finds `secret.md.` or `SECRET~1.MD`, which the
    // sensitive list does not name; such a target must answer like a missing one.
    if (!overlay.has(rel) && (windowsUnsafe(rel) || !exactSpelling(access.root, rel))) {
      problem("link-unavailable", "link_unavailable");
      continue;
    }
    // Anything that is not a readable note answers like a missing file: folders of hidden topics,
    // files outside the note folders, .git. Otherwise a link check would map the repository.
    let targetPath = join(access.root, rel);
    if (!overlay.has(rel)) {
      const items = parts(rel);
      if (items.length === 0 || !layout.roots.includes(items[0]!)) {
        if (!allowedOutside(access, rel)) problem("link-unavailable", "link_unavailable");
        continue;
      }
      if (isDir(targetPath)) {
        rel = rel + "/" + layout.topicReadme;
        targetPath = join(access.root, rel);
      }
      // isFile follows symlinks, so a symlink on the way must fail first: a link through one would tell whether
      // its target outside the brain exists.
      if (!overlay.has(rel) && (!insideWithoutSymlinks(access.root, targetPath) || !isFile(targetPath))) {
        problem("link-unavailable", "link_unavailable");
        continue;
      }
    }
    try {
      let source: Note;
      if (overlay.has(rel)) source = access.preview(rel, overlay.get(rel)!, overlay);
      else if (suffix(targetPath) === ".md") source = access.read(rel);
      else {
        // A stand-in note carries the folder rules; the paths file lists the real target.
        source = access.preview(rel + ".md", "# Link\n", overlay);
        if (access.sensitivity.isListed(rel)) {
          if (!access.isGranted(rel)) throw new AccessDenied("path_denied");
          source = { ...source, sensitive: true };
        }
      }
      if ((source.sensitive && !note.sensitive) || crossesBarrier(access.config.scopes.linkBarriers, note, source)) {
        problem("link-scope", "link_scope", true);
      }
    } catch (error) {
      if (!(error instanceof AccessDenied)) throw error;
      problem("link-unavailable", "link_unavailable");
    }
  }
  return problems;
}
