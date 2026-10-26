# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Security

Found in a cross-provider review (Codex) of the access, write, sync and install code.

- `import-memory` writes the scope into every imported note. Before, a note named its scope only when it differed
  from the source's, and inherited the rest from the topic README, which is written once. A source moved from `work`
  to `private` kept its notes readable with `--scope work`. Notes whose scope would change now stay as they are and are
  listed, because a scope change needs a review: delete them to import them again in the new scope.
- `install` refuses to write `.claude/settings.json` or `.codex/hooks.json` through a symlink. A brain from someone
  else could otherwise make it write a file outside the brain.
- A link to a non-Markdown file through a symlink is unavailable, like a missing file. Before, `check` accepted it when
  the target outside the brain existed, which told whether that file exists.
- The note commit no longer takes along the old path of a rename someone staged outside the notes.
- A write checks against the `rcllr.toml` it just fetched. Before, it used the config it started with, so a note the
  remote had just marked as sensitive could still be written without `--allow-sensitive`.
- Sync stops when a push URL differs from the configured remote. Before, only the fetch URL was checked, and a
  `remote.origin.pushurl` could send notes to another repository.

### Changed

- `read --json` names the revision at the top as well (`revision`), the same as `hits[0].revision`.
- A write without `--expected` says what to pass: `new` or the rev from `read` or `context`, also with `--append`.

### Fixed

- A rebase before a write keeps changes someone staged outside the notes staged. `--autostash` restored them as
  unstaged.

## [0.5.5] - 2026-10-24

### Security

- Link checks look only at a target's exact spelling. On Windows, `secret.md.` or `SECRET~1.MD` could reach a sensitive
  note under a name the sensitive list does not hold, and a link check then answered differently than for a missing
  note. A link with a backslash is now invalid: on Windows, `public/..\notes\x.md` could climb out of a folder in
  `links.allow_outside`. Both found in a review of the Windows support, traced in code, not reproduced on Windows.

### Added

- `check` warns when a visible note names a sensitive file or folder in plain text, for example a path in backticks.
  Links to sensitive notes were already rejected; a plain path still told every reader that the hidden note exists.
  The warning names the visible note and line, never the sensitive path.
- Windows support. CI runs the test suite on Windows with Node 22 and 24. Paths keep their drive letter and use
  forward slashes inside rcllr. On Windows, note and config paths with a stream (`a.md:x`), a device name, a trailing
  dot or space are denied. In `rcllr.toml`, write Windows paths in single quotes or with forward slashes.

### Fixed

- `init --remote` escapes the remote in `rcllr.toml`, so a path with a backslash or a quote no longer breaks the file.

## [0.5.4] - 2026-10-24

### Changed

- `scope_by_project` gives single projects of a memory import their own scope, e.g. work memory under `work` and
  personal projects under `private`. A note's scope can't change once written, so delete a project's mirror folder
  before you move it to another scope.
- Imported agent memory counts 60 percent of an own note in the ranking instead of 25. At 25, `context` showed
  loosely related own notes and dropped the memory that answered the question.
- A denied read or write with a narrow `--scope` adds that other scopes stay hidden and how to widen the search.
  The hint depends only on the call, so hidden and missing paths still answer alike.

## [0.5.3] - 2026-10-24

### Fixed

- `import-memory` no longer fails on a first run with more files than `limits.max_changes`: each source gets packages
  of its own, so a new topic's README always travels with its first notes. `--dry-run` now only lists the changes.

## [0.5.2] - 2026-10-24

### Added

- `rcllr import-memory` mirrors Claude Code's auto memory of the projects listed in `[claude_memory]` into the brain,
  in a topic and scope of its own (extra `claude_memory`, off by default). It runs one way, marks every note as not an
  instruction, turns links into plain text, archives memories Claude deleted, and with `--from-hook` imports only the
  project a session ran in. Imported notes rank below the user's own (`search.weights.imported_percent`, 25).
- The extra `codex_memory` imports Codex memory the same way: the rollout summaries under
  `~/.codex/memories/rollout_summaries/` whose session ran in a listed project, into their own scope `memory-codex`.
- `projects = ["*"]` imports the memory of every project, for Claude Code and Codex alike; `exclude` leaves projects
  out.

## [0.5.1] - 2026-10-23

### Fixed

- Hooks also look for `rcllr` and `node` in `/opt/homebrew/bin` and `/usr/local/bin`. Started with a narrow
  `PATH`, for example from the Claude desktop app, they used to find `rcllr` but not `node` and exit with 127.
  Run `rcllr install` again to update the hooks of a brain.
- The README tells users of nvm, fnm or Volta to link `node` into `~/.local/bin` too, and to remove dummkopf
  before installing rcllr.

## [0.5.0] - 2026-10-23

### Renamed

- dummkopf is now **rcllr**: npm packages `rcllr` and `@rcllr/core`, command `rcllr`, config file `rcllr.toml`,
  env var `RCLLR_ROOT`, error class `RcllrError`. Old brains keep working: rcllr reads `dummkopf.toml` when there
  is no `rcllr.toml` and `DUMMKOPF_ROOT` when `RCLLR_ROOT` is unset, and `dummkopf` and `dk` still start it.
  `install` replaces hooks written under the old name.
- `rcllr migrate-name` moves a brain to the new name: it renames the config, updates `AGENTS.md` and `CLAUDE.md`
  and reinstalls old hooks. It lists the steps first and writes only with `--apply`.
- The default tone is now `plain`. `tone = "cheeky"` still adds a remark to some messages, and none of them calls
  the user names anymore.

### Added

- A sync that fails because the remote refuses the login (SSH key, host key or HTTPS credentials) now says so,
  instead of only "Git step failed". Git's own output still never leaves the process. After `write` or `ingest`,
  `--json` reports the reason in `syncError`.
- `dummkopf install` adds permission rules to `.claude/settings.json`: `allow` for `dummkopf` and `dk`, `ask` for
  any call with `--allow-sensitive`. Headless agents (`claude -p`, the GitHub Action) can call dummkopf without
  a prompt, but never open a sensitive note.
- `curator_keep: <date>` in a note's frontmatter keeps it out of the `curator` scan until that day, so a "keep"
  verdict stops coming back every week. On a topic README it also hides the quiet topic. `curator.keep_key`
  renames the field.

### Changed

- The `curator` Markdown report lists each note once, under its first finding, and names its other findings on
  the same line. `--json` is unchanged.
- The curator prompt picks striking links from entity links and collisions, skips links that only share a
  month, and asks for fresh reasons instead of copying earlier reports.
- A README in a sub-folder of a topic gets its own file table. The topic README lists that sub-folder README
  instead of the files below it.

- `curator` reports a date conflict only when the text names a newer "as of" day than the note's own date
  (`updated`, else the Git date). A dated history up to that day is no conflict anymore. Each entry in
  `--json` gains `updated`.

### Fixed

- Two machines that sync at the same moment no longer report "Git step failed: push". A push that loses the
  race fetches, rebases and pushes again, up to three times.
- `curator` compares "as of" dates by calendar day, so `2026-09-25` and `25.09.2026` are the same date.

## [0.4.1] - 2026-10-11

### Added

- `dummkopf --version` prints the version and exits 0. Before, it failed with `missing <command>`.

### Fixed

- A rejected `write` or `ingest` names the line in the content the agent sent. Before, it counted in the note
  after `dummkopf` had added missing frontmatter keys and the sensitive marker.
  Lines in `append` and `replace` still count in the stored note.

### Documentation

- The README FAQ states the speed, measured with `pnpm bench` on an Apple M5 Pro.

## [0.4.0] - 2026-10-11

### Added

- `pnpm bench` times `context`, `find` and `read` on generated brains of 200 and 2000 notes.
- A wikilink that matches several readable notes reports `link-ambiguous` and names up to three of them
  (`candidates` in `--json`). Before, it said "missing or not released". Hidden notes are never named or
  counted.
- `write` and `ingest` take `--message TEXT`, a one-line commit subject of at most 200 characters, in place of
  `repo.commit_message`. An empty or multi-line message is rejected with exit code 2 before anything is saved.
- `[hooks] report` sets when the pre-commit hook prints its report line: `changes` (default), `always` or
  `never`.

### Changed

- `pnpm pack:check` also lints both tarballs with publint and checks the types of `@dummkopf/core` with
  arethetypeswrong.
- `write`, `ingest`, `sync` and the agent hooks commit only the note folders (`topics/`, `notes/`,
  `bookmarks/`, `sources/`, `archive/`) and the generated files (`INDEX.md`, `.sensitive-paths`,
  `links.output`, `curator.report_dir`), plus the routes and entities files named in `dummkopf.toml`.
  Changes to `dummkopf.toml`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/` and other files stay
  uncommitted for a human commit, and no longer block a write.
  `repo.sync_exclude` still keeps paths inside those folders out.
- The pre-commit hook prints its `Report: ...` line only when the counts changed since the last time it
  printed them. It keeps them in `.git/dummkopf-report`, outside the working tree. `dummkopf meta report`
  is unchanged.

### Fixed

- `check` names the real line of every link. Before, each occurrence of a repeated link carried the line of
  the first one, and code blocks shifted the count. Issues are sorted by path and line.
- An edit next to a link that already crosses a scope or sensitivity barrier is saved with a warning instead
  of being rejected. A write that adds such a link is still rejected, and `check` still reports old ones
  as errors.
- The published `@dummkopf/core` manifest no longer has a `source` export condition that pointed at `src/`,
  which is not in the tarball.
- `dummkopf.toml` reaches the TOML parser as read, without newline normalisation. CRLF files load as before;
  a bare carriage return, which TOML 1.0 forbids, now fails with `config_unreadable`.
- The TOML parser no longer accepts the `\e` escape, which only TOML 1.1 has. dummkopf reads strict
  TOML 1.0; write `\u001B` instead.

## [0.3.1] - 2026-10-11

### Added

- A release tag also creates the GitHub release, with the version's changelog section and both tarballs.

### Fixed

- The release workflow passes the tarballs to `npm publish` as `./release/…`. Without `./`, npm took the
  path for a GitHub repository and the first 0.3.1 publish failed.
- The release workflow runs `npm stage publish`, the only command the Trusted Publishers allow. Each version
  waits on npmjs.com until a maintainer approves it with 2FA.
- Output into a pipe that closes early, like `dummkopf --help | head -1`, ends quietly. Before, dummkopf
  crashed with an EPIPE stack trace. The command keeps its exit code.

### Security

- Releases use npm Trusted Publishing instead of an npm token. A build job runs every check and packs the
  tarballs; a separate publish job, the only one with `id-token: write`, uploads them. Its actions are pinned
  to commit SHAs, and installs skip lifecycle scripts.

### Documentation

- The README installs dummkopf with `npm install -g dummkopf` and links both commands into `~/.local/bin`.

## [0.3.0] - 2026-10-11

### Added

- dummkopf is written in TypeScript now: the library `@dummkopf/core` and the CLI `dummkopf` for Node 22.18+.
  Brains, config, frontmatter and hooks stay the same; output matches the Python release byte for byte,
  except `--help` and usage errors (see Changed).
- Local brains: without `repo.remote` dummkopf commits but never fetches, pushes or checks a remote.
  `dummkopf init` without `--remote` creates one. Only `schema_version` is required in `dummkopf.toml` now.
- The black-box suite runs on `node:test` (`packages/cli/test/blackbox`), against any build via `DUMMKOPF_BIN`.
- `pnpm test:toml` checks the TOML parser against the official toml-test suite (TOML 1.0 cases, pinned
  release, fetched into `.cache/`). CI runs it once per push.
- Release setup for npm: package metadata, `prepublishOnly` builds, `pnpm pack:check` (pack, install and run
  the tarballs, also in CI) and a tag-triggered publish workflow with provenance. 0.3.0 is the first release on npm.

### Changed

- `context` no longer prints "Partial match": a whole question almost never matches every word. `find` keeps
  the line, and the JSON `match` value stays the same.
- `find` and `context` rank curator reports below the notes they summarize: their score counts
  `search.weights.curator_report_percent` (default 25). A query naming the curator lifts the cut.
- `check` prints issues as `path:line: message (severity)` when it knows the line, so editors can jump there.
  It still never names a link target.
- `check` warns when `context.routes_file` or `links.entities_file` is set in `dummkopf.toml` but missing.
  The default names stay silent, and `context` never warns.
- The pre-commit hook prints one summary line instead of the full `meta report`, and nothing without findings.
- Shorter `--help` without argparse's layout (#21). `dummkopf --help` lists the commands with one line each,
  grouped as Read, Write, Setup and maintenance, and Extras. `dummkopf <command> --help` shows a one-line
  purpose, the examples, then the options grouped as Access, Output and the command's own options, one per
  line, wrapped at 100 columns. Usage errors print the usage line, a short error naming the argument and a
  pointer to `--help`; they still exit with code 2. Parsing is unchanged.

### Removed

- The Python release (`src/`, `pyproject.toml`, `uv.lock`) and its pytest suite. Install with Node instead; see
  "Coming from the Python version" in the README.

### Fixed

- `dummkopf.toml` with an impossible date or time (`2006-02-30`, `24:00:00`, offset `+24:00`) is rejected
  as unreadable instead of accepted.
- An integer beyond 2^53 in `dummkopf.toml` is rejected instead of silently rounded.

### Security

- A new `README.md` in a folder hidden from the writer answers `topic_unavailable`, like a missing topic. Before,
  it answered `scope_change` only when hidden notes sat below it.
- A link to a non-Markdown file listed in `.sensitive-paths` answers `link-unavailable`, like a missing file.
  Before, the check looked up the stand-in path `<file>.md` and let the link pass.
- The pre-commit hook no longer prints sensitive paths with unstaged edits. It names only their count.

### Documentation

- The README states the "path is taken" signal for writers in full: `path_denied` for a taken path,
  `topic_unavailable` for a free path in a hidden topic. A black-box test pins it.

## [0.2.0] - 2026-10-10

### Added

- `[links] allow_outside`: folders outside the note folders that notes may link to, e.g. `archive`.
- `dummkopf install --replace-command TEXT` removes old hook commands before adding its own.
- Security policy, Dependabot, CODEOWNERS, issue and PR templates.

### Changed

- A broken routes file names the file, the route number and the problem.
- `init --remote` no longer asks to set the remote again. The README explains how to put `dummkopf` on PATH.

### Security

- Link targets are normalized without following symlinks, so a symlink answers like any unavailable target.

## [0.1.0] - 2026-10-10

### Added

- CLI `dummkopf` with alias `dk`: `context`, `find`, `read`, `write`, `ingest`, `check`, `sync`, `init`,
  `install`, `hook`, `meta`, `links`, `curator`.
- `dummkopf.toml` with validated sections for repo, layout, scopes, status, sensitivity, frontmatter keys,
  locale, tone, limits, search weights, routes and extras. Unknown keys are rejected.
- Scope inheritance from topic READMEs, scope link barriers, and sensitivity through markers, folder READMEs,
  a generated paths list and always-sensitive prefixes.
- Atomic multi-file writes with revision checks and rollback; exit code 2 for rejected calls and 3 for
  saved-but-not-synced writes.
- One Git sync path with a process lock for the CLI, the Claude Code hook and the Codex hook.
- Pre-commit hook that regenerates the sensitive-paths list, completes frontmatter and rebuilds indexes.
- Locales `en` and `de` for generated headings and text heuristics; `cheeky` and `plain` tones.
- Extras: links map, curator scan with weekly LLM prompt, Codex hook.
- English agent rules (`AGENTS.md`) rendered from the brain configuration.
- `--scope` for `links`, `curator` and `meta report`; routes open sensitive plans only with `allow_sensitive`.

### Security

- Hidden notes answer like missing ones in `read`, `find`, `context`, link checks and new files in a topic.
- Paths must match the on-disk spelling; listed paths compare case-insensitively and in one Unicode form.
- Symlinks never count as notes, and generated files are never read or written through symlinks.
- Markers count with BOM, indentation, tabs and CR-only line breaks.
- A README may not shift the scope of notes below it; README tables list only notes of their own scope.
- Link regexes are bounded; malformed URLs are reported instead of crashing.
- The pre-commit hook never stages files with unstaged edits and never rewrites `sources/` or unreadable notes.
