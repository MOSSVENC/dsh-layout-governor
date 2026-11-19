/**
 * The code half of the index: symbols, imports and reverse dependencies.
 *
 * Split from `store.js` for the same reason the plugin is split: layout and code
 * are two jobs. Both share one file on disk, so this module takes an open handle
 * rather than opening its own.
 */

import path from 'node:path';

/**
 * Whether a code file needs parsing, by the same rule that saves disk reads:
 * unchanged size and mtime means the stored symbols still describe it.
 *
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @param {string} path Absolute path.
 * @param {number} size Current size.
 * @param {number} mtime Current mtime in milliseconds.
 * @returns {boolean} True when the file must be re-parsed.
 */
export function codeNeedsParse(db, path, size, mtime) {
  const row = db
    .prepare('SELECT size, mtime FROM code_files WHERE path = ?')
    .get(path);
  if (row === undefined) return true;
  return row.size !== size || row.mtime !== Math.floor(mtime);
}

/**
 * Replace one file's symbols and imports.
 *
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @param {object} input
 * @param {string} input.path Absolute path.
 * @param {string} input.lang Language family.
 * @param {number} input.size Size in bytes.
 * @param {number} input.mtime Mtime in milliseconds.
 * @param {Array<{name: string, kind: string, line: number}>} input.symbols Extracted symbols.
 * @param {Array<{target: string, line: number}>} input.imports Extracted imports.
 * @returns {void}
 */
export function writeCodeFile(db, input, options = {}) {
  const now = Date.now();
  // One commit per file is what turned a 12k-file index into minutes on a DrvFs
    // mount. The caller may own the transaction; only the default is atomic per file.
  const atomic = options.atomic !== false;
  if (atomic) db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM symbols WHERE path = ?').run(input.path);
    db.prepare('DELETE FROM imports WHERE path = ?').run(input.path);
    db.prepare(
      `INSERT INTO code_files (path, lang, size, mtime, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         lang = excluded.lang, size = excluded.size, mtime = excluded.mtime,
         updated_at = excluded.updated_at`,
    ).run(input.path, input.lang, input.size, Math.floor(input.mtime), now);

    const insertSymbol = db.prepare('INSERT INTO symbols (path, name, kind, line) VALUES (?, ?, ?, ?)');
    for (const symbol of input.symbols) insertSymbol.run(input.path, symbol.name, symbol.kind, symbol.line);
    const insertImport = db.prepare('INSERT INTO imports (path, target, resolved, line) VALUES (?, ?, ?, ?)');
    for (const item of input.imports) insertImport.run(input.path, item.target, resolveTarget(input.path, item.target), item.line);
    if (atomic) db.exec('COMMIT');
  } catch (error) {
    if (atomic) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Resolve a relative import target to an absolute path, the way a resolver would
 * for the common cases — `./x`, `../x`, and extension-less targets.
 *
 * Package imports (`react`, `std::io`) are not resolved: there is no resolution
 * table here, and inventing one would be a worse answer than `null`.
 *
 * @param {string} importer Absolute path of the importing file.
 * @param {string} target Raw import target.
 * @returns {string|null} Absolute path, or null for a symbolic target.
 */
function resolveTarget(importer, target) {
  if (typeof target !== 'string' || target === '') return null;
  if (!target.startsWith('.') && !target.startsWith('/')) return null;
  const base = path.resolve(path.dirname(importer), target);
  return base;
}

/**
 * Drop code rows for paths the walk no longer sees.
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @returns {number} Rows removed.
 */
export function pruneCode(db, keep, options = {}) {
  if (options.prune === false) return 0;
  let removed = 0;
  for (const row of db.prepare('SELECT path FROM code_files').all()) {
    if (keep.has(row.path)) continue;
    db.prepare('DELETE FROM code_files WHERE path = ?').run(row.path);
    db.prepare('DELETE FROM symbols WHERE path = ?').run(row.path);
    db.prepare('DELETE FROM imports WHERE path = ?').run(row.path);
    removed += 1;
  }
  return removed;
}

/**
 * Where is a symbol defined?
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @param {object} filters
 * @param {string} [filters.name] Exact name.
 * @param {string} [filters.match] Case-insensitive substring of the name.
 * @param {string} [filters.kind] function | class | type | …
 * @param {string} [filters.path] Only this file.
 * @param {number} [filters.limit] Rows, default 50, max 500.
 * @returns {object[]}
 */
export function querySymbols(db, filters = {}) {
  const where = [];
  const params = [];
  if (typeof filters.name === 'string' && filters.name !== '') {
    where.push('name = ?');
    params.push(filters.name);
  }
  if (typeof filters.match === 'string' && filters.match !== '') {
    where.push(`name LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(filters.match)}%`);
  }
  if (typeof filters.kind === 'string' && filters.kind !== '') {
    where.push('kind = ?');
    params.push(filters.kind);
  }
  if (typeof filters.path === 'string' && filters.path !== '') {
    where.push(`path LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(filters.path)}%`);
  }
  const limit = Number.isFinite(filters.limit) ? Math.min(500, Math.max(1, Math.floor(filters.limit))) : 50;
  const sql =
    'SELECT path, name, kind, line FROM symbols' +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY path, line LIMIT ?';
  return db.prepare(sql).all(...params, limit).map((row) => ({ ...row }));
}

/**
 * What does a file import?
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @param {object} filters
 * @param {string} [filters.path] File absolute path.
 * @param {string} [filters.target] Import target substring.
 * @param {number} [filters.limit] Rows.
 * @returns {object[]}
 */
export function queryImports(db, filters = {}) {
  const where = [];
  const params = [];
  if (typeof filters.path === 'string' && filters.path !== '') {
    where.push(`path LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(filters.path)}%`);
  }
  if (typeof filters.target === 'string' && filters.target !== '') {
    where.push(`target LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(filters.target)}%`);
  }
  const limit = Number.isFinite(filters.limit) ? Math.min(500, Math.max(1, Math.floor(filters.limit))) : 50;
  const sql =
    'SELECT path, target, line FROM imports' +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY path, line LIMIT ?';
  return db.prepare(sql).all(...params, limit).map((row) => ({ ...row }));
}

/**
 * Who imports a module? The reverse edge an agent wants before deleting anything.
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @param {string} target Module substring.
 * @param {number} [limit] Rows.
 * @returns {object[]}
 */
export function queryDependents(db, target, limit = 50) {
  const text = String(target ?? '').trim();
  if (text === '') return [];
  const bounded = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.floor(limit))) : 50;

  // A file named `helper.js` must match `import './helper.js'`, `'./helper'`, and a
  // bare `'helper'`. The old query was a LIKE on the raw target, which answered
  // "nothing depends on this" for every name-shaped question asked of it.
  const stem = text.replace(/\.(js|mjs|cjs|ts|tsx|py|gd|sh|rs|go|c|cpp)$/i, '');
  const rows = db
    .prepare(
      `SELECT i.path AS path, i.target AS target, i.line AS line, i.resolved AS resolved
         FROM imports i
        WHERE i.target = ? OR i.target = ? OR i.target = ? OR i.target LIKE ? ESCAPE '\\'
           OR (i.resolved IS NOT NULL AND (i.resolved = ? OR i.resolved LIKE ? ESCAPE '\\'))
        ORDER BY i.path, i.line
        LIMIT ?`,
    )
    .all(
      text,
      `./${text}`,
      stem,
      `%${escapeLike(stem)}%`,
      path.resolve(text),
      `%${escapeLike(stem)}%`,
      bounded,
    );
  return rows.map((row) => ({ ...row }));
}

/**
 * Index totals for the code side.
 * @param {import('node:sqlite').DatabaseSync} db Index handle.
 * @returns {{ codeFiles: number, symbols: number, imports: number }}
 */
export function codeStats(db) {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM code_files) AS codeFiles,
         (SELECT COUNT(*) FROM symbols) AS symbols,
         (SELECT COUNT(*) FROM imports) AS imports`,
    )
    .get();
  return {
    codeFiles: Number(row.codeFiles),
    symbols: Number(row.symbols),
    imports: Number(row.imports),
  };
}

/**
 * Escape LIKE metacharacters so a query string is matched literally.
 * @param {string} value Raw text.
 * @returns {string}
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}
