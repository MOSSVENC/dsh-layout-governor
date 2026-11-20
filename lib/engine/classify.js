/**
 * Classify paths into the four composition buckets shown in the web panel.
 *
 * Order is significant: regenerable wins over backup wins over protected, so a
 * `.venv` that happens to sit inside `_archive/` is still reported as
 * regenerable (the cheapest thing to reclaim).
 */

import { matchesAny } from './glob.js';
import { trimSlashes } from './util.js';

/** Stable class order used by the report and the panel. */
const CLASS_ORDER = ['regenerable', 'backup', 'protected', 'canonical'];

/** Human labels for the report; locale files own translated labels. */
const CLASS_LABELS = {
  regenerable: 'Regenerable',
  backup: 'Backup',
  protected: 'Protected',
  canonical: 'Canonical',
};

/**
 * Build a path classifier from policy classification lists.
 *
 * @param {object} options
 * @param {object} [options.classification] `{ regenerable: string[], protected: string[] }`.
 * @param {readonly string[]} [options.backupRoots] Directories that count as the archive.
 * @returns {(relPath: string) => string} Class id for one relative path.
 */
export function createClassifier(options = {}) {
  const classification = options.classification ?? {};
  const regenerable = Array.isArray(classification.regenerable) ? classification.regenerable : [];
  const protectedPaths = Array.isArray(classification.protected) ? classification.protected : [];
  const backupRoots = (Array.isArray(options.backupRoots) ? options.backupRoots : ['_archive']).map(
    trimSlashes,
  );

  return function classify(relPath) {
    if (matchesAny(relPath, regenerable)) return 'regenerable';
    const top = String(relPath).split('/')[0];
    if (backupRoots.includes(top)) return 'backup';
    if (matchesAny(relPath, protectedPaths)) return 'protected';
    return 'canonical';
  };
}

/**
 * Aggregate file entries into `composition.classes` and `composition.topLevel`.
 *
 * @param {object[]} files File entries from the walk.
 * @param {(relPath: string) => string} classify
 * @returns {{ classes: object[], topLevel: object[] }}
 */
export function composeTree(files, classify) {
  const classBytes = new Map(CLASS_ORDER.map((id) => [id, { bytes: 0, files: 0 }]));
  const topLevel = new Map();

  for (const file of files) {
    const classId = classify(file.rel);
    const bucket = classBytes.get(classId) ?? classBytes.get('canonical');
    bucket.bytes += file.size;
    bucket.files += 1;

    const name = String(file.rel).split('/')[0];
    const top = topLevel.get(name) ?? { name, bytes: 0, files: 0, classes: new Map() };
    top.bytes += file.size;
    top.files += 1;
    top.classes.set(classId, (top.classes.get(classId) ?? 0) + file.size);
    topLevel.set(name, top);
  }

  const classes = CLASS_ORDER.map((id) => ({
    id,
    label: CLASS_LABELS[id],
    bytes: classBytes.get(id).bytes,
    files: classBytes.get(id).files,
  }));

  const tops = [...topLevel.values()]
    .map((top) => ({
      name: top.name,
      bytes: top.bytes,
      files: top.files,
      class: dominantClass(top.classes),
    }))
    .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));

  return { classes, topLevel: tops };
}

function dominantClass(classMap) {
  let bestId = 'canonical';
  let bestBytes = -1;
  for (const id of CLASS_ORDER) {
    const bytes = classMap.get(id) ?? 0;
    if (bytes > bestBytes) {
      bestBytes = bytes;
      bestId = id;
    }
  }
  return bestId;
}
