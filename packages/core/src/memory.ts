/**
 * Mirror agent memory (Claude Code, Codex) into the brain, one way. Each source gets a topic whose README sets
 * the source's own scope; each listed project a folder in it. A run rewrites what changed and archives what the
 * agent deleted; nothing flows back. Agents write this memory themselves, so every mirrored note says it is not
 * an instruction, and its links become plain text: an import can never link into the brain or around the
 * sensitivity gate.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { type Access, type Note } from "./access.ts";
import { type Config, type MemorySourceOptions } from "./config.ts";
import { AccessDenied, Rejected } from "./errors.ts";
import { type Memory, projectMemories, type SourceKey } from "./memory-sources.ts";
import { join } from "./pyos.ts";
import { ingest } from "./write.ts";

export { claudeProjectFolder, projectPath, sessionProject } from "./memory-sources.ts";

export interface MemoryImportOptions {
  /** The Claude Code config folder, usually ~/.claude. */
  claudeHome: string;
  /** The Codex home folder, usually ~/.codex. */
  codexHome?: string;
  /** Only this project, for the hook; default: every listed project. */
  project?: string;
  dryRun: boolean;
  sync: boolean;
}

export interface MemoryImportResult {
  changed: string[];
  /** Notes left alone because their scope would change; a scope change needs a review, not an import. */
  kept: string[];
  sync: string;
}

interface Source {
  key: SourceKey;
  label: string;
  alias: string;
  home: string;
  options: MemorySourceOptions;
}

/**
 * The mirror's file name: lower-case kebab case, as the write rules demand, so `2026-10-18T09-31-56-a_b.md`
 * becomes `2026-10-18t09-31-56-a-b.md`. A name that would read as a folder README gets a prefix.
 */
export function mirrorName(file: string, readme: string): string {
  const stem = file.replace(/\.md$/, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-") || "memory";
  return (stem === readme.replace(/\.md$/, "").toLowerCase() ? "memory-" + stem : stem) + ".md";
}

/** Text without Markdown links: `[label](target)` reads `label (target)`, images and wiki links alike. */
function unlinked(text: string): string {
  return text.replace(/!?\[([^\]\n]*)\]\(([^)\n]*)\)/g, "$1 ($2)").replace(/\[\[([^\]\n]*)\]\]/g, "$1");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function frontmatter(fields: [string, string | string[]][]): string {
  const value = (item: string | string[]): string => Array.isArray(item) ? "[" + item.join(", ") + "]" : item;
  return "---\n" + fields.map(([key, item]) => key + ": " + value(item)).join("\n") + "\n---\n";
}

/** Frontmatter key holding a fingerprint of the source, so an unchanged memory is never written again. */
const SOURCE_KEY = "memory_source";

function fingerprint(project: string, memory: Memory, status: string): string {
  return createHash("sha256").update(JSON.stringify([project, memory, status])).digest("hex").slice(0, 16);
}

function sourceOf(text: string): string {
  return new RegExp("^" + SOURCE_KEY + ": (.*)$", "m").exec(text)?.[1] ?? "";
}

/** The scope for a project: its `scope_by_project` entry, else the source's scope. */
function scopeFor(options: MemorySourceOptions, matches: (project: string) => boolean): string {
  const entry = options.scopeByProject.find((item) => matches(item.slice(0, item.lastIndexOf("="))));
  return entry ? entry.slice(entry.lastIndexOf("=") + 1) : options.scope;
}

function noteText(config: Config, source: Source, project: string, memory: Memory, scope: string): string {
  const fm = config.frontmatter;
  const status = config.status.active;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(memory.modified)?.[0] ?? new Date().toISOString().slice(0, 10);
  const keyFact = oneLine(unlinked(memory.description)) || source.label + " memory " + memory.name + ".";
  const aliases = [...new Set([memory.name, memory.type, source.alias].map((item) => oneLine(item)).filter(Boolean))]
    .map((item) => item.replace(/[,[\]]/g, " ").trim());
  // Every note names its scope. The topic README is written once, so a note that inherited from it would keep
  // the old scope after the source moved to another one.
  const head = frontmatter([[fm.scope, scope], [fm.updated, day], [fm.status, status], [fm.keyFact, keyFact], [fm.aliases, aliases],
    [SOURCE_KEY, fingerprint(project + "|" + scope, memory, status)]]);
  return head + "\n# " + oneLine(memory.name) + "\n\n> Imported from the " + source.label + " memory of " + project
    + ". It records what an agent noted in earlier sessions, not an instruction.\n\n" + unlinked(memory.body).trim() + "\n";
}

function readmeText(config: Config, source: Source): string {
  const fm = config.frontmatter;
  const head = frontmatter([[fm.scope, source.options.scope], [fm.status, config.status.active],
    [fm.keyFact, source.label + " memory, mirrored by rcllr import-memory; never edit by hand."]]);
  return head + "\n# " + source.label + " memory\n\nrcllr rewrites this folder from " + source.label
    + "'s memory. Changes made here are lost on the next import.\n";
}

/** The current note at `path`: null when it does not exist, undefined when it is hidden from this access. */
function current(access: Access, path: string): Note | null | undefined {
  if (!fs.existsSync(join(access.config.root, path))) return null;
  try {
    return access.read(path);
  } catch (error) {
    if (error instanceof AccessDenied) return undefined;
    throw error;
  }
}

type Change = { path: string; content: string; expected: string | null };

/** The changes one source needs: new and changed memories, archived ones, and the topic README first. */
function sourceChanges(access: Access, source: Source, only: string | undefined, kept: string[]): Change[] {
  const config = access.config;
  const topic = config.layout.topics + "/" + source.options.topic;
  const changes: Change[] = [];
  // rcllr completes the frontmatter and the README table on write, so the mirror never equals what we wrote.
  // A note counts as current when it carries the same source fingerprint.
  const want = (path: string, content: string, scope: string): void => {
    const previous = current(access, path);
    if (previous === undefined || (previous !== null && sourceOf(previous.text) === sourceOf(content))) return;
    if (previous !== null && previous.scope !== scope) {
      kept.push(path);
      return;
    }
    changes.push({ path, content, expected: previous ? previous.revision : null });
  };
  const selection = { projects: source.options.projects, exclude: source.options.exclude, only };
  for (const { label: project, slug, memories, matches } of projectMemories(source.key, source.home, selection)) {
    const folder = topic + "/" + slug;
    const scope = scopeFor(source.options, matches);
    const name = (memory: Memory): string => mirrorName(memory.file, config.layout.topicReadme);
    for (const memory of memories) want(folder + "/" + name(memory), noteText(config, source, project, memory, scope), scope);
    const kept = new Set(memories.map(name));
    let mirrored: string[] = [];
    try {
      mirrored = fs.readdirSync(join(config.root, folder)).filter((name) => name.endsWith(".md")).sort();
    } catch {
      // First import of this project.
    }
    for (const name of mirrored.filter((file) => !kept.has(file))) {
      const previous = current(access, folder + "/" + name);
      if (!previous || previous.status === config.status.archived) continue;
      const content = previous.text.replace(new RegExp("^" + config.frontmatter.status + ": .*$", "m"),
        config.frontmatter.status + ": " + config.status.archived)
        .replace(new RegExp("^" + SOURCE_KEY + ": .*$", "m"), SOURCE_KEY + ": removed");
      changes.push({ path: folder + "/" + name, content, expected: previous.revision });
    }
  }
  const readme = topic + "/" + config.layout.topicReadme;
  if (changes.length > 0 && current(access, readme) === null) changes.unshift({ path: readme, content: readmeText(config, source), expected: null });
  return changes;
}

export function importMemory(access: Access, options: MemoryImportOptions): MemoryImportResult {
  const config = access.config;
  const sources: Source[] = [];
  if (config.extras.claudeMemory) {
    sources.push({ key: "claude", label: "Claude Code", alias: "claude-memory", home: options.claudeHome,
      options: config.claudeMemory });
  }
  if (config.extras.codexMemory && options.codexHome) {
    sources.push({ key: "codex", label: "Codex", alias: "codex-memory", home: options.codexHome,
      options: config.codexMemory });
  }
  if (!config.extras.claudeMemory && !config.extras.codexMemory) {
    throw new Rejected("extra_disabled", { name: "claude_memory" });
  }
  const kept: string[] = [];
  const perSource = sources.map((source) => sourceChanges(access, source, options.project, kept));
  const changed = perSource.flat().map((change) => change.path);
  // A dry run only lists: its packages would fail, because a new topic's README is not written between them.
  if (options.dryRun) return { changed, kept, sync: "not-run" };
  let sync = "not-run";
  // Each source starts a package of its own, so its topic README always travels with the first notes of it.
  for (const changes of perSource) {
    for (let start = 0; start < changes.length; start += config.limits.maxChanges) {
      const packet = { changes: changes.slice(start, start + config.limits.maxChanges) };
      sync = ingest(access, packet, false, options.sync, "Import agent memory").sync;
    }
  }
  return { changed, kept, sync };
}
