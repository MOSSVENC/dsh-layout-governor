/**
 * Rule `docs`: the top-level README is the map of the workspace, so it must
 * agree with the disk.
 *
 * A token like `` `writings/` `` (backticked, trailing slash, single segment) is
 * read as a claim about a top-level directory. Renaming a directory without
 * updating the map is how a whole team keeps opening dead paths.
 */

import path from 'node:path';

import { finding } from '../finding.js';
import { matchesAnyName } from '../glob.js';

/** Rule id, also the policy key. */
export const id = 'docs';

/** Defaults merged under `rules.docs`. */
export const defaults = {
  enabled: true,
  severity: 'fail',
  file: 'README.md',
  ignore: [],
};

const TOKEN_RE = /`([^`\n]{1,160})`/g;
const CLAIM_RE = /^[A-Za-z0-9._-]+\/$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Drop fenced code blocks before claims are extracted.
 *
 * A rename table such as
 *
 *     quill/ -> writings/writer
 *
 * documents the *history* of a name, not the current map. Reading it as a claim
 * reports every retired name as a missing directory on every run, which is
 * exactly the noise that makes a governance tool get switched off.
 *
 * @param {string} text Document text.
 * @returns {string} Text with fenced blocks removed.
 */
function stripFences(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const opener = FENCE_RE.exec(line);
    if (opener !== null) {
      const marker = opener[1][0];
      if (fence === null) {
        fence = marker;
        continue;
      }
      if (fence === marker) {
        fence = null;
        continue;
      }
    }
    if (fence === null) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Report README claims that are missing on disk, and unclaimed top-level dirs.
 *
 * @param {object} ctx Engine context.
 * @returns {Promise<object[]>} Findings.
 */
export async function run(ctx) {
  const config = ctx.rule(id);
  if (!config.enabled) return [];

  const file = typeof config.file === 'string' && config.file !== '' ? config.file : defaults.file;
  const ignore = Array.isArray(config.ignore) ? config.ignore : [];
  const text = await ctx.readText(file);
  const docPath = path.join(ctx.root, file);

  if (text === null) {
    return [
      finding(id, {
        severity: 'warn',
        title: `Policy documents ${file} but it is missing`,
        detail: `rules.docs.file points at ${file}, which does not exist under the audit root.`,
        paths: [docPath],
        suggestion: `create ${file} with the top-level map, or set rules.docs.enabled: false`,
        evidence: { file, missing: true },
        fixable: false,
        key: `missing:${file}`,
      }),
    ];
  }

  const claimed = new Set();
  const scanned = stripFences(text);
  TOKEN_RE.lastIndex = 0;
  let match = TOKEN_RE.exec(scanned);
  while (match !== null) {
    const token = match[1].trim();
    if (CLAIM_RE.test(token)) claimed.add(token.slice(0, -1));
    match = TOKEN_RE.exec(scanned);
  }

  const findings = [];
  const topLevelDirs = ctx.topLevel.filter((entry) => entry.isDirectory && !entry.isSymlink);

  for (const name of [...claimed].sort()) {
    if (ctx.byRel.has(name)) continue;
    // `ignore` works on both sides of the comparison: a policy can declare that
    // a name is legitimately mentioned without being a top-level directory.
    if (matchesAnyName(name, ignore)) continue;
    findings.push(
      finding(id, {
        severity: config.severity,
        title: `README claims a missing top-level directory: ${name}/`,
        detail:
          `${file} advertises "${name}/" as a top-level directory, but nothing with that name ` +
          'exists at the audit root, so every path under it is dead.',
        paths: [docPath],
        suggestion: `update ${file} to the current directory names, or restore ${name}/`,
        evidence: { claim: `${name}/`, exists: false },
        fixable: false,
        key: `claim:${name}`,
      }),
    );
  }

  for (const entry of topLevelDirs) {
    if (claimed.has(entry.name)) continue;
    if (matchesAnyName(entry.name, ignore)) continue;
    findings.push(
      finding(id, {
        severity: 'warn',
        title: `Top-level directory not described in ${file}: ${entry.name}/`,
        detail:
          `${entry.name}/ exists at the audit root but ${file} never mentions it, so new readers ` +
          'cannot tell what it is for or whether it may be removed.',
        paths: [entry.path],
        suggestion: `add a row for "${entry.name}/" to the ${file} top-level table`,
        evidence: { name: entry.name, claim: null },
        fixable: false,
        key: `unclaimed:${entry.name}`,
      }),
    );
  }

  return findings;
}
