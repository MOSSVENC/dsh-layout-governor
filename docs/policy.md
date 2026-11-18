# Policy reference

Two files describe a tree. Both are optional; without them the governor runs with
no rules enabled and reports `pass`, which is the correct answer to "is this tree
compliant with a policy that does not exist?".

- `layout.policy.yml` — where things belong, and which of the seven rules are on.
- `layout.registry.yml` — every large file that is allowed to stay, with a purpose.

Both are plain YAML. The engine prefers the [`yaml`](https://www.npmjs.com/package/yaml)
package when it is installed and falls back to a bundled minimal parser for the
subset below, so the CLI works from a bare checkout.

## layout.policy.yml

```yaml
version: 1
ignore:                       # global: excluded from the walk, so from every rule
  - '**/node_modules/**'
  - '**/.git/**'

rules:
  <rule-id>:
    enabled: true             # false ⇒ the rule produces no findings at all
    severity: fail            # fail | warn | info
    # …rule-specific fields
classification:
  regenerable: ['**/.venv/**']
  protected: ['**/U218*']
```

### Severity

| value | `overall` effect | meaning |
|---|---|---|
| `fail` | `overall: fail` | the tree contradicts a rule that was declared binding |
| `warn` | `overall: warn` | drift worth a decision, not necessarily wrong |
| `info` | no effect on `overall` | accepted, but reported |

`overall` is `fail` if any finding is `fail`, else `warn` if any is `warn`, else
`pass`. Each rule's `severity` overrides its default; a single finding can also be
raised to the rule's own severity by the rule itself.

### `top-level`

Which first-level entries are allowed to exist.

| field | type | default |
|---|---|---|
| `allow` | string[] | `[]` |
| `allowPatterns` | string[] (regex) | `[]` |
| `ignore` | string[] (glob) | `[]` |

A first-level entry passes when it is listed in `allow`, matches one of
`allowPatterns`, or matches `ignore`. Anything else is a finding.

### `backups`

Where a backup is allowed to live.

| field | type | default | meaning |
|---|---|---|---|
| `allowedRoots` | string[] | `['_archive']` | path prefixes that may contain backups |
| `allowedNamePattern` | string (regex) | — | the entry directly under an allowed root must match, e.g. `^[0-9]{8}_[a-z0-9_-]+$` |
| `forbidNames` | string[] (glob) | `['_backup', '_rescue_*', '*.bak.*', 'backup_*']` | names that are never a valid backup location outside the allowed roots |
| `legacySymlinks` | `allow` \| `warn` \| `fail` | `warn` | a symlink with a forbidden name that resolves **into** an allowed root is a legacy pointer, not a copy |
| `ignore` | string[] (glob) | `[]` | paths exempt from this rule, e.g. a vendored tree that ships a `backup_rules.xml` |

A directory named `_backup` that is a symlink into `_archive/` therefore reports
`warn` by default: the copy already lives in the right place, only the pointer is
old. A real directory of backups there is `fail`.

### `duplicates`

Content equality.

| field | type | default |
|---|---|---|
| `minBytes` | integer | `104857600` |
| `maxCopies` | integer | `1` |
| `ignore` | string[] (glob) | `[]` |

Files are grouped by exact size first; only groups with at least two members at or
above `minBytes` are hashed (SHA-256, streamed). A group whose copy count exceeds
`maxCopies` is a finding. The suggestion keeps the newest file and breaks ties on
the shortest path, then lexicographic order.

### `families`

Several revisions of one artifact.

| field | type | default |
|---|---|---|
| `groups` | object[] | `[]` |
| `groups[].match` | glob | — |
| `groups[].maxPer` | integer | `1` |
| `groups[].groupBy` | `dir` | `dir` |
| `ignore` | string[] (glob) | `[]` | paths exempt from this rule; upstream test fixtures that ship several tiny ISOs belong here |

Files matching `match` are clustered per directory; more than `maxPer` in one
cluster is a finding and the oldest members are the ones suggested as superseded.
The shipped policy allows two ISOs per image directory, because an original and one
rebuild is a legitimate pair.

### `large-files`

Registration.

| field | type | default |
|---|---|---|
| `minBytes` | integer | `1073741824` |
| `registry` | string | `layout.registry.yml` |

Every file at or above `minBytes` must be covered by a registry entry (exact
relative path or glob). Unregistered is a finding; a registry entry whose file is
gone is also a finding, so the registry cannot rot silently.

### `docs`

Documentation against disk.

| field | type | default |
|---|---|---|
| `file` | string | `README.md` |
| `ignore` | string[] (glob) | `[]` | names exempted on both sides of the comparison |

The governor reads backticked tokens of the form `` `name/` `` — a single path
segment ending in a slash — as the set of top-level entries the document claims.
Fenced code blocks are removed first: a rename table such as

```
quill/   -> writings/writer
```

is history, not a claim about the current root. A retired name that appears in
prose outside a fence has to be listed in `ignore`; the vocabulary of retired
names is a policy decision, not something a parser should guess.
A claim with no directory on disk is `fail`; a first-level directory the document
never claims is `warn`. A missing document is one `warn`, not a crash.

### `protected`

The irreplaceable things.

| field | type | default |
|---|---|---|
| `patterns` | string[] (glob) | `[]` |

Each pattern must match at least one existing path. A pattern that matches nothing
means the only copy is gone, so it is reported at the rule's severity
(`warn` by default). Protected paths are also excluded from every destructive
action in the fix plan, always, regardless of this rule's state.

### `classification`

Not rules — labels that drive the panel's space composition and the fix plan's
risk column.

```yaml
classification:
  regenerable: ['**/.venv/**', '**/node_modules/**', '**/_scratch/**']
  protected: ['**/U218*']
```

A path that matches `regenerable` is a rebuildable environment or scratch output.
`protected` is the opposite. Everything else inside the tree is `canonical`;
paths under an `allowedRoots` entry are `backup`. The panel colours the four
classes and the CLI prints their byte totals, so "what is actually using the disk"
has one answer.

## layout.registry.yml

```yaml
version: 1
entries:
  - path: mining/worker/cs2-gpupv/vm/win11.vhdx
    bytes: 31138512896
    purpose: Windows GPU-PV guest disk
    externalizable: false
    protected: false
    note: the VM must be stopped before this file can move
```

| field | required | meaning |
|---|---|---|
| `path` | yes | path relative to the audited root, or a glob |
| `bytes` | no | recorded size; a mismatch is reported as drift |
| `purpose` | yes | why this file is allowed to exist here |
| `externalizable` | no | `true` when it may move to another volume behind a symlink |
| `protected` | no | `true` when there is no second copy anywhere |
| `note` | no | operational caveat for whoever moves it |

Registering a file is not permission to delete it. It is a statement that someone
knows what it is for.

## Concurrency

`walkConcurrency` (row config, default `16`) bounds the directory walk and the
hashing pool. On a local SSD the walk is CPU-bound and the knob barely matters; on
a 9p/DrvFs mount every `lstat` is a round-trip and the same 100k-file tree takes
355 s serially versus 35 s at 16. `hashConcurrency` overrides the hashing pool
alone when the two need to differ.
