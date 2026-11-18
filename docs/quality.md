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

## What is still not good

Stated plainly, because a review that finds nothing is a review that did not look.

- **`lib/client.js` is 594 lines in one file.** The Web loader hands a client
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
