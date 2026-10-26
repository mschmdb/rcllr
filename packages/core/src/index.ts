/**
 * @rcllr/core: long-term memory for coding agents, kept in a Git repo of Markdown notes.
 *
 * Read notes only through `Access`: it applies scope, sensitivity and path rules. The core exports no
 * raw file reader for notes, so a frontend cannot skip the gate by accident.
 */

export { Access, type Note } from "./access.ts";
export * from "./config.ts";
export * from "./errors.ts";
export { parseFrontmatter, dumpFrontmatter, shorten, type Data, type Value } from "./frontmatter.ts";
export { getLocale, type Locale } from "./locale.ts";
export { withRepositoryLock } from "./lock.ts";
export { HELP, PLAIN, CHEEKY, text as message } from "./messages.ts";
export { loads as loadsJson, JsonDecodeError, type Json, type JsonObject } from "./pyjson.ts";
export { Sensitivity } from "./sensitive.ts";
export { checkCommitMessage, committedPaths, MAX_COMMIT_MESSAGE, syncRepository } from "./sync.ts";
export { words } from "./text.ts";

// Read path: search, routes, render.
export {
  bodyStart, contextPacket, find, headingRange, lineCount, searchExcerpt, sourceHit,
  type DateRange, type Hit, type Packet, type SourceLine,
} from "./search.ts";
export {
  filePeriod, planLines, routeProblem, routes, rowDate, select, specific, week,
  type Period, type Route, type Selection,
} from "./routes.ts";
export { bounded, render, type RenderOptions, SEARCH_LINE_BUDGET } from "./render.ts";

// Write path: links, validate, write.
export { HINTS, type Issue, issue, linkIssues, referenceLine, references } from "./links.ts";
export { type Change, metadataIssues, type Plan, validatePacket } from "./validate.ts";
export { atomicWrite, check, type CheckResult, ingest, report, type WriteResult } from "./write.ts";

// Setup and maintenance: meta, scaffold, install, hook, extras.
export { type Entry, entry, generate, migrate, newestFirst, refreshPathsFile, report as metaReport,
  reportSummary, topicDirs } from "./meta.ts";
export { init, renderAgents } from "./scaffold.ts";
export { install } from "./install.ts";
export { agentEvent, type HookOutput, preCommit } from "./hook.ts";
export { dumpJson, openNotes, require as requireExtra, type Scan } from "./extras/common.ts";
export * as linksExtra from "./extras/links.ts";
export * as curator from "./extras/curator.ts";

export const VERSION = "0.5.6";
export { migrateName, type NameMigration } from "./migrate.ts";
export { importMemory, sessionProject, type MemoryImportResult } from "./memory.ts";
