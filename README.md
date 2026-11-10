# rcllr

Long-term memory for coding agents, kept in a plain Git repo of Markdown notes.

*Agents forget. rcllr recalls.*

rcllr turns a folder of Markdown notes into a memory that Claude Code, Codex and other agents can query and
write through one CLI. Hooks commit every change. With a remote, they also push it, so the memory follows you
to every machine. Without one, the brain stays on your machine. Notes carry a scope (`private`, `work`, or
your own) and can be marked sensitive. Agents never see sensitive notes unless the user names the topic.

## Why not built-in memory?

Claude Code and Codex remember things on their own. Use that first. It needs no setup, and Claude Code loads its
memory into every session, while rcllr answers only when the agent asks. If you work on one project on one
machine, built-in memory is enough.

| | Built-in | rcllr |
|---|---|---|
| Claude Code auto memory | One folder per Git repository in `~/.claude/projects/`, on this machine only | One brain for every project, on every machine with a synced brain |
| Codex memories | Off by default, kept in `~/.codex/memories/` | The same brain for Codex and Claude Code |
| `CLAUDE.md`, `AGENTS.md` | Rules loaded into every session | Notes with a key fact, aliases and a search that cites the file |
| Notion memory (MCP) | Hosted by Notion, needs a Notion account | Markdown in your own Git repository, local or synced |
| Private and work | Separated by project at most, no hidden notes | Scopes, and sensitive notes agents open only when you name the topic |

Sources: [Claude Code memory](https://code.claude.com/docs/en/memory),
[Codex memories](https://developers.openai.com/codex/memories), as of October 2026.

## Quickstart (5 minutes)

You need Node.js 22.18 or newer, Git, and macOS, Linux or Windows (with Git for Windows).

```bash
npm install -g rcllr
```

This installs `rcllr`. Update later with the same command. The old names `dummkopf` and `dk` keep working
for now, see [Coming from dummkopf](#coming-from-dummkopf).

The hooks call `rcllr` by name. Agents often start hooks with a narrower `PATH` than your terminal, the Claude
desktop app for one, so the hooks also look in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. That
covers Node from Homebrew or the nodejs.org installer. With nvm, fnm or Volta, `rcllr` and `node` live in a
folder the hooks do not know. Link both into `~/.local/bin`:

```bash
mkdir -p ~/.local/bin
ln -sf "$(npm prefix -g)/bin/rcllr" "$(command -v node)" ~/.local/bin/
```

The `node` link points to one Node version. Run the line again after you switch versions and reinstall rcllr.

To run the latest `main` instead, build from source with pnpm: clone the repository, run
`pnpm install && pnpm build`, and link `packages/cli/bin/rcllr` into `~/.local/bin`. See [CONTRIBUTING.md](CONTRIBUTING.md).

Create a brain. Decide first where it lives:

```bash
rcllr init ~/brain
```

This brain is **local**. rcllr commits every change, but never fetches or pushes. Choose it when your notes
must not leave the machine.

```bash
rcllr init ~/brain --remote git@github.com:you/your-brain.git
```

This brain is **synced**. Use an empty *private* repository as its remote. rcllr pushes after every change
and rebases onto the remote before every write, so all your machines share one memory.

Wire up the Git and agent hooks, then commit the scaffold (and push it, for a synced brain):

```bash
cd ~/brain && rcllr install && git add -A && git commit -m "Create brain"
git push -u origin main   # synced brains only
```

Write a first note and ask for it:

```bash
printf -- '---\nkey_fact: pnpm 10 needs approve-builds for esbuild.\n---\n\n# pnpm\n\nRun pnpm approve-builds once.\n' | rcllr write notes/pnpm.md --expected new
```

```bash
rcllr context "How do I fix the pnpm esbuild error?"
```

`write` validated the note, added missing frontmatter and committed it.
In a synced brain it pushed, too. The pre-commit hook added the note to `INDEX.md`.

Start Claude Code or Codex inside `~/brain` and the agent follows `AGENTS.md`. To use the brain from other
projects, see [Agent setup](#agent-setup).

## Local or synced

The only difference is `repo.remote` in `rcllr.toml`.

| | Local brain | Synced brain |
|---|---|---|
| `repo.remote` | not set | your private repository |
| Commits note changes | yes | yes |
| Fetches and rebases before a write | never | yes |
| Pushes after a write | never | yes, unless `auto_push = false` |
| Checks the Git remote | never | sync refuses any other URL |

A local brain never talks to a remote, even when the Git repository has one. To turn a local brain into a
synced one later, add the remote to Git and set `repo.remote` to the same URL. To go back, remove the
`remote` line.

### A key just for the brain

The hooks push in the background. There your SSH agent or keychain may be out of reach: the Mac is locked,
the agent runs in a sandbox, or your key needs a passphrase. Then the push fails with
`Permission denied (publickey)`. A deploy key gives the brain its own SSH key with write access to that one
repository and nothing else:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/brain_deploy -N "" -C "brain deploy key"
```

Add `~/.ssh/brain_deploy.pub` on GitHub under the brain repository's **Settings → Deploy keys**, with
**Allow write access**. `gh repo deploy-key add ~/.ssh/brain_deploy.pub --allow-write` works too, but GitHub
removes such a key when you revoke the GitHub CLI app or its token. Then give the key its own host name in
`~/.ssh/config`:

```sshconfig
Host github-brain
  HostName github.com
  User git
  IdentityFile ~/.ssh/brain_deploy
  IdentitiesOnly yes
  IdentityAgent none
```

Point the brain at that host, in Git and in `rcllr.toml` alike:

```bash
git remote set-url origin git@github-brain:you/your-brain.git
```

```toml
[repo]
remote = "git@github-brain:you/your-brain.git"
```

The key has no passphrase, so anyone who can read `~/.ssh/brain_deploy` can write to your brain. In
exchange, it can reach no other repository. Create one key per machine, so you can revoke a lost machine alone.

## How a brain looks

```
brain/
├── rcllr.toml          configuration
├── AGENTS.md              rules for every agent (CLAUDE.md points here)
├── INDEX.md               generated tables: topics, flat notes, bookmarks
├── .sensitive-paths       generated from markers; never edit by hand
├── topics/<topic>/        a folder per topic; README.md holds scope and file table
├── notes/<name>.md        single notes, flat
├── bookmarks/<theme>.md   saved links, flat
├── sources/               originals that stay verbatim
└── archive/               retired notes, not searched
```

[examples/demo-brain](examples/demo-brain) shows a hobby topic, a work topic and one sensitive note.

Every note starts with frontmatter. rcllr fills gaps when it writes:

```markdown
---
updated: 2026-09-20
status: active
key_fact: Starter lives in the fridge; feed 1:5:5 the evening before baking.
summary: Starter lives in the fridge; feed 1:5:5 the evening before baking.
aliases: [bread, starter]
period: [2026-09]
entities: []
---
```

`key_fact` is the one sentence the index shows. `summary` is its short form. `aliases` feed the search.
`period` (months like `2026-09`) and `entities` feed the links map.

## Scope and sensitivity

**Scope** separates contexts. A topic's `README.md` sets `scope: work` or `scope: private`, and everything
in the folder inherits it. A file sets its own scope only when it differs. `--scope work` hides private
notes, `--scope both` shows all. Scopes never lock anything; they keep a work answer free of private notes.
`scopes.link_barriers` stops one scope from linking into another, by default `work>private`.

**Sensitivity** hides notes. A note is sensitive when:

- it contains the marker line (`> SENSITIVE` by default) on a line of its own, or
- a `README.md` in one of its folders contains the marker, or
- its path sits under a `sensitive.always` prefix (for example `topics/health/`).

The marker also counts when it is indented, so a note that quotes `> SENSITIVE` in an indented block
becomes sensitive too. That is on purpose: hiding one note too many is the cheaper mistake.

Sensitive notes stay out of search results, `INDEX.md`, the file tables of open topics, the links map and
the curator scan. `read`, `find`, `context`, link checks and new files in a topic answer a hidden path exactly like a
missing one. A topic `README.md` lists only notes of its own scope.
One signal stays by design: whoever may write packets learns whether a path is taken. A new file on an
existing hidden file fails with `path_denied`, also inside a hidden topic. A free path in a hidden topic fails with
`topic_unavailable`, like a path in a missing topic. A new `README.md` in a hidden folder answers like a missing topic,
whether notes sit below it or not. An agent may pass `--allow-sensitive <path>` only after the user named the topic in the current prompt;
`AGENTS.md` says so, and the hooks in [Sensitive calls](#sensitive-calls) check it. The pre-commit hook derives `.sensitive-paths` from the markers, so `rg --ignore-file`
works as a fallback without the CLI.

Write rules rcllr enforces:

- `--expected <rev>` on every change. A stale revision is rejected, so two agents never overwrite each other.
- A new topic needs a `README.md` with a scope in the same package.
- No removing markers, no changing scopes, no edits under `sources/`. A new `README.md` must not change
  the scope of notes that already sit below it.
- No dead links, no links from a non-sensitive note to a sensitive one. `check` also warns when a visible note
  names a sensitive path in plain text.
- New files get mode `0600` (not on Windows, which has no such modes).
- Symlinks never count as notes. A cloned brain cannot pull outside files into the index or the extras.
- Paths must match the on-disk spelling, so `Topics/Health/x.md` never opens `topics/health/x.md` on a
  case-insensitive file system, and a Windows short name like `HEALTH~1` never opens `health-notes`.
- On Windows, note paths with a stream (`a.md:x`), a device name (`CON`, `nul.md`), a trailing dot or space,
  or a backslash are denied.

## Commands

| Command | What it does |
|---|---|
| `context "<question>"` | Best entry point for a user question. Drops filler words and follows routes. |
| `find "<keywords>"` | Keyword search over title, aliases, key fact, path and text. |
| `read <path>` | Read a note, a line range (`--start`, `--end`) or a section (`--section`). |
| `write <path> --expected new\|<rev>` | Write one file from Markdown on stdin. `--append` appends. `--message TEXT` sets the commit subject. |
| `ingest --input -` | Write a JSON package of several files atomically. `--message TEXT` sets the commit subject. |
| `check [paths]` | Validate frontmatter and links. |
| `sync` | Commit note changes; in a synced brain also rebase onto the remote and push. |
| `init [path]` | Create a new brain; `--remote URL` makes it synced. |
| `install` | Install the Git pre-commit hook and the Claude Code and Codex hooks. |
| `meta migrate\|generate\|report\|index\|agents` | Maintain frontmatter and indexes; print rendered `AGENTS.md`. |
| `links` | Build the links map (extra). |
| `curator` | Run the curation scan or print its weekly LLM prompt (extra). |
| `import-memory` | Mirror Claude Code and Codex memory of the listed projects into the brain (extra). |

**What gets committed.** `write`, `ingest`, `sync` and the agent hooks commit only what rcllr manages: the
note folders (`topics/`, `notes/`, `bookmarks/`), `sources/`, `archive/`, `INDEX.md`, `.sensitive-paths`, the
links map (`links.output`), the curator reports (`curator.report_dir`) and the routes and entities files
(`context.routes_file`, `links.entities_file`). Everything else, such as
`rcllr.toml`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/` or your scripts, stays uncommitted for you to
commit by hand, and an uncommitted change there never blocks a write. `repo.sync_exclude` keeps further paths
inside those folders out. The commit subject is `repo.commit_message`; `write` and `ingest` take
`--message "Add pnpm build fix"` (one line, at most 200 characters) for a subject of their own.

Read commands share `--scope`, `--topic`, `--allow-sensitive`, `--json` and `--max-chars`. Every command
accepts `--root PATH` and `--serious`. `rcllr <command> --help` shows the purpose and examples first, then
the options grouped as Access, Output and the command's own options. `rcllr --version` prints the version.

Every hit starts with a header line: `path | rev=<12 chars> | updated | status | scope`. Pass that `rev`
as `--expected` when you change the file.

**Exit codes:** `0` ok, `2` rejected call (nothing changed; the message says what to fix),
`3` saved but the Git sync failed (run `rcllr sync` again). When the remote refuses the login, the
message says so; with `--json`, `syncError` holds the message key, for example `git_auth`.

## Agent setup

**Inside the brain.** `rcllr init` writes `AGENTS.md` with the rules and a `CLAUDE.md` that imports it.
Codex reads `AGENTS.md` directly. `rcllr install` adds:

- `.git/hooks/pre-commit`: regenerates `.sensitive-paths`, completes frontmatter of staged notes,
  rebuilds `INDEX.md` and the README tables. With stale or incomplete notes it prints one summary line,
  but only when the counts changed since the last commit (`[hooks] report`); `rcllr meta report` lists
  them. It keeps the last counts in `.git/rcllr-report`, never in the working tree, and never blocks a commit.
- `.claude/settings.json`: a `PostToolUse` hook on `Write|Edit|MultiEdit|Bash` and a `SessionEnd` hook.
  Both run `rcllr hook agent`, which commits note changes and, in a synced brain, pushes them.
- `.codex/hooks.json` (with `extras.codex_sync`): the same hook for Codex tools. Check that your Codex
  version has hooks enabled.
- `.claude/settings.json`: a `UserPromptSubmit` hook (`rcllr hook prompt`) and a `PreToolUse` hook on `Bash`
  (`rcllr hook pre-tool`). Together they decide when Claude Code asks before a sensitive call. See
  [Sensitive calls](#sensitive-calls).
- `permissions` in `.claude/settings.json`: `allow` rules for `Bash(rcllr *)` and the old names `dummkopf` and
  `dk`. Older releases also wrote `ask` rules for `--allow-sensitive`; `install` removes exactly those.
  See [Headless agents](#headless-agents).

Existing settings stay; `install` only adds its own entries and can run again safely. Moving from an older
sync setup? `rcllr install --replace-command old_sync.py` removes hook commands containing that text first,
so two sync paths never run side by side.

**From other projects.** Point your global agent instructions at the brain, for example in
`~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`:

```markdown
Long-term memory lives in ~/brain. Before answering questions about earlier decisions or known topics, run
`rcllr --root ~/brain context "<the question>"`. Follow ~/brain/AGENTS.md for scope, sensitivity and writing.
```

`RCLLR_ROOT=~/brain` in your shell profile saves the `--root`. The hooks ignore it: they always get
`--root` from the hook command, so they never act on a brain you did not install them into.

### Headless agents

`claude -p` and the Claude Code GitHub Action never ask before a Bash command. They deny every command that
needs approval and no rule allows, and report the denial only in their result. Without a rule, an agent there
cannot call `rcllr` at all. Claude Code on the web applies the rules from the repository's
`.claude/settings.json`, too.

Inside the brain, `rcllr install` writes the rule. From other projects, add it yourself, for example
to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(rcllr *)"]
  }
}
```

For the GitHub Action, pass the same rule through its `settings` input or `claude_args: --allowedTools`.
Headless, nobody names a topic, so the pre-tool hook asks before every sensitive call, and the call fails.

### Sensitive calls

`AGENTS.md` tells the agent to pass `--allow-sensitive` only for a topic the user named. Two hooks check this
from outside the agent:

1. `rcllr hook prompt` reads your prompt as you sent it. It compares the words with the names of sensitive
   topic folders and files and with their `aliases`, ignoring case, umlaut spelling (`ä` or `ae`) and
   accents. Names and aliases shorter than three characters never match. Each match becomes a grant for
   this Claude Code session and stays until the session ends. Grants live in `.git/rcllr/grants.json`,
   never in the working tree.
2. `rcllr hook pre-tool` reads each Bash command for `--allow-sensitive`, including abbreviations,
   `=value` and calls inside chains or `$(…)`. When grants cover every requested path and the command
   runs nothing but rcllr, it allows the call. When a path is not covered, it asks you. A granted call in a
   chain with other commands gets no answer from the hook, so Claude Code's own rules decide as for any
   command.

The hook also asks when it cannot read the flag value for sure: a variable, a glob, a substitution, a
flag inside `bash -c "…"`, `eval` or an unquoted heredoc, or a command it cannot split. A grant covers its
own path and everything below it, never a broader request such as `--allow-sensitive topics/`.

A `PreToolUse` "allow" does not override an `ask` rule, so the hooks replace the `ask` rules older
releases wrote. Keep no `ask` rule for `--allow-sensitive`, or Claude Code asks every time.

These checks match the command as the agent writes it. They are not a security boundary: an agent can still
read the files directly with `cat`, or write the grants file. If the hook cannot run at all, for example
because `rcllr` is missing from the hook's `PATH`, Claude Code's own rules decide without it.

## Configuration reference

`rcllr.toml` lives in the brain root. Only `schema_version` is required. Unknown keys are an error, so a
typo never switches a rule off silently. The full file with every default is in
[examples/rcllr.example.toml](examples/rcllr.example.toml).

On Windows, write paths in single quotes or with forward slashes: `remote = 'C:\brains\remote.git'` or
`remote = "C:/brains/remote.git"`. In double quotes, TOML reads `\b` or `\U` as an escape.

| Section | Keys | Purpose |
|---|---|---|
| `[repo]` | `remote`, `remote_name`, `branch`, `auto_push`, `commit_message`, `sync_exclude` | Without `remote` the brain is local and never fetches or pushes. With it, sync refuses any other remote URL or branch. `auto_push = false` commits locally only. rcllr commits only note folders and generated files (see [Commands](#commands)); `sync_exclude` lists further paths inside them that humans commit themselves. |
| `[layout]` | `topics`, `topic_readme`, `notes`, `bookmarks`, `archive`, `sources`, `index` | Folder and file names. |
| `[scopes]` | `values`, `all`, `query_default`, `mixed_label`, `require_on_new_topic`, `link_barriers` | Your scopes, the keyword for "all scopes", the default for `--scope`, the label for unscoped notes, and forbidden link directions such as `work>private`. |
| `[status]` | `active`, `archived` | Status values; stale checks look at `active` notes. |
| `[sensitive]` | `marker`, `paths_file`, `always` | Marker line, generated list, and path prefixes that are always sensitive. |
| `[frontmatter]` | `key_fact`, `summary`, `aliases`, `updated`, `status`, `period`, `entities`, `scope`, `todo_placeholder`, `summary_max` | Maps each field to the key used in your files. |
| `[ui]` | `locale`, `tone` | `locale` (`en`, `de`) sets generated headings and text heuristics. `tone` is `plain` (default) or `cheeky`, which adds a short remark to some messages. |
| `[hooks]` | `report` | When the pre-commit hook prints its report line: `changes` (default, only when the counts changed), `always` or `never`. |
| `[limits]` | `max_chars`, `find_limit`, `max_input_chars`, `max_changes`, `lock_timeout_s`, `git_timeout_s`, `stale_after_days` | Output budgets and timeouts. |
| `[search.weights]` | `title`, `aliases`, `key_fact`, `path`, `body`, `topic_readme_bonus`, `curator_report_percent`, `imported_percent` | Search ranking. Curator reports score 25 percent unless the query names the curator; imported agent memory scores 60 percent. |
| `[context]` | `routes_file` | Optional routes for dated plans (see below). |
| `[extras]` | `links`, `curator`, `codex_sync`, `claude_memory`, `codex_memory` | Switch each extra on or off. The two memory imports are off by default. |
| `[links]` | `output`, `entities_file`, `min_topics`, `allow_outside` | Options of the links extra. `allow_outside` lists folders outside the note folders (e.g. `archive`, `assets`) that notes may link to; any other target outside the note folders counts as unavailable. |
| `[curator]` | `open_days`, `stale_days`, `report_dir`, `keep_key` | Options of the curator extra. |
| `[claude_memory]`, `[codex_memory]` | `projects`, `exclude`, `scope`, `scope_by_project`, `topic` | Options of the two memory imports. `projects = ["*"]` imports every project; `exclude` leaves some out; `scope_by_project` gives single projects another scope. |

**An existing brain in another language** runs on rcllr through configuration alone.
[examples/config-german-hub.toml](examples/config-german-hub.toml) maps German keys (`kernfakt`, `stand`, …),
scopes (`privat`), the marker (`> SENSIBEL`) and folders (`quellen/`) without touching a note.

## Extras

- `links`, `curator` and `meta report` take `--scope` (default `scopes.query_default`) and show only notes
  the read gate releases for that scope. With `query_default = "both"`, the default, they cover every scope
  unless you pass `--scope`.
- **links**: writes `LINKS.md` (never inside a note folder, so it never turns into a searchable note) with topics that share a month or an entity, and months where topics on both
  sides of a scope barrier are busy. Entities come from `entities.txt`: one per line, `Name|alias|alias`,
  prefix `i:` for case-insensitive matching.
- **curator**: `rcllr curator` lists open loops, quiet topics, conflicting "as of" dates and stale active
  notes. A date conflicts when the text names a newer "as of" day than the note's own date. `rcllr curator --prompt`
  prints a weekly LLM prompt that turns the scan into a proposal report under `curator.report_dir`. The prompt
  proposes; it never changes notes. To keep a note out of the scan after a "keep" verdict, give it
  `curator_keep: <date>` in its frontmatter (`curator.keep_key` renames the field); it returns after that day. On a
  topic README it also hides the quiet topic.
- **codex_sync**: installs the Codex hook.
- **claude_memory**: `rcllr import-memory` mirrors Claude Code's auto memory into the brain, so it follows you to
  every machine and `context` finds it next to your notes. Claude Code keeps that memory per project and on one
  machine only. The import goes one way: Claude's memory stays the source, and each run rewrites the mirror under
  `topics/claude-memory/<project>/`. A memory Claude deleted turns `archived`. Set it up like this:

  ```toml
  [extras]
  claude_memory = true

  [claude_memory]
  projects = ["*"]                                # every project, or a list like ["~/Sites/shop"]
  exclude = []                                    # projects to leave out
  scope = "work"                                  # the scope of most projects
  scope_by_project = ["~/Sites/blog=private"]     # projects with another scope
  ```

  Agents write that memory themselves. So every mirrored note says it is not an instruction, links in it become
  plain text, and it counts 60 percent of an own note in the ranking (`imported_percent`). To import after every Claude Code session,
  add a `SessionEnd` hook to `~/.claude/settings.json` that runs
  `rcllr --root ~/brain import-memory --from-hook`. It imports only the project the session ran in and never
  blocks the session.
- **codex_memory**: the same for Codex. Codex keeps one memory for all projects and writes a summary per session
  under `~/.codex/memories/rollout_summaries/`, each naming the folder the session ran in. rcllr imports only the
  summaries whose folder lies in a listed project, into `topics/codex-memory/` with the scope `memory-codex`. Codex
  memories are off by default; turn them on in `~/.codex/config.toml` with `memories = true` under `[features]`.
  `--codex-home` (default `$CODEX_HOME` or `~/.codex`) points elsewhere. To import after every Codex session, add a
  `SessionEnd` hook to `~/.codex/config.toml`. Codex gives such a hook 3 seconds and waits for it, so start the import
  detached:

  ```toml
  [[hooks.SessionEnd]]
  [[hooks.SessionEnd.hooks]]
  type = "command"
  command = 'nohup rcllr --root "$HOME/brain" import-memory --serious >/dev/null 2>&1 &'
  ```

  Codex asks you once to trust a new hook. Its summaries appear some time after a session, so each run imports
  every listed project, not only the one that just ended.
- **routes**: a `routes.json` entry like
  `{"routes":[{"aliases":["meal plan"],"sources":"topics/meals/plan-*.md","scope":"private","kind":"dated-plan"}]}`
  lets `context "meal plan next week"` open exactly the plan files named `plan-2026-10-05-to-11.md` that
  overlap next week, and only their matching table rows. A route never opens the rest of the folder.
  An alias must contain a real word (three letters or more, not a filler word). A route opens sensitive
  plan files only with `"allow_sensitive": true` in its entry; without it the normal sensitivity rules apply.

## FAQ

**Can I keep my notes off GitHub?** Yes. Create the brain without `--remote`. A local brain commits every
change, but nothing ever leaves your machine. Back it up like any other folder.

**Can I use it at work?** Yes. Messages are plain by default. `tone = "cheeky"` in `[ui]` adds a short remark to
some of them; `--serious` turns it off for a single call. Error messages are equally precise in both tones.

**Does it send my notes anywhere?** Only to your own Git remote, by `git push`, and only in a synced brain.
rcllr has no other network code and no runtime dependencies beyond Node.js.

**How fast is it?** Fast enough for agents to query before every answer. On an Apple M5 Pro with Node 24,
`context` and `find` take about 0.13 s in a brain of 200 notes and 0.48 s with 2,000 notes. `read` takes
0.08 s at either size, and 0.02 s of every call is Node starting up. A real brain of 189 notes on a Mac
answers in 0.16 s. To measure your own machine, run `pnpm bench` in a checkout.

**Windows?** Yes. CI runs the test suite on Windows with Node 22 and 24. The Git hook and the agent hooks are shell
scripts, so they need the bash from Git for Windows. Write paths in `rcllr.toml` in single quotes or with forward
slashes, see [Configuration reference](#configuration-reference). New notes get mode `0600` on macOS and Linux only;
on Windows they inherit the folder's access rights, so keep the brain in a folder only you can read.

**Why does `read` say "unavailable" for a file I can see?** The file is sensitive, out of scope or outside
the note folders. rcllr gives the same answer in all three cases, on purpose. With a narrow `--scope`, the answer
adds that other scopes stay hidden; that hint depends only on your call, never on the file.

**Can two agents write at the same time?** Yes. A process lock serializes writes, and `--expected` rejects a
change based on an old revision. Across machines, a push that loses the race against another machine fetches,
rebases and pushes again, up to three times.

**Can I build my own frontend?** Yes. `@rcllr/core` (`npm install @rcllr/core`) is the library behind
the CLI. Read notes through its `Access` class: it applies the same scope, sensitivity and path rules as the
CLI. The package exports no raw note reader, so a frontend cannot skip those rules by accident.

## Coming from dummkopf

rcllr was called dummkopf up to version 0.4. The new version reads old brains as they are: it finds
`dummkopf.toml` when there is no `rcllr.toml`, reads `DUMMKOPF_ROOT` when `RCLLR_ROOT` is unset, and the
commands `dummkopf` and `dk` start rcllr. Both packages ship those two commands, so remove the old one first:

```bash
npm uninstall -g dummkopf && npm install -g rcllr
```

To move a brain to the new name:

```bash
cd ~/brain && rcllr migrate-name           # lists the steps, changes nothing
rcllr migrate-name --apply                 # renames dummkopf.toml, updates AGENTS.md and CLAUDE.md, reinstalls hooks
git commit -m "Rename to rcllr"            # rcllr commits only notes, the rest is yours
```

Notes stay untouched. `migrate-name` also lists files outside the brain that still call `dummkopf`, such as
`~/.claude/CLAUDE.md` or a skill, and a `DUMMKOPF_ROOT` in your environment. Change those by hand.

## Coming from the Python version

Releases up to 0.2.0 were written in Python and installed with `uv tool install`. The TypeScript version reads
the same brains: same `dummkopf.toml`, same folders, same frontmatter, same hooks. Nothing needs converting.

1. Install the new version as described in the [Quickstart](#quickstart-5-minutes).
2. Remove the old one: `uv tool uninstall dummkopf` (or `pipx uninstall dummkopf`).
3. The installed hooks call `dummkopf` by name, which now starts rcllr. To move to the new name, see
   [Coming from dummkopf](#coming-from-dummkopf).

## Development

The code lives in `packages/core` (library) and `packages/cli` (CLI). See [CONTRIBUTING.md](CONTRIBUTING.md)
for setup, tests and rules.

## License

MIT, see [LICENSE](LICENSE).
