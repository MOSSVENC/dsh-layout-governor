/**
 * Fix-plan generation.
 *
 * Guarantees, in order of importance:
 * 1. a path that the policy protects is never the target of a `delete` command,
 * 2. every action carries one shell-safe command line (`rm -f -- '…'`, quoting
 *    included) so a human can copy it into a terminal,
 * 3. the generated script prints commands by default — `APPLY=1` is required to
 *    execute anything, so `--fix-plan` stays a dry run.
 *
 * Fixability is decided by the engine, not here: a finding whose paths include a
 * protected path arrives with `fixable: false` and `evidence.protectedPaths`
 * filled in, and this module only ever downgrades an action to `review`.
 */

import path from 'node:path';

import { formatBytes, shellQuote } from './util.js';

const RISK_RANK = { low: 0, medium: 1, high: 2 };
const KIND_ORDER = ['delete', 'move-to-archive', 'register', 'edit-doc', 'review'];

/**
 * Build the human-readable fix plan, the runnable dry-run script and the actions.
 *
 * @param {object} report Report returned by `audit`.
 * @param {object} [options] Reserved; hosts may pass `{ date }` for a fixed archive stamp.
 * @returns {{ markdown: string, script: string, actions: object[] }}
 */
export function buildFixPlan(report, options = {}) {
  const actions = collectActions(report, options);
  actions.sort(compareActions);
  return {
    markdown: renderMarkdown(report, actions),
    script: renderScript(report, actions),
    actions,
  };
}

function collectActions(report, options) {
  const root = report.root;
  const generatedAt = typeof report.generatedAt === 'string' ? report.generatedAt : new Date().toISOString();
  const stamp = (options.date ?? generatedAt.slice(0, 10)).replace(/-/g, '');
  const actions = [];

  for (const finding of report.findings) {
    const evidence = finding.evidence ?? {};
    const protectedPaths = new Set(Array.isArray(evidence.protectedPaths) ? evidence.protectedPaths : []);

    // A doc edit touches no file content, so it stays a low-risk `edit-doc`
    // action even though the engine cannot rewrite prose on its own.
    if (finding.rule === 'docs') {
      collectDocs(actions, finding, evidence);
      continue;
    }

    // Duplicate/family findings are partially fixable: the unprotected copies
    // can still go, while the protected one needs a human.
    if (finding.rule === 'duplicates' || finding.rule === 'families') {
      if (finding.rule === 'duplicates') collectDuplicates(actions, root, finding, evidence, protectedPaths);
      else collectFamily(actions, root, finding, evidence, protectedPaths);
      continue;
    }

    if (!finding.fixable) {
      actions.push(
        action(finding, {
          kind: 'review',
          risk: 'high',
          paths: finding.paths,
          reason: `needs a human decision: ${finding.suggestion || finding.title}`,
          command: notice(`REVIEW ${finding.id}: ${finding.suggestion || finding.title}`),
        }),
      );
      continue;
    }

    switch (finding.rule) {
      case 'backups':
        collectBackup(actions, root, stamp, finding, evidence);
        break;
      case 'large-files':
        collectLargeFile(actions, report, finding, evidence, protectedPaths);
        break;
      case 'top-level':
        collectTopLevel(actions, root, stamp, finding);
        break;
      default:
        break;
    }
  }

  return actions;
}

function collectDuplicates(actions, root, finding, evidence, protectedPaths) {
  const keep = typeof evidence.keep === 'string' ? evidence.keep : '';
  const hash = String(evidence.sha256 ?? '').slice(0, 12);
  for (const target of finding.paths) {
    if (keep !== '' && target === keep) continue;
    if (protectedPaths.has(target)) {
      actions.push(protectedReview(finding, target));
      continue;
    }
    actions.push(
      action(finding, {
        kind: 'delete',
        risk: isInsideArchive(root, target) ? 'medium' : 'low',
        paths: [target],
        reason: `content-identical to ${keep} (sha256 ${hash})`,
        command: `rm -f -- ${shellQuote(target)}`,
      }),
    );
  }
}

function collectFamily(actions, root, finding, evidence, protectedPaths) {
  const keep = typeof evidence.keep === 'string' ? evidence.keep : '';
  const extension = String(evidence.extension ?? 'artifact');
  for (const target of finding.paths) {
    if (keep !== '' && target === keep) continue;
    if (protectedPaths.has(target)) {
      actions.push(protectedReview(finding, target));
      continue;
    }
    actions.push(
      action(finding, {
        kind: 'delete',
        risk: 'medium',
        paths: [target],
        reason: `superseded ${extension} in the same directory; keep ${keep}`,
        command: `rm -f -- ${shellQuote(target)}`,
      }),
    );
  }
}

function collectBackup(actions, root, stamp, finding, evidence) {
  const target = finding.paths[0];
  if (!target) return;

  if (evidence.legacySymlink === true) {
    actions.push(
      action(finding, {
        kind: 'review',
        risk: 'low',
        paths: [target],
        reason: `legacy symlink into the archive (${evidence.linkTarget ?? 'unknown'}); remove after the migration window`,
        command: notice(`REVIEW ${finding.id}: remove legacy symlink ${target} when the migration window closes`),
      }),
    );
    return;
  }

  if (typeof evidence.pattern === 'string') {
    actions.push(
      action(finding, {
        kind: 'review',
        risk: 'medium',
        paths: [target],
        reason: `archive entry name violates ${evidence.pattern}`,
        command: notice(`REVIEW ${finding.id}: rename ${target} to <YYYYMMDD>_<source>`),
      }),
    );
    return;
  }

  const destination = archiveDestination(root, stamp, target, evidence.kind === 'directory');
  actions.push(
    action(finding, {
      kind: 'move-to-archive',
      risk: 'medium',
      paths: [target],
      reason: 'backups belong in the archive root, named <YYYYMMDD>_<source>',
      command: `mkdir -p -- ${shellQuote(path.dirname(destination))} && mv -- ${shellQuote(target)} ${shellQuote(destination)}`,
    }),
  );
}

function collectLargeFile(actions, report, finding, evidence, protectedPaths) {
  const target = finding.paths[0];
  if (!target) {
    actions.push(
      action(finding, {
        kind: 'review',
        risk: 'low',
        paths: [],
        reason: finding.suggestion || finding.title,
        command: notice(`REVIEW ${finding.id}: ${finding.suggestion || finding.title}`),
      }),
    );
    return;
  }

  const registryPath = report.registry.path;
  const rel = path.relative(report.root, target).split(path.sep).join('/');
  const entryLines = [
    `  - path: "${rel}"`,
    `    bytes: ${Number(evidence.bytes) || 0}`,
    '    purpose: "TODO"',
    '    externalizable: false',
    `    protected: ${protectedPaths.has(target)}`,
    `    note: "auto-registered ${report.generatedAt.slice(0, 10)}"`,
  ];
  const printfArgs = entryLines.map((line) => shellQuote(line)).join(' ');

  actions.push(
    action(finding, {
      kind: 'register',
      risk: 'low',
      paths: [target],
      reason: `declare ${rel} in the registry so its size and owner are known`,
      // Only append when the registry really uses a block `entries:` key; an
      // inline `entries: []` would be corrupted by a blind append.
      command:
        `grep -qE '^entries:[[:space:]]*$' ${shellQuote(registryPath)} && ` +
        `printf '%s\\n' ${printfArgs} >> ${shellQuote(registryPath)} || ` +
        notice(`SKIP register ${rel}: add a block "entries:" key to ${registryPath} first`),
    }),
  );
}

function collectTopLevel(actions, root, stamp, finding) {
  const target = finding.paths[0];
  if (!target) return;
  const destination = archiveDestination(root, stamp, target, finding.evidence?.kind === 'directory');
  actions.push(
    action(finding, {
      kind: 'move-to-archive',
      risk: 'medium',
      paths: [target],
      reason: 'outside the declared top-level layout; park it in the archive instead of deleting it',
      command: `mkdir -p -- ${shellQuote(path.dirname(destination))} && mv -- ${shellQuote(target)} ${shellQuote(destination)}`,
    }),
  );
}

function collectDocs(actions, finding, evidence) {
  const target = finding.paths[0] ?? '';
  const claim = typeof evidence.claim === 'string' ? evidence.claim : String(evidence.name ?? '');
  actions.push(
    action(finding, {
      kind: 'edit-doc',
      risk: 'low',
      paths: finding.paths,
      reason: claim === '' ? 'document the directory' : `README claims ${claim} which does not exist`,
      command: notice(`EDIT ${target}${claim === '' ? '' : `: fix ${claim} to the current name`}`),
    }),
  );
}

// Deleting from the archive is not the same as deleting a stray copy: flag it.
function isInsideArchive(root, target) {
  const archive = path.join(root, '_archive') + path.sep;
  return target.startsWith(archive);
}

export function archiveDestination(root, stamp, target, isDirectory) {
  const rel = path.relative(root, target).split(path.sep).join('/');
  const slug =
    rel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'source';
  const dir = path.join(root, '_archive', `${stamp}_${slug}`);
  // A directory becomes the archive entry itself; a file is moved inside one, so
  // the archive stays a list of `YYYYMMDD_<source>` directories only.
  return isDirectory === true ? dir : path.join(dir, path.basename(target));
}

function protectedReview(finding, target) {
  return action(finding, {
    kind: 'review',
    risk: 'high',
    paths: [target],
    reason: 'path is protected by policy: confirm the keeper before anything is removed',
    command: notice(`REVIEW ${finding.id}: protected path needs a human decision (${shortPath(target)})`),
  });
}

function shortPath(target) {
  return String(target).split('/').slice(-2).join('/');
}

function action(finding, spec) {
  return {
    kind: spec.kind,
    rule: finding.rule,
    paths: [...spec.paths],
    reason: spec.reason,
    risk: spec.risk,
    command: spec.command,
  };
}

function notice(text) {
  return `printf '%s\\n' ${shellQuote(text)}`;
}

function compareActions(a, b) {
  const risk = (RISK_RANK[a.risk] ?? 9) - (RISK_RANK[b.risk] ?? 9);
  if (risk !== 0) return risk;
  const rule = a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
  if (rule !== 0) return rule;
  const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (kind !== 0) return kind;
  const aPath = a.paths[0] ?? '';
  const bPath = b.paths[0] ?? '';
  return aPath < bPath ? -1 : aPath > bPath ? 1 : 0;
}

function renderScript(report, actions) {
  const lines = [
    '#!/usr/bin/env bash',
    `# ${report.engine} ${report.engineVersion} — fix plan`,
    `# generated: ${report.generatedAt}`,
    `# root: ${report.root}`,
    `# overall: ${report.overall} (fail ${report.counts.fail}, warn ${report.counts.warn})`,
    `# actions: ${actions.length}`,
    '#',
    '# DRY-RUN BY DEFAULT: this script only prints commands unless you opt in.',
    '#   bash fixplan.sh          # dry run, prints every command',
    '#   APPLY=1 bash fixplan.sh  # execute the commands',
    'set -eu',
    '',
    'APPLY="${APPLY:-0}"',
    '',
    'while IFS= read -r cmd; do',
    '  case "$cmd" in',
    "    ''|'#'*) continue ;;",
    '  esac',
    '  if [ "$APPLY" = "1" ]; then',
    "    printf '[apply] %s\\n' \"$cmd\"",
    '    eval "$cmd"',
    '  else',
    "    printf '[dry-run] %s\\n' \"$cmd\"",
    '  fi',
    "done <<'DSH_LAYOUT_FIX_PLAN'",
  ];

  for (const item of actions) lines.push(item.command);

  lines.push('DSH_LAYOUT_FIX_PLAN');
  lines.push('');
  lines.push(`printf '%s\\n' ${shellQuote(`fix plan finished: ${actions.length} action(s)`)}`);
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report, actions) {
  const byKind = new Map();
  const byRisk = new Map();
  for (const item of actions) {
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    byRisk.set(item.risk, (byRisk.get(item.risk) ?? 0) + 1);
  }

  const reclaimable = report.findings.reduce(
    (sum, finding) => sum + (Number(finding.evidence?.reclaimableBytes) || 0),
    0,
  );

  const lines = [];
  lines.push('## Fix plan');
  lines.push('');
  lines.push(`- **Root:** \`${report.root}\``);
  lines.push(`- **Overall:** ${report.overall.toUpperCase()}`);
  lines.push(`- **Actions:** ${actions.length}`);
  lines.push(
    `- **By kind:** ${KIND_ORDER.filter((kind) => byKind.has(kind))
      .map((kind) => `${kind} ${byKind.get(kind)}`)
      .join(', ') || 'none'}`,
  );
  lines.push(
    `- **By risk:** ${['low', 'medium', 'high']
      .filter((risk) => byRisk.has(risk))
      .map((risk) => `${risk} ${byRisk.get(risk)}`)
      .join(', ') || 'none'}`,
  );
  lines.push(`- **Reclaimable (reported):** ≈${formatBytes(reclaimable)}`);
  lines.push('- **Dry run:** the generated script prints commands; `APPLY=1` is required to run them.');
  lines.push('');

  if (actions.length === 0) {
    lines.push('No actions: nothing to fix.');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push('| # | kind | risk | rule | target | reason |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  actions.forEach((item, index) => {
    const target = item.paths.length === 0 ? '(none)' : `\`${item.paths[0]}\``;
    lines.push(`| ${index + 1} | ${item.kind} | ${item.risk} | \`${item.rule}\` | ${target} | ${item.reason} |`);
  });
  lines.push('');
  lines.push('### Commands');
  lines.push('');
  lines.push('```bash');
  for (const item of actions) lines.push(item.command);
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
