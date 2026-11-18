# dsh-layout-governor

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that audits a **directory tree against a policy file** and reports what drifted — duplicate payloads, backups outside the archive root, unregistered large files, documentation that no longer matches the disk, and version families nobody cleaned up.

It is **read-only by design**. It never moves, deletes, renames, or writes a file in the tree it audits. It reports findings, and it generates a fix plan *as text* for a human to review.

```
$ layout-governor --root /mnt/d/studio

dsh-layout-governor 0.1.0
root:      /mnt/d/studio
policy:    layout.policy.yml (v1, sha256 cf5a76744960)
registry:  layout.registry.yml (present)

overall: FAIL   fail 51 | warn 3 | info 0

rules
  top-level    on   fail   0 finding(s)    0ms
  backups      on   fail  53 finding(s)  258ms
  duplicates   on   fail   0 finding(s) 1242ms
  families     on   warn   0 finding(s)   87ms
  large-files  on   fail   0 finding(s)   35ms
  docs         on   fail   0 finding(s)    2ms
  protected    on   warn   1 finding(s)  111ms

  1. [fail] backups:02aaea  Backup outside _archive: game/dev/_work/anvil/backup_20261118_1440
     Path segment "backup_20261118_1440" marks a backup, but the entry is not under
     _archive, which is the only declared home for backups.
     suggestion: move … to _archive/<YYYYMMDD>_<source>/
  …
 58. [warn] protected:918d48  Protected pattern has no matches: **/7705047215923976320*

stats:  entries 121743 (files 98924, dirs 22538, links 281), 77.6 GB, 35191 ms
composition
  Regenerable 19.7 GB · Backup 206 MB · Protected 232 MB · Canonical 57.4 GB
```

That is a real run, not an illustration: 51 scattered backups and one missing
irreplaceable original in a 96 GB tree, found in 35 seconds.

Note what is *green* there. `duplicates`, `large-files` and `families` report
zero because those three incidents were cleaned by hand on the day this plugin was
written. A rule that only ever fires is as useless as one that never fires; the
rules are calibrated to catch the regression, and the tests below prove they still
do.

## It runs itself

There is nothing to remember and nothing to type. The governor has three triggers,
and only the third is a person:

1. **On activation** it scans the default root, so the panel has something to draw
   the first time it is opened and a session that asks the tool does not pay for a
   cold walk.
2. **After every tool call that can write** (`write`, `edit`, `bash`, `pwsh`,
   `terminal`, a subagent, a worktree…) it arms one debounced re-scan. Twenty writes
   in a burst cost one walk, three seconds after the last one.

   An automatic scan is deliberately **bounded**: 6000 entries and depth 6, about
   one second on this machine, growing or shrinking toward that target as it learns
   the filesystem. It sees the top of the tree, where misplaced backups and stale
   documentation live, and the panel says so. The unbounded, full-hash pass is what
   `layout_audit` and `--check` do when you ask. A full walk of a 150k-entry DrvFs
   tree is 35–55 s of pinned disk; making that automatic would be a defect, and it
   was one until it was measured. The watcher is
   `tools/result`; it never inspects arguments, because "this tool may have written"
   is enough to justify looking again.
3. **When you ask** — `layout_audit`, the sidebar panel, or the CLI. The panel also
   re-reads the Host cache every 15 seconds while it is visible, so it converges on
   its own.

With `autofix` enabled in the policy, a trigger-driven scan also performs the
reversible half of the plan: misplaced backups move to
`_archive/YYYYMMDD_<source>/`, with a `moves.jsonl` log and an `undo.sh` beside
them. Deletions, document edits and registry entries stay human. See
[`docs/policy.md`](docs/policy.md#autofix).

Nothing above needs a flag. The flags exist for the CLI, where a flag is a normal
thing to type.

## Why this exists

A real 96 GB working tree drifted into these six states. Each one is a test fixture in this repository:

| Incident | What the governor does |
|---|---|
| The same `install.wim` existed three times, byte-identical, holding 9.4 GB | Groups files by size then SHA-256; a group above `maxCopies` fails, and the suggestion names the copy to keep |
| One image directory held four ISOs (two originals, two abandoned rebuilds) | Groups a glob into version families per directory; above `maxPer` warns and marks the older members superseded |
| Backups scattered as `_backup/`, `_rescue_*`, `*.bak.*`, `_work/*/backup_*` | Only `_archive/YYYYMMDD_<source>/` is legal; legacy in-place **symlinks** pointing into the archive are tolerated at `warn` instead of failing |
| The top-level `README.md` still described directories renamed months earlier | Extracts the top-level entries the README claims, compares both directions with the disk |
| Fully transcribed raw footage that nobody dared delete, and one author-pulled original | `classification.regenerable` vs `classification.protected`; the fix plan never proposes deleting a protected path |
| A 29 GB virtual disk that was never registered anywhere | Every file above `large-files.minBytes` must have a `layout.registry.yml` entry, and stale entries are reported too |

Every rule is a policy switch, and that is load-bearing: see [negative controls](#negative-controls).

## Install

```bash
# from a checkout
dsh plugin add /absolute/path/to/dsh-layout-governor
```

or, inside a Harness session, install the bundle through the plugin manager with the package directory as the target. The bundle inserts one Host row and one Client module:

| Half | What it adds |
|---|---|
| Host (`lib/index.js`) | the `layout_audit` tool and the `POST /api/layout-governor/report` route |
| Client (`lib/client.js`) | a **Layout** panel in the right sidebar: space composition, findings, and which rules produced them |

Row configuration is optional:

```yaml
- override:
    - id: layout-governor
      config:
        root: /mnt/d/studio          # default: the session's working directory
        policy: layout.policy.yml    # default: <root>/layout.policy.yml
        registry: layout.registry.yml
        maxEntries: 400000
        hashConcurrency: 4
        cacheMs: 30000               # panel refreshes reuse a recent scan
```

## CLI

The engine has no runtime dependencies, so the CLI runs straight from a checkout:

```bash
node bin/layout-governor.mjs --root /mnt/d/studio --format text
node bin/layout-governor.mjs --root . --fix-plan          # adds the dry-run plan
node bin/layout-governor.mjs --root . --rule duplicates --rule backups
node bin/layout-governor.mjs --root . --format json | jq .findings
node bin/layout-governor.mjs --root . --check              # exit 1 when overall=fail
```

| Flag | Meaning |
|---|---|
| `--root DIR` | tree to audit (default: current directory) |
| `--policy FILE` | policy file (default: `<root>/layout.policy.yml`) |
| `--registry FILE` | large-file registry (default: `<root>/layout.registry.yml`) |
| `--format json\|text\|md` | output form |
| `--fix-plan` | append the generated plan: markdown table + a shell script |
| `--check` | exit `1` when `overall` is `fail`, `0` otherwise, `2` on engine error |
| `--rule ID` | run only these rules (repeatable) |
| `--concurrency N` | filesystem operations in flight for both the walk and hashing (default 16) |
| `--all-off` | force every rule off — the negative control, expected to be green |

Wire it into `pre-commit`, a cron job, or CI: `--check` turns the policy into a gate.

## The tool the agent gets

`layout_audit` — read-only audit of a tree.

```jsonc
{
  "root": "/mnt/d/studio",        // defaults to the session working directory
  "rule": ["duplicates"],         // optional rule filter
  "fixPlan": true,                // append markdown + a shell script (never executed)
  "format": "markdown",           // markdown | text | json
  "force": true                   // bypass the 30 s report cache
}
```

The tool description tells the model to run it *before* reorganizing, deduplicating or deleting in a workspace, and that the plan it returns must be reviewed rather than run blind. The panel and the tool read the same Host route, so they cannot disagree.

## Policy

`layout.policy.yml` is the single place where "where does this belong?" and "may it be deleted?" are answered. Field-by-field reference: [`docs/policy.md`](docs/policy.md).

```yaml
version: 1
ignore: ['**/node_modules/**', '**/.git/**']

rules:
  duplicates:
    enabled: true
    severity: fail
    minBytes: 104857600
    maxCopies: 1
  backups:
    enabled: true
    severity: fail
    allowedRoots: ['_archive']
    forbidNames: ['_backup', '_rescue_*', '*.bak.*', 'backup_*']
    legacySymlinks: warn
```

Turning a rule off removes its findings entirely — the audit then reports `pass` for that rule rather than a stale constant. That property is tested, not asserted.

## Rules

| id | Question | Default |
|---|---|---|
| `top-level` | Is this top-level entry part of the declared map? | `fail` |
| `backups` | Is this backup in `_archive/YYYYMMDD_<source>/`? | `fail` |
| `duplicates` | Are these files the same bytes? | `fail` |
| `families` | Are these several revisions of one artifact? | `warn` |
| `large-files` | Is this big file registered with a purpose? | `fail` |
| `docs` | Does the README describe the disk that exists? | `fail` |
| `protected` | Is the irreplaceable thing still there? | `warn` |

Adding a rule is two files: `lib/engine/rules/<id>.js` exporting
`{ id, defaults, run(ctx) }`, plus one registry line in `lib/engine/index.js`. A
rule reads its own `enabled` and `severity` from `ctx.rule(id)` and returns `[]`
when disabled — the orchestrator calls it regardless, so the negative control
tests gating and not the orchestrator's mood.

Each rule also takes an `ignore: []` list of globs, which is how a policy exempts
vendored third-party trees (`whisper.cpp` ships a `backup_rules.xml`; KVMANGER's
upstream tests ship seven deliberately fake ISOs) without weakening the pattern
for everybody else.

## Negative controls

An audit is worthless if it cannot go green. `npm test` builds the six incidents in a temporary tree and asserts:

1. **clean** fixture → `overall: "pass"`, zero findings;
2. each incident fixture → exactly its own rule fires;
3. `studio-mini` (all six incidents in one tree) → all six fire, `overall: "fail"`, every finding has an executable `command`;
4. **every rule disabled** — both via `allRulesOff` and via a policy file with `enabled: false` everywhere → counts all zero, `overall: "pass"`;
5. `protected` paths never appear in a `rm` command; the generated script starts with `set -eu`;
6. an aborted signal throws cleanly, and a symlinked directory is never followed out of the tree;
7. a fenced rename table is read as history, while an unfenced stale claim still fails.

`npm test` currently runs **104 tests: 102 pass, 2 skipped** (the two that compare
the bundled YAML subset against the optional `yaml` package, which is not
installed). Coverage is 94.5 % of lines and 78.4 % of branches; the gaps and the
rest of the review are in [`docs/quality.md`](docs/quality.md). Several files test
the plugin halves themselves rather than the engine:

- `test/host-module.test.mjs` drives the real `apply()` with a recording context,
  then calls the registered tool and the registered `/api` route against a dirty
  tree — including the case where the tool refuses a root that does not exist, so a
  typo cannot come back as "compliant";
- `test/client-module.test.mjs` loads `lib/client.js` through
  `window.__ModuleLoader__` with a stub React and asserts the panel registers once
  into `sidebar.panellist`, resolves its label, ships matching `en`/`zh`
  dictionaries, and renders every state instead of throwing;
- `test/report-cache.test.mjs`, `test/host-root.test.mjs` and
  `test/walk-observability.test.mjs` cover the three places where a wrong answer is
  quiet: a stale report, the wrong root, and a directory that could not be read.

`npm run check` runs the whole thing plus `scripts/check-code.mjs`, a mechanical
review that fails on a file that does not parse, a runtime file over 600 lines, a
console write outside the CLI, a harness import in the bundle, a rule module that
lost its `{ id, defaults, run }` shape, or a statement that does not end the way
every other statement in the package ends.

Point 4 is the one that matters: if a plugin still reports red with its rules turned off, it is auditing its own constants instead of reality.

## Layout

```
lib/index.js             Host wiring only: resolve, cache, register
lib/host/audit-tool.js   the `layout_audit` tool definition
lib/host/report-route.js the POST /api/layout-governor/report route
lib/host/report-cache.js freshness window + in-flight de-duplication
lib/host/root.js         which tree does "here" mean
lib/client.js            Client: the sidebar panel (single file by loader design)
lib/engine/index.js      audit() / buildFixPlan() / formatReport()
lib/engine/rules/*.js    one file per rule, each `{ id, defaults, run }`
lib/engine/walk.js       bounded-concurrency traversal
lib/engine/yaml-lite.js  minimal YAML subset, used when `yaml` is absent
bin/layout-governor.mjs  the CLI
scripts/check-code.mjs   mechanical review, wired into npm run check
layout.policy.yml        the studio policy this was written for
layout.registry.yml      registered large files
fixtures/build.mjs       programmatic incident fixtures (no binaries in git)
test/                    node --test, 78 tests
docs/policy.md           field-by-field policy reference
docs/quality.md          the self-review: measurements, defects, accepted debt
```

## Why it is read-only

A governor that deletes is a governor nobody trusts with a `raw/` directory. The
engine opens files for hashing, reads the README, and writes only to stdout. The
fix plan is a markdown table plus a `set -eu` script that a human reads first; the
protected patterns from the policy are excluded from every `rm` and `mv` in it, and
`npm test` fails if that ever stops being true.

The audit never runs itself on a schedule either. Run it when you are about to
reorganize, or gate it with `--check` in CI, which is where a failing audit
actually stops something.

## Limits

- Content comparison is exact-hash only; near-duplicates and re-encoded media are out of scope (that is `czkawka`/`fclones` territory).
- The walk does not follow directory symlinks, so a tree reachable only through a symlink is invisible to it.
- Sizes come from `stat`; a sparse or reflinked file is charged its apparent size.
- A very deep tree hits `maxDepth` (16) and the report says `truncated`; raise it
  in `limits` when the full depth matters.
- `docs` reads backticked `` `name/` `` tokens outside fenced blocks. A README that
  mentions a retired name in prose needs that name in `rules.docs.ignore` — the
  policy owns the vocabulary.
- The fix plan is a suggestion generator. Applying it stays a human decision, which is the point.

## Review

[`docs/quality.md`](docs/quality.md) is the package's own review: the measured
coverage, the twelve defects that review found in this code, what each fix is
guarded by, and the debt that is still here. Two of those defects were wrong
answers rather than untidy code — a missing root that reported `pass`, and an
unreadable directory that was silently skipped — which is the only kind of defect
worth writing a gate for.

## License

MIT.
