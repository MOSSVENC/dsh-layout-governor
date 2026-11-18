/**
 * Report formatting: `json` for machines, `text` for a terminal, `markdown`
 * for pasting into an issue or a handoff document.
 *
 * No colour codes anywhere: the CLI must stay readable in a pipe or a log file.
 */

import { formatBytes } from './util.js';

/**
 * Render a report.
 *
 * @param {object} report Report returned by `audit`.
 * @param {'json'|'text'|'markdown'|'md'} [format] Output format, defaults to `text`.
 * @returns {string}
 */
export function formatReport(report, format = 'text') {
  const normalized = String(format || 'text').toLowerCase();
  if (normalized === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (normalized === 'markdown' || normalized === 'md') return toMarkdown(report);
  return toText(report);
}

function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : '';
}

function toText(report) {
  const lines = [];
  lines.push(`${report.engine} ${report.engineVersion}`);
  lines.push(`root:      ${report.root}`);
  if (report.policy.present === false) {
    lines.push(`policy:    ${report.policy.path}`);
    lines.push('warning:   no policy file found - every rule is disabled, so nothing is enforced');
  } else {
    lines.push(`policy:    ${report.policy.path} (v${report.policy.version}, sha256 ${short(report.policy.sha256)})`);
  }
  lines.push(
    `registry:  ${report.registry.path} ${report.registry.present ? '(present)' : '(absent, treated as empty)'}`,
  );
  lines.push(`generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(
    `overall: ${String(report.overall).toUpperCase()}   ` +
      `fail ${report.counts.fail} | warn ${report.counts.warn} | info ${report.counts.info}`,
  );
  lines.push('');

  lines.push('rules');
  const idWidth = Math.max(...report.rules.map((rule) => rule.id.length), 4);
  for (const rule of report.rules) {
    const state = rule.enabled ? 'on ' : 'off';
    lines.push(
      `  ${rule.id.padEnd(idWidth)}  ${state}  ${String(rule.severity).padEnd(4)}  ` +
        `${String(rule.findings).padStart(2)} finding(s)  ${rule.durationMs}ms`,
    );
  }
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('findings: none');
  } else {
    lines.push(`findings (${report.findings.length})`);
    report.findings.forEach((item, index) => {
      lines.push(`  ${index + 1}. [${item.severity}] ${item.id}  ${item.title}`);
      lines.push(`     ${item.detail}`);
      if (item.suggestion) lines.push(`     suggestion: ${item.suggestion}`);
      if (item.paths.length > 0) {
        lines.push('     paths:');
        for (const p of item.paths) lines.push(`       - ${p}`);
      }
      lines.push(`     fixable: ${item.fixable ? 'yes' : 'no (needs a human decision)'}`);
    });
  }
  lines.push('');

  const stats = report.stats;
  lines.push(
    `stats: entries ${stats.entries} (files ${stats.files}, dirs ${stats.directories}, links ${stats.symlinks}), ` +
      `${formatBytes(stats.bytes)}, hashed ${stats.hashedFiles} files (${formatBytes(stats.hashedBytes)}), ` +
      `${stats.durationMs}ms${stats.truncated ? ', TRUNCATED (limits hit)' : ''}`,
  );
  lines.push('');

  lines.push('composition');
  for (const item of report.composition.classes) {
    lines.push(
      `  ${String(item.label).padEnd(12)} ${formatBytes(item.bytes).padStart(10)}  ${String(item.files).padStart(6)} file(s)`,
    );
  }
  if (report.composition.topLevel.length > 0) {
    lines.push('');
    lines.push('  top level');
    const nameWidth = Math.max(...report.composition.topLevel.map((item) => item.name.length), 4);
    for (const item of report.composition.topLevel) {
      lines.push(
        `    ${item.name.padEnd(nameWidth)}  ${formatBytes(item.bytes).padStart(10)}  ` +
          `${String(item.files).padStart(6)} file(s)  ${item.class}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function toMarkdown(report) {
  const lines = [];
  lines.push(`# Layout audit — ${report.engine} ${report.engineVersion}`);
  lines.push('');
  lines.push(`- **Overall:** ${report.overall.toUpperCase()}`);
  lines.push(
    `- **Counts:** fail ${report.counts.fail}, warn ${report.counts.warn}, info ${report.counts.info}`,
  );
  lines.push(`- **Root:** \`${report.root}\``);
  if (report.policy.present === false) {
    lines.push(`- **Policy:** \`${report.policy.path}\` — **not found**, so no rule is enforced`);
  } else {
    lines.push(
      `- **Policy:** \`${report.policy.path}\` (v${report.policy.version}, sha256 \`${short(report.policy.sha256)}\`)`,
    );
  }
  lines.push(
    `- **Registry:** \`${report.registry.path}\` ${report.registry.present ? '(present)' : '(absent, treated as empty)'}`,
  );
  lines.push(`- **Generated:** ${report.generatedAt}`);
  lines.push('');

  if (report.policy.present === false) {
    lines.push('## No policy');
    lines.push('');
    lines.push(
      `No policy file exists at \`${report.policy.path}\`, so every rule is disabled and nothing is ` +
        'enforced. This report describes the tree; it does not judge it. Add a policy to start auditing.',
    );
    lines.push('');
  }

  lines.push('## Rules');
  lines.push('');
  lines.push('| Rule | Enabled | Severity | Findings | Time |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const rule of report.rules) {
    lines.push(
      `| \`${rule.id}\` | ${rule.enabled ? 'yes' : 'no'} | ${rule.severity} | ${rule.findings} | ${rule.durationMs} ms |`,
    );
  }
  lines.push('');

  lines.push('## Findings');
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('None.');
  } else {
    for (const item of report.findings) {
      lines.push(`### ${item.severity.toUpperCase()} · ${item.title}`);
      lines.push('');
      lines.push(`- id: \`${item.id}\``);
      lines.push(`- detail: ${item.detail}`);
      if (item.suggestion) lines.push(`- suggestion: ${item.suggestion}`);
      lines.push(`- fixable: ${item.fixable ? 'yes' : 'no'}`);
      if (item.paths.length > 0) {
        lines.push('- paths:');
        for (const p of item.paths) lines.push(`  - \`${p}\``);
      }
      lines.push('');
    }
  }

  const stats = report.stats;
  lines.push('## Stats');
  lines.push('');
  lines.push(
    `${stats.entries} entries (${stats.files} files, ${stats.directories} dirs, ${stats.symlinks} symlinks), ` +
      `${formatBytes(stats.bytes)}; hashed ${stats.hashedFiles} files (${formatBytes(stats.hashedBytes)}); ` +
      `${stats.durationMs} ms${stats.truncated ? '; **truncated**: limits hit' : ''}.`,
  );
  lines.push('');

  lines.push('## Composition');
  lines.push('');
  lines.push('| Class | Bytes | Files |');
  lines.push('| --- | --- | --- |');
  for (const item of report.composition.classes) {
    lines.push(`| ${item.label} (\`${item.id}\`) | ${formatBytes(item.bytes)} | ${item.files} |`);
  }
  lines.push('');
  if (report.composition.topLevel.length > 0) {
    lines.push('| Top level | Bytes | Files | Class |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of report.composition.topLevel) {
      lines.push(`| \`${item.name}\` | ${formatBytes(item.bytes)} | ${item.files} | ${item.class} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
