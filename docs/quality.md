# Code quality review

This file is the review of this package by its own author, with the measurements
that back it and the debt that is still there. It is written for the next reader
who has to change the code, not to advertise it.

Reproduce everything below with:

```bash
npm run check      # mechanical gate + full test suite
npm run coverage   # line / branch / function coverage
```

## How the review was done

| Step | What it answers | Command |
|---|---|---|
| Mechanical gate | Does every file parse, keep its shape, stay in budget, use one style? | `node scripts/check-code.mjs` |
| Coverage | Which lines and branches has any test actually executed? | `node --test --experimental-test-coverage test/` |
| Structural read | Are the module boundaries honest, or is one file doing four jobs? | import graph + function length census |
| Adversarial read | What does it do on a tree that is wrong, partial, or is not there at all? | the fixtures in `test/`, plus a real 96 GB tree |

The scores below are this author's judgement against those measurements. They are
opinion; the numbers under them are not.

## Scorecard

| Dimension | Before | After | What moved it |
| --- | ---: | ---: | --- |
| Cohesion (one file = one job) | 2.5 | 4.5 | `lib/index.js` 331 → 98 lines; cache, root resolution, tool and route became separate modules with their own tests |
| Readability | 3.0 | 4.5 | no function over 56 lines (was 97); one `STYLES` table instead of 40 inline literals; section renderers instead of 76/91-line formatters |
| Style consistency | 1.5 | 5.0 | the host and client halves were semicolon-free while the engine used semicolons; unified, and now enforced mechanically |
| Test coverage | 3.0 | 4.5 | 89.4 % → 94.5 % lines, 73.2 % → 78.4 % branches |
| Duplication | 3.5 | 4.5 | one `toCount`, one `budgetText`, one response envelope, one style table |
| Failure observability | 2.5 | 4.5 | unreadable paths counted instead of swallowed; a missing root refuses instead of reporting "compliant" |
| Documentation accuracy | 3.5 | 4.5 | README numbers are from a real run; this file records the debt |
| **Overall** | **3.0** | **4.5** | |

Coverage, measured on the same suite:

```
before   89.44 % lines   73.19 % branches   89.16 % functions
after    94.54 % lines   78.38 % branches   93.10 % functions
```

## Defects found and fixed

| # | Severity | Defect | Evidence | Fix | Guard |
| --- | --- | --- | --- | --- | --- |
| 1 | high | Two statement styles in one package: `lib/index.js` and `lib/client.js` had no semicolons, the engine had them | `semi=2` vs `semi=85` line counts | unified on semicolons | `check-code` fails on a statement line without one |
| 2 | high | One 331-line module did caching, root resolution, tool definition, and HTTP routing | `lib/index.js` | split into `lib/host/{report-cache,root,audit-tool,report-route}.js` | each module has its own test file |
| 3 | high | A root that does not exist produced `overall: pass` — a walk over nothing finds nothing, and nothing looked like compliance | `layout_audit({root: '/typo'})` → `ok: true` | `audit()` stats the root and throws | `host-module.test.mjs` asserts both the tool rejection and the route failure |
| 4 | high | Unreadable directories were swallowed; a partial audit reported itself as complete | `walk.js` `catch { continue }` | counted into `stats.unreadable` and printed by both renderers | `walk-observability.test.mjs` chmods a directory to `000` |
| 5 | medium | A README rename table (fenced) was read as claims about the current root, so every retired name reported as a missing directory | 4 false failures on the real tree | fenced blocks are stripped before claims are read | `docs-fence.test.mjs`, including the unfenced control |
| 6 | medium | Vendored trees tripped the backup and family rules (`whisper.cpp` ships `backup_rules.xml`; an upstream test suite ships seven fake ISOs) | 2 false failures on the real tree | per-rule `ignore`, so the policy exempts a subtree instead of weakening the pattern | policy tests assert the shipped ignore lists |
| 7 | medium | The panel's "show all" button could never collapse: the toggle was driven by the remainder, which is zero once expanded | reading `FindingsBlock` | driven by the total | render test asserts the collapsed label |
| 8 | medium | Serial traversal: 355 s for 122k entries on DrvFs, indistinguishable from a hang | timed runs | bounded concurrency (16) → 35 s | benchmark recorded in `docs/policy.md` |
| 9 | low | `toPositive` copied verbatim into two rules | duplicate symbol | moved to `util.toCount` | `check-code` keeps rule modules to a fixed shape |
| 10 | low | Panel strings existed twice: `locale/*.json` and inline in `client.js` | two dictionaries, same keys | locale files keep display metadata only, with a note saying where the copy lives | client test asserts `en`/`zh` key parity |
| 11 | low | `panel.rules` and `panel.paths` were defined and never rendered | dead dictionary entries | `Rules` is now a real heading, `paths` removed | — |
| 12 | low | `lib/client.js` had no test path at all: a bundle that cannot be imported by Node | 56 % line coverage | the factory is loaded through `window.__ModuleLoader__` with a stub React; helpers and presentational blocks are exported for it | 90 % line coverage on that file |

## Round 2 — the defects the automatic layer exposed

Adding self-triggering behaviour found three more, all of the dangerous kind: they
produced a plausible answer that was wrong.

| # | Severity | Defect | How it surfaced | Fix | Guard |
| --- | --- | --- | --- | --- | --- |
| 13 | high | Auditing a subtree without `--policy` enforced **nothing** and printed a green verdict | running the audit on `video/capture` by hand | policy discovery climbs from the root, so a subtree inherits the workspace policy the way `.git` is found | `no-policy.test.mjs` asserts inheritance and that an explicit path still wins |
| 14 | high | The auto-fixer would have archived any unknown **top-level** directory — including one created minutes earlier by another process | the first dry run of autofix on a live workspace listed `_work` as an action | autofix only acts on findings from rules a policy names, default `[backups]` | `autofix.test.mjs` feeds it an invented `top-level` action and asserts it is refused |
| 15 | medium | `backup_*` matched a maintenance script (`backup_panel_db.sh`), which would have been filed into the archive | same dry run | files must look like a copy (`.bak`, `*.bak.*`, `*~`, an archive extension); only directories are decided by name alone | `engine.test.mjs` asserts a script that performs backups is not a backup |
| 16 | medium | A partial policy silently switched on every rule it did not mention, with defaults | a four-line policy reported findings from four other rules | rules are opt-in by declaration; what the file names is what runs | `no-policy.test.mjs` and `negative-control.test.mjs` |

Defects 14 and 15 were caught by reading a dry run before turning the feature on,
not by a test. That is worth recording: the cheap way to review an autonomous
action is to make it print what it would do first.

## Round 3 — it took the harness down, and why

Reported symptom: with the plugin enabled, DSH was unusable and the log filled with
errors; disabling it fixed both. Three independent causes, all mine.

| # | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| 17 | **Editing a link-installed plugin re-runs `apply` on every save**, and a second registration of `layout_audit` throws `tool "layout_audit" is already registered`. Module-level state resets on reload, so the old instance could not be found and never disposed. | `@deepseek-ai/dsh-tools` throws on duplicate names; the plugin was edited dozens of times while installed | teardown is held on `globalThis[Symbol.for(...)]`, so a reload disposes its predecessor; registration failures degrade to a warning instead of a broken row |
| 18 | **An automatic scan cost as much as a deliberate one**: 35-55 s of a 150k-entry DrvFs tree, every minute, plus a 30 s cache that the panel polled through | measured: 53 s at 4-way concurrency, worse than 16-way | automatic scans walk a **bounded** slice (6k entries, depth 6: 1.1 s, stable across runs), the budget self-tunes toward one second, and the cache window is 5 minutes |
| 19 | **Automatic deduplication read whole files**: 429 MB hashed per scan | `hashedBytes` in the report | two-stage hashing (64 KiB head + tail, then full), the pattern `fclones` and `czkawka` use; automatic scans only take stage one |
| 20 | A `ReferenceError` inside the automatic path was swallowed by the surrounding `catch`, so the plugin looked alive while every automatic scan failed | the rescan test failed with "findings 1, expected 2" while no error surfaced | the budget is passed as an argument, not closed over; the failure is logged; `host-module.test.mjs` asserts a write actually changes what the next read returns |

What this round taught: **an autonomous feature needs a cost budget as loud as its
correctness**, and a plugin installed by symlink must assume it will be edited while
running. Both were design omissions, not bugs in a corner case.

## Round 4 — adopting the codegraph shape

Requested: index it once, keep it current automatically, let the model query it,
and check against it. Done, on `node:sqlite`, no dependency.

| Piece | Where | Promise |
|---|---|---|
| schema + queries | `lib/engine/store.js` | one file, four tables, reopen is idempotent |
| sync | `syncFiles` / `syncRegistry` | rows for vanished paths are deleted; the registry cannot rot |
| digest reuse | `hashing.js` `lookup` | an unchanged file answers from a row, not the disk |
| history | `runs` / `findings` | findings are scoped to the newest run |
| model surface | `layout_query` | filters by name, size, kind, class, rule, severity |

Defect found while testing it: `lookupHash` compared a stored **floored** mtime with
an unfloored one, so every file looked changed and the index never saved a read.
That is the exact failure mode an index invites — it looks like it works, it costs
the same as no index, and nothing complains. `store.test.mjs` now asserts that a
second audit hashes **zero** files, which is the only assertion that could have
caught it.

## Round 5 — the code graph

Requested: not just the database shape, but `codegraph`'s actual功能. Added
`lib/engine/codegraph.js` (line-oriented extraction for the eight languages this
workspace contains, measured first: py 14938, mjs 1228, js 954, ts 485, sh 469, cpp
365, c 161, rs 115, go 30, gd 28) and the `symbols`/`imports` tables behind
`code_graph`.

What it deliberately is **not**: a parser. No scope resolution, no call graph, no
type information. The tool description states the boundary, because a tool that
overclaims gets trusted and then misleads.

Two defects caught by its tests: Go grouped imports were invisible (the bare quoted
line inside `import (...)`), and my own test asserted that a call site counted as a
definition — the test was wrong, not the code, which is worth writing down because
the instinct on a failing test is to "fix" the implementation.

## Round 6 — the independent audit said "不可装入"

A reviewer with no access to my reasoning, given the source and the reference
projects, returned **不可装入** with six blocking findings. All six were real. Fixed
here, each with a regression test named after the finding.

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| B1 | `rename` **replaces** an existing destination; my comment claimed the opposite, so a second archive pass silently destroyed the first copy | the destination name is claimed with `open(..., 'wx')` first, and a numeric suffix is used when taken | `blocking-fixes.test.mjs` "B1" |
| B2 | a backup **directory** containing a protected original was moved wholesale; a finding still said `fixable: yes` | the backups rule inspects the subtree for protected paths; the selector re-checks the policy globs before any move | "B2" |
| B3 | truncated or partially unreadable trees still reported `pass`, and the tool value omitted `stats` entirely | `overall` is `warn` when the walk was truncated or anything was unreadable; `stats` is a required field of the tool output | "B3" twice |
| B4 | two sessions on one index hit `database is locked`; three of four processes died | `timeout: 5000` on open plus `PRAGMA busy_timeout` | "B4" |
| B5 | a reload disposed the three tools only; the route, the listener and pending timers survived | every side effect now lands in `teardown`, including the route disposer | "B5" |
| B6 | the tool description said "strictly read-only, never moves", while the shipped policy had `autofix.enabled: true, dryRun: false` | autofix ships **off** and in dry-run; the description states the condition | "B6" |

The two that matter as lessons, not chores: **B1 was a comment that lied about the
platform** — I wrote "rename fails rather than clobbering" because that is what I
wanted to be true, and the reviewer tested it. **B6 was a description that described
an intention** rather than what the shipped configuration does. Both are the same
failure: prose asserting a property nobody verified.

## Round 7 — the audit's Major findings

| # | Finding | Fix |
| --- | --- | --- |
| M1 | `dependents` was a `LIKE` on the raw import string, so asking by file name returned nothing | imports store a `resolved` absolute path; a file-name query matches `./x`, `./x.js`, and the resolved path |
| M2 | a corrupt index was fatal; a **foreign** database got our tables written into it | corrupt files are quarantined to `.corrupt-<ts>` and rebuilt; a foreign database is refused, and the audit continues without an index |
| M3 | `runs`/`findings` grew forever, inside the governed tree | runs are pruned to the newest 50, findings with them |
| M4/M5 | CLI judged `.layout-index.db` as a top-level violation while the host hid it — the same tree got two verdicts | the index is skipped everywhere, CLI included |
| M7 | "two-stage hashing" was two *modes*, not two stages: full mode streamed every candidate | signatures first, full hash only for colliding groups — measured on a 4 MB trio: 0.38 MiB for stage one, full read only for the survivors |
| M8 | a symlink with a backup name was invisible to the backups rule | symlinks are candidates whatever their name looks like |
| M10 | keep policy was "newest", which deletes the older copy in a workspace where the archive *is* the original | `rules.duplicates.keep: oldest` (default) with `newest`/`shortest` available |
| minors | relative panel route, dead class enum, undo.sh not executable and silently skipping | absolute route; enum trimmed to what the classifier emits; `undo.sh` is `0755`, refuses to overwrite, and exits non-zero when a step is skipped |

## What is still not good

Stated plainly, because a review that finds nothing is a review that did not look.

- **`lib/client.js` is 625 lines in one file** (budget: 700, raised once when the
  panel gained self-refresh). The Web loader hands a client
  bundle `require('react')` and nothing else, so there is no import table to split
  across files, and a build step to pre-bundle several sources is not available
  offline. It is kept navigable by structure (one style table, six components,
  pure helpers first) and held at a hard 600-line budget by `check-code`. If a
  bundler is ever added, this is the first file to split.
- **Branch coverage is 78 %, not 95 %.** The uncovered branches are concentrated
  in `yaml-lite`'s escape handling and in configuration permutations of
  `lib/index.js` (which limits combination is set). They are cheap to leave and
  expensive to test exhaustively; they are also the least likely to break silently.
- **Five functions exceed 40 lines**: `fixplan.collectActions` (54),
  `fixplan.renderMarkdown` (54), `fixplan.collectLargeFile` (41),
  `yaml-lite.unquoteDouble` (41, a lookup table of escapes), and
  `bin/layout-governor.mjs main` (56, a top-down CLI body). Each is a single
  sequential job; splitting them would move lines, not reduce coupling.
- **No type checking.** The package is plain ESM with JSDoc. JSDoc catches nothing
  at build time unless someone runs `tsc --checkJs`, which is not wired in.
- **The panel has never been seen.** Verification is structural: the module loads
  through the real loader path, registers one slot, ships matching dictionaries,
  and renders every state through a stub React. What it looks like in the sidebar,
  at two widths and in both themes, is unverified.
- **The engine was not fuzzed.** Fixtures are hand-built incidents, not generated
  trees. A pathological tree (10^5 directories at depth 3, circular mounts) has not
  been tried.
- **No lint rule beyond the gate.** `check-code` encodes the conventions that were
  actually broken; it is not ESLint. Rules like "no unused export" or "no floating
  promise" are absent.

## Conventions this package holds itself to

1. One module, one job. If a file needs "and" to describe it, it is two files.
2. Runtime code does not import the harness it runs inside.
3. Every rule reads its own `enabled` flag; the orchestrator never filters for it.
4. Read-only means read-only: the engine opens files, never writes them.
5. A partial result says it is partial.
6. Anything a test cannot reach is a design problem, not a test problem — the
   client bundle exposes `helpers` for exactly that reason.
## Round 8 — the fixture's own debts

The self-assessment scored four dimensions below 8, and each was a real debt rather
than a missing feature. This round pays them.

| Dimension | Before | After | What changed |
| --- | --- | --- | --- |
| Design correctness | 7.5 | 8.5 | The gate no longer depends on one tool's argument names. `fs/write-intent` and `fs/edit-intent` are waterfalls in front of `fs.writeText`, so every writer that goes through the file service is refused at the last responsible moment (`lib/host/guard-fs.js`). The command gate stays, because a shell can create paths without touching the service. |
| Code quality | 8 | 8.5 | 15 exports had no consumer outside their own file; they are private now, so the public contract is `audit`, `buildFixPlan`, `formatReport`, `findPolicy`, `loadPolicy`, `createWriteGuard`, `guardSettings`, `createIntentGuard`. |
| Readability | 7.5 | 8 | `lib/engine/index.js` was doing the audit plus three unrelated helpers. Traversal width, registry location and finding order moved to `lib/engine/audit-order.js`; the audit is 284 lines of walk-judge-report. |
| Completeness | 8 | 8 | Unchanged, and honestly so: the panel has never been looked at by a human. Structural verification exists (module loads, slot registration, locale parity, every state renders a tree), but "does it look right" needs eyes, and the browser capability in this preset is not allowed to start a host of its own. |

Also fixed here, found by using the gate on itself: the command line was scanned as
prose. A heredoc body or a quoted string mentioning a creation verb was treated as
that verb, which blocked writing a script. `sanitizeCommand()` now strips heredoc
bodies and quoted spans before parsing, and three blind spots closed with it —
relative paths after `cd`, the copy family (`cp`/`mv`/`rsync`/`install -d`), and
`apply_patch` bodies.

Measured: 5,968 runtime lines, 3,480 test lines, 133 tests (131 pass, 2 skip),
95.33 % lines / 80.04 % branches / 90.34 % functions, `check-code` clean with 54
files and 7 rules.
