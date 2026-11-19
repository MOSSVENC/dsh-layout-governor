/**
 * The layout index: one SQLite file the governor writes, the model queries, and
 * the checker validates against.
 *
 * The architecture is lifted from `colbymchenry/codegraph` and
 * `CodeGraphContext/CodeGraphContext`: build an index once, keep it in sync
 * incrementally as the tree changes, and let an agent read the index instead of
 * re-grepping the world. The nodes here are paths rather than functions, because
 * this plugin governs layout, not code structure — but the shape is the same:
 *
 *   files      one row per path, with the content hash and its strength
 *   runs       one row per audit, with the verdict it reached
 *   findings   one row per finding, attached to the run that produced it
 *   registry   the declared purpose of the files that are allowed to be large
 *
 * `node:sqlite` is built into Node 22+, so this costs no dependency and no
 * native build — the same reason codegraph ships its own runtime.
 */

import path from 'node:path';
import { renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Schema version; bump when a table changes, and add the matching migration. */
export const SCHEMA_VERSION = 2;

/**
 * Column additions since version 1.
 *
 * A derived index could simply be rebuilt, but losing the run history for a
 * one-column addition is a poor trade: an upgrade should cost a statement.
 */
const COLUMN_MIGRATIONS = [
  { version: 2, table: 'imports', column: 'resolved', ddl: 'ALTER TABLE imports ADD COLUMN resolved TEXT' },
  // Stage-one signatures are worth keeping too: without them a second audit still
  // reads 128 KiB of every large file, which is exactly what the index is for.
  { version: 2, table: 'files', column: 'sig', ddl: 'ALTER TABLE files ADD COLUMN sig TEXT' },
];

/** Tables and indexes. `IF NOT EXISTS` keeps opening an existing index cheap. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS files (
     path TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     size INTEGER NOT NULL,
     mtime INTEGER NOT NULL,
     hash TEXT,
     hash_mode TEXT,
     sig TEXT,
     class TEXT,
     protected INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS files_size ON files(size)`,
  `CREATE INDEX IF NOT EXISTS files_class ON files(class)`,
  `CREATE TABLE IF NOT EXISTS runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     root TEXT NOT NULL,
     overall TEXT NOT NULL,
     counts TEXT NOT NULL,
     policy TEXT,
     entries INTEGER NOT NULL,
     truncated INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS findings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run INTEGER NOT NULL,
     rule TEXT NOT NULL,
     severity TEXT NOT NULL,
     title TEXT NOT NULL,
     path TEXT,
     detail TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS findings_run ON findings(run)`,
  `CREATE INDEX IF NOT EXISTS findings_rule ON findings(rule)`,
  `CREATE TABLE IF NOT EXISTS code_files (
     path TEXT PRIMARY KEY,
     lang TEXT NOT NULL,
     size INTEGER NOT NULL,
     mtime INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS symbols (
     path TEXT NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     line INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name)`,
  `CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path)`,
  `CREATE TABLE IF NOT EXISTS imports (
     path TEXT NOT NULL,
     target TEXT NOT NULL,
     resolved TEXT,
     line INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS imports_target ON imports(target)`,
  `CREATE INDEX IF NOT EXISTS imports_resolved ON imports(resolved)`,
  `CREATE INDEX IF NOT EXISTS imports_path ON imports(path)`,
  `CREATE TABLE IF NOT EXISTS registry (
     path TEXT PRIMARY KEY,
     purpose TEXT,
     externalizable INTEGER NOT NULL DEFAULT 0,
     protected INTEGER NOT NULL DEFAULT 0
   )`,
];

/**
 * Open (or create) a layout index.
 *
 * @param {string} file Absolute path to the SQLite file.
 * @returns {DatabaseSync} The handle.
 */
export function openIndex(file) {
  return openIndexInner(file, true);
}

/**
 * Open an index, validating it belongs to this plugin.
 *
 * A corrupt file is quarantined and rebuilt; a file that is a *different* SQLite
 * database is refused, because writing our tables into somebody else's database is
 * worse than failing loudly.
 *
 * @param {string} file Absolute path.
 * @param {boolean} mayQuarantine Whether a corrupt file may be moved aside.
 * @returns {import('node:sqlite').DatabaseSync} Handle.
 */
function openIndexInner(file) {
  // Two sessions scanning the same workspace is normal, not an error. Without a
  // busy timeout SQLite answers `database is locked` immediately and the second
  // caller loses its audit; with it, the second caller simply waits.
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  // A brand-new file has no tables and belongs to us. A file with tables but no
  // marker belongs to somebody else, and writing our schema into it is worse than
  // refusing: it would add tables to a database we do not understand.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);
  const ours = tables.includes('meta') && tables.includes('files');
  if (tables.length > 0 && !ours) {
    db.close();
    throw new Error(
      `refusing to use ${file}: it is a SQLite database this plugin did not create`,
    );
  }

  // Create first, migrate second. An older index may be missing whole tables, and
  // `ALTER TABLE imports` on a file that never had an `imports` table fails with
  // "no such table" — the migration has to run against a complete skeleton.
  for (const statement of SCHEMA) db.exec(statement);

  if (ours) {
    const storedRaw = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema')?.value ?? null;
    const stored = storedRaw === null ? SCHEMA_VERSION : Number(storedRaw);
    if (stored > SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `refusing to use ${file}: schema ${stored} is newer than this build (${SCHEMA_VERSION})`,
      );
    }
    if (stored < SCHEMA_VERSION) migrate(db, stored);
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema',
    String(SCHEMA_VERSION),
  );
  return db;
}

/**
 * Apply the column additions an older index is missing.
 *
 * @param {import('node:sqlite').DatabaseSync} db Handle.
 * @param {number} from Version the file was written with.
 * @returns {void}
 */
function migrate(db, from) {
  for (const step of COLUMN_MIGRATIONS) {
    if (step.version <= from) continue;
    const columns = db.prepare(`PRAGMA table_info(${step.table})`).all().map((row) => row.name);
    if (columns.includes(step.column)) continue;
    db.exec(step.ddl);
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
}

/**
 * Open an index, rebuilding it if the file is corrupt.
 *
 * `sqlite` reports a truncated or overwritten file as `SQLITE_NOTADB`; the file is
 * moved aside rather than deleted, because "the index was corrupt" is evidence
 * somebody may want, and a rebuild must not destroy it.
 *
 * @param {string} file Absolute path.
 * @returns {import('node:sqlite').DatabaseSync} Handle.
 */
export function openIndexSelfHealing(file) {
  try {
    return openIndexInner(file, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not a database|malformed|file is encrypted/i.test(message)) throw error;
    renameSyncQuietly(file, `${file}.corrupt-${Date.now()}`);
    return openIndexInner(file, true);
  }
}

/**
 * Move a file aside, ignoring a missing source.
 * @param {string} from Source.
 * @param {string} to Destination.
 * @returns {void}
 */
function renameSyncQuietly(from, to) {
  try {
    renameSync(from, to);
  } catch {
    // A file that vanished between open and quarantine is already gone.
  }
}

/**
 * Read the stored hash for one path when size and mtime still match.
 *
 * This is the whole point of an index: a 29 GB image that has not changed since
 * the last run is a database read, not 29 GB of disk.
 *
 * @param {DatabaseSync} db Index handle.
 * @param {string} path Absolute path.
 * @param {number} size Current size.
 * @param {number} mtime Current mtime in milliseconds.
 * @returns {{ hash: string, mode: string } | null} The stored digest, when trustworthy.
 */
export function lookupHash(db, path, size, mtime) {
  const row = db
    .prepare('SELECT hash, hash_mode, size, mtime FROM files WHERE path = ?')
    .get(path);
  if (row === undefined || row.hash === null) return null;
  // The row stores a floored millisecond value; compare like with like, or every
  // run looks "changed" to the index and the reuse never happens.
  if (row.size !== size || row.mtime !== Math.floor(mtime)) return null;
  return { hash: row.hash, mode: row.hash_mode ?? 'full' };
}

/**
 * Read the stored stage-one signature for one path when it is still trustworthy.
 *
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @param {string} path Absolute path.
 * @param {number} size Current size.
 * @param {number} mtime Current mtime in milliseconds.
 * @returns {string|null} The signature, when it still describes this file.
 */
export function lookupSignature(db, path, size, mtime) {
  const row = db.prepare('SELECT sig, size, mtime FROM files WHERE path = ?').get(path);
  if (row === undefined || row.sig === null || row.sig === undefined) return null;
  if (row.size !== size || row.mtime !== Math.floor(mtime)) return null;
  return row.sig;
}

/**
 * Write the current state of every walked entry back to the index.
 *
 * Missing paths are deleted, which is what keeps the index honest after a
 * cleanup: a file the governor archived must not keep haunting queries.
 *
 * @param {DatabaseSync} db Index handle.
 * @param {object[]} entries Walk entries (`rel`, `path`, `isFile`, `size`, `mtimeMs`).
 * @param {Map<string, string>} [hashes] Extra digests to store, by absolute path.
 * @returns {{ inserted: number, pruned: number }} Row counts.
 */
export function syncFiles(db, entries, hashes = new Map(), signatures = new Map()) {
  const now = Date.now();
  const seen = new Set();
  const upsert = db.prepare(
    `INSERT INTO files (path, kind, size, mtime, hash, hash_mode, sig, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       kind = excluded.kind, size = excluded.size, mtime = excluded.mtime,
       hash = COALESCE(excluded.hash, files.hash),
       hash_mode = COALESCE(excluded.hash_mode, files.hash_mode),
       sig = COALESCE(excluded.sig, files.sig),
       updated_at = excluded.updated_at`,
  );

  db.exec('BEGIN');
  let inserted = 0;
  try {
    for (const entry of entries) {
      seen.add(entry.path);
      const digest = hashes.get(entry.path);
      const signature = signatures.get(entry.path);
      upsert.run(
        entry.path,
        entry.isFile ? 'file' : entry.isSymlink ? 'symlink' : 'directory',
        entry.isFile ? entry.size : 0,
        Math.floor(entry.mtimeMs ?? 0),
        digest ?? null,
        digest === undefined ? null : 'full',
        signature ?? null,
        now,
      );
      inserted += 1;
    }

    let pruned = 0;
    for (const row of db.prepare('SELECT path FROM files').all()) {
      if (!seen.has(row.path)) {
        db.prepare('DELETE FROM files WHERE path = ?').run(row.path);
        pruned += 1;
      }
    }
    db.exec('COMMIT');
    return { inserted, pruned };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Record one audit run and its findings.
 *
 * @param {DatabaseSync} db Index handle.
 * @param {object} report Engine report.
 * @returns {number} The new run id.
 */
export function recordRun(db, report) {
  const at = Date.parse(report.generatedAt) || Date.now();
  const insertRun = db.prepare(
    `INSERT INTO runs (at, root, overall, counts, policy, entries, truncated)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = insertRun.run(
    at,
    report.root,
    report.overall,
    JSON.stringify(report.counts),
    report.policy?.path ?? null,
    report.stats?.entries ?? 0,
    report.stats?.truncated === true ? 1 : 0,
  );
  const runId = Number(result.lastInsertRowid);

  const insertFinding = db.prepare(
    `INSERT INTO findings (run, rule, severity, title, path, detail) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (const finding of report.findings) {
      insertFinding.run(
        runId,
        finding.rule,
        finding.severity,
        finding.title,
        finding.paths?.[0] ?? null,
        finding.detail,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return runId;
}

/**
 * Query the index the way an agent wants to: by name, size, class, rule.
 *
 * Every filter is optional and composes; results are capped so a broad query
 * cannot flood a context window.
 *
 * @param {DatabaseSync} db Index handle.
 * @param {object} [filters]
 * @param {string} [filters.name] Case-insensitive substring of the base name.
 * @param {string} [filters.contains] Case-insensitive substring of the full path.
 * @param {number} [filters.minSize] Minimum bytes.
 * @param {number} [filters.maxSize] Maximum bytes.
 * @param {'file'|'directory'|'symlink'} [filters.kind] Entry kind.
 * @param {string} [filters.class] Classification from the last run.
 * @param {string} [filters.rule] Only paths named by a finding of this rule.
 * @param {string} [filters.severity] Only paths from findings at this severity.
 * @param {number} [filters.limit] Rows, default 50, max 500.
 * @returns {object[]} Rows.
 */
export function queryIndex(db, filters = {}) {
  const where = [];
  const params = [];

  if (typeof filters.name === 'string' && filters.name !== '') {
    where.push(`files.path LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(filters.name)}%`);
  }
  if (typeof filters.contains === 'string' && filters.contains !== '') {
    where.push(`files.path LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(filters.contains)}%`);
  }
  if (Number.isFinite(filters.minSize)) {
    where.push('files.size >= ?');
    params.push(Math.floor(filters.minSize));
  }
  if (Number.isFinite(filters.maxSize)) {
    where.push('files.size <= ?');
    params.push(Math.floor(filters.maxSize));
  }
  if (typeof filters.kind === 'string' && filters.kind !== '') {
    where.push('files.kind = ?');
    params.push(filters.kind);
  }
  if (typeof filters.class === 'string' && filters.class !== '') {
    where.push('files.class = ?');
    params.push(filters.class);
  }
  // Findings accumulate across runs, so a filter must look only at the newest
  // run; otherwise the same path answers twice for every scan ever recorded.
  const latest = '(SELECT MAX(id) FROM runs)';
  if (typeof filters.rule === 'string' && filters.rule !== '') {
    where.push(
      `EXISTS (SELECT 1 FROM findings WHERE findings.path = files.path AND findings.rule = ? AND findings.run = ${latest})`,
    );
    params.push(filters.rule);
  }
  if (typeof filters.severity === 'string' && filters.severity !== '') {
    where.push(
      `EXISTS (SELECT 1 FROM findings WHERE findings.path = files.path AND findings.severity = ? AND findings.run = ${latest})`,
    );
    params.push(filters.severity);
  }

  const limit = Number.isFinite(filters.limit)
    ? Math.min(500, Math.max(1, Math.floor(filters.limit)))
    : 50;
  const sql =
    `SELECT files.path, files.kind, files.size, files.hash, files.hash_mode, files.class
     FROM files` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY files.size DESC, files.path ASC LIMIT ?';

  return db.prepare(sql).all(...params, limit).map((row) => ({
    path: row.path,
    kind: row.kind,
    size: row.size,
    ...(row.hash !== null ? { hash: row.hash, hashMode: row.hash_mode } : {}),
    ...(row.class !== null ? { class: row.class } : {}),
  }));
}

/**
 * Keep only the newest runs, with their findings.
 *
 * At a 60 s floor and a 15 s panel poll a workspace collects hundreds of runs a
 * day; an index that only grows turns into a governance problem of its own.
 *
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @param {number} [keep] Runs to retain.
 * @returns {number} Runs removed.
 */
export function pruneRuns(db, keep = 50) {
  const limit = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 50;
  const stale = db.prepare(`SELECT id FROM runs ORDER BY id DESC LIMIT -1 OFFSET ?`).all(limit);
  if (stale.length === 0) return 0;
  db.exec('BEGIN');
  try {
    for (const row of stale) {
      db.prepare('DELETE FROM findings WHERE run = ?').run(row.id);
      db.prepare('DELETE FROM runs WHERE id = ?').run(row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return stale.length;
}

/**
 * Aggregate counts for a status line.
 * @param {DatabaseSync} db Index handle.
 * @returns {{ files: number, directories: number, bytes: number, runs: number, findings: number }}
 */
export function indexStats(db) {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM files WHERE kind = 'file') AS files,
         (SELECT COUNT(*) FROM files WHERE kind = 'directory') AS directories,
         (SELECT COALESCE(SUM(size), 0) FROM files) AS bytes,
         (SELECT COUNT(*) FROM runs) AS runs,
         (SELECT COUNT(*) FROM findings) AS findings`,
    )
    .get();
  return {
    files: Number(row.files),
    directories: Number(row.directories),
    bytes: Number(row.bytes),
    runs: Number(row.runs),
    findings: Number(row.findings),
  };
}

/**
 * Persist the classification of each path, so a query can filter on it later.
 * @param {DatabaseSync} db Index handle.
 * @param {Array<{ path: string, class: string }>} rows Paths and their labels.
 * @returns {void}
 */
export function labelClasses(db, rows) {
  const update = db.prepare('UPDATE files SET class = ? WHERE path = ?');
  db.exec('BEGIN');
  try {
    for (const row of rows) update.run(row.class, row.path);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The declared purpose of every registered large file.
 * @param {DatabaseSync} db Index handle.
 * @param {Array<{ path: string, purpose?: string, externalizable?: boolean, protected?: boolean }>} entries Registry entries.
 * @returns {void}
 */
export function syncRegistry(db, entries) {
  const insert = db.prepare(
    `INSERT INTO registry (path, purpose, externalizable, protected) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       purpose = excluded.purpose,
       externalizable = excluded.externalizable,
       protected = excluded.protected`,
  );
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM registry');
    for (const entry of entries) {
      insert.run(
        entry.path,
        entry.purpose ?? null,
        entry.externalizable === true ? 1 : 0,
        entry.protected === true ? 1 : 0,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Escape LIKE metacharacters so a query string is matched literally.
 * @param {string} value Raw text.
 * @returns {string}
 */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
