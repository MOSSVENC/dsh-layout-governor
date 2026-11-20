/**
 * Report formatting: `json` for machines, `text` for a terminal, `markdown`
 * for pasting into an issue or a handoff document.
 *
 * Each surface is assembled from one section per concern (`header`, `rules`,
 * `findings`, `stats`, `composition`) instead of one long function, so adding a
 * field means touching exactly the section that owns it. Sections return lines and
 * never join them; the two public renderers own the blank-line rhythm.
 *
 * No colour codes anywhere: the CLI must stay readable in a pipe or a log file.
 */

import { formatBytes } from './util.js';


/**
 * One line of `key=value` counters for a rule, or an empty string.
 *
 * A rule that says "0 findings" must also say what it looked at: four hashed files
 * and four hundred thousand are both "0 findings" and only one of them is a fact.
 *
 * @param {object} rule Rule report.
 * @returns {string} Suffix for the rules line.
 */
function describeCoverage(rule) {
  const counters = rule.coverage;
  if (counters === null || typeof counters !== 'object') return '';
  const keys = Object.keys(counters);
  if (keys.length === 0) return '';

  const parts = [];
  for (const key of keys.sort()) {
    parts.push(`${key}=${counters[key]}`);
  }
  return `  ${parts.join(' ')}`;
}

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
  if (normalized === 'markdown' || normalized === 'md') return renderMarkdown(report);
  return renderText(report);
}

/**
 * First 12 characters of a digest, for printing next to a policy path.
 * @param {unknown} hash Digest.
 * @returns {string}
 */
function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : '';
}

/**
 * The policy/registry banner, shared by both surfaces.
 * @param {object} report Report.
 * @returns {{ found: boolean, id: string, version: number, digest: string, registry: string, present: boolean }}
 */
function provenance(report) {
  return {
    found: report.policy.present !== false,
    id: report.policy.path,
    version: report.policy.version,
    digest: short(report.policy.sha256),
    registry: report.registry.path,
    present: report.registry.present,
  };
}

/**
 * `findings: none` or the numbered list.
 * @param {object[]} findings Findings.
 * @returns {string[]} Lines.
 */
function textFindings(findings) {
  if (findings.length === 0) return ['findings: none'];
  const lines = [`findings (${findings.length})`];
  findings.forEach((item, index) => {
    lines.push(`  ${index + 1}. [${item.severity}] ${item.id}  ${item.title}`);
    lines.push(`     ${item.detail}`);
    if (item.suggestion) lines.push(`     suggestion: ${item.suggestion}`);
    if (item.paths.length > 0) {
      lines.push('     paths:');
      for (const itemPath of item.paths) lines.push(`       - ${itemPath}`);
    }
    lines.push(`     fixable: ${item.fixable ? 'yes' : 'no (needs a human decision)'}`);
  });
  return lines;
}

/**
 * The one-line stats footer.
 * @param {object} stats Report stats.
 * @returns {string[]} Lines.
 */
function textStats(stats) {
  return [
    `stats: entries ${stats.entries} (files ${stats.files}, dirs ${stats.directories}, links ${stats.symlinks}), ` +
      `${formatBytes(stats.bytes)}, hashed ${stats.hashedFiles} files (${formatBytes(stats.hashedBytes)}), ` +
      `${stats.durationMs}ms${stats.truncated ? ', TRUNCATED (limits hit)' : ''}` +
      `${stats.unreadable > 0 ? `, ${stats.unreadable} unreadable path(s)` : ''}`,
  ];
}

/**
 * The composition block, including the per-top-level breakdown.
 * @param {object} composition Report composition.
 * @returns {string[]} Lines.
 */
function textComposition(composition) {
  const lines = ['composition'];
  for (const item of composition.classes) {
    lines.push(
      `  ${String(item.label).padEnd(12)} ${formatBytes(item.bytes).padStart(10)}  ` +
        `${String(item.files).padStart(6)} file(s)`,
    );
  }
  if (composition.topLevel.length === 0) return lines;
  const nameWidth = Math.max(...composition.topLevel.map((item) => item.name.length), 4);
  lines.push('', '  top level');
  for (const item of composition.topLevel) {
    lines.push(
      `    ${item.name.padEnd(nameWidth)}  ${formatBytes(item.bytes).padStart(10)}  ` +
        `${String(item.files).padStart(6)} file(s)  ${item.class}`,
    );
  }
  return lines;
}

/**
 * Terminal rendering.
 * @param {object} report Report.
 * @returns {string}
 */
function renderText(report) {
  const source = provenance(report);
  const lines = [`${report.engine} ${report.engineVersion}`, `root:      ${report.root}`];
  if (source.found) {
    lines.push(`policy:    ${source.id} (v${source.version}, sha256 ${source.digest})`);
  } else {
    lines.push(`policy:    ${source.id}`);
    lines.push('warning:   no policy file found - every rule is disabled, so nothing is enforced');
  }
  lines.push(
    `registry:  ${source.registry} ${source.present ? '(present)' : '(absent, treated as empty)'}`,
    `generated: ${report.generatedAt}`,
    '',
    `overall: ${String(report.overall).toUpperCase()}   ` +
      `fail ${report.counts.fail} | warn ${report.counts.warn} | info ${report.counts.info}`,
    '',
    'rules',
  );

  const idWidth = Math.max(...report.rules.map((rule) => rule.id.length), 4);
  for (const rule of report.rules) {
    lines.push(
      `  ${rule.id.padEnd(idWidth)}  ${rule.enabled ? 'on ' : 'off'}  ${String(rule.severity).padEnd(4)}  ` +
        `${String(rule.findings).padStart(2)} finding(s)  ${rule.durationMs}ms` +
        `${describeCoverage(rule)}${rule.truncated ? '  TRUNCATED' : ''}`,
    );
  }

  lines.push('', ...textFindings(report.findings), '', ...textStats(report.stats), '', ...textComposition(report.composition));
  return `${lines.join('\n')}\n`;
}

/**
 * Markdown header block: verdict, counts, provenance.
 * @param {object} report Report.
 * @returns {string[]} Lines.
 */
function markdownHeader(report) {
  const source = provenance(report);
  const lines = [`# Layout audit — ${report.engine} ${report.engineVersion}`, ''];
  lines.push(`- **Overall:** ${report.overall.toUpperCase()}`);
  lines.push(
    `- **Counts:** fail ${report.counts.fail}, warn ${report.counts.warn}, info ${report.counts.info}`,
  );
  lines.push(`- **Root:** \`${report.root}\``);
  lines.push(
    source.found
      ? `- **Policy:** \`${source.id}\` (v${source.version}, sha256 \`${source.digest}\`)`
      : `- **Policy:** \`${source.id}\` — **not found**, so no rule is enforced`,
  );
  lines.push(
    `- **Registry:** \`${source.registry}\` ${source.present ? '(present)' : '(absent, treated as empty)'}`,
  );
  lines.push(`- **Generated:** ${report.generatedAt}`, '');
  if (!source.found) {
    lines.push('## No policy', '');
    lines.push(
      `No policy file exists at \`${source.id}\`, so every rule is disabled and nothing is ` +
        'enforced. This report describes the tree; it does not judge it. Add a policy to start auditing.',
      '',
    );
  }
  return lines;
}

/**
 * Markdown rules table.
 * @param {object[]} rules Rule reports.
 * @returns {string[]} Lines.
 */
function markdownRules(rules) {
  const lines = ['## Rules', '', '| Rule | Enabled | Severity | Findings | Time |', '| --- | --- | --- | --- | --- |'];
  for (const rule of rules) {
    lines.push(
      `| \`${rule.id}\` | ${rule.enabled ? 'yes' : 'no'} | ${rule.severity} | ${rule.findings} | ${rule.durationMs} ms |` +
        `${rule.truncated ? ' truncated |' : ''}`,
    );
  }
  return [...lines, ''];
}

/**
 * Markdown findings: one section per finding.
 * @param {object[]} findings Findings.
 * @returns {string[]} Lines.
 */
function markdownFindings(findings) {
  if (findings.length === 0) return ['## Findings', '', 'None.', ''];
  const lines = ['## Findings', ''];
  for (const item of findings) {
    lines.push(`### ${item.severity.toUpperCase()} · ${item.title}`, '');
    lines.push(`- id: \`${item.id}\``);
    lines.push(`- detail: ${item.detail}`);
    if (item.suggestion) lines.push(`- suggestion: ${item.suggestion}`);
    lines.push(`- fixable: ${item.fixable ? 'yes' : 'no'}`);
    if (item.paths.length > 0) {
      lines.push('- paths:');
      for (const itemPath of item.paths) lines.push(`  - \`${itemPath}\``);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Markdown stats paragraph.
 * @param {object} stats Report stats.
 * @returns {string[]} Lines.
 */
function markdownStats(stats) {
  return [
    '## Stats',
    '',
    `${stats.entries} entries (${stats.files} files, ${stats.directories} dirs, ${stats.symlinks} symlinks), ` +
      `${formatBytes(stats.bytes)}; hashed ${stats.hashedFiles} files (${formatBytes(stats.hashedBytes)}); ` +
      `${stats.durationMs} ms${stats.truncated ? '; **truncated**: limits hit' : ''}` +
      `${stats.unreadable > 0 ? `; ${stats.unreadable} unreadable path(s)` : ''}.`,
    '',
  ];
}

/**
 * Markdown composition tables.
 * @param {object} composition Report composition.
 * @returns {string[]} Lines.
 */
function markdownComposition(composition) {
  const lines = ['## Composition', '', '| Class | Bytes | Files |', '| --- | --- | --- |'];
  for (const item of composition.classes) {
    lines.push(`| ${item.label} (\`${item.id}\`) | ${formatBytes(item.bytes)} | ${item.files} |`);
  }
  lines.push('');
  if (composition.topLevel.length > 0) {
    lines.push('| Top level | Bytes | Files | Class |', '| --- | --- | --- | --- |');
    for (const item of composition.topLevel) {
      lines.push(`| \`${item.name}\` | ${formatBytes(item.bytes)} | ${item.files} | ${item.class} |`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Markdown rendering.
 * @param {object} report Report.
 * @returns {string}
 */
function renderMarkdown(report) {
  const lines = [
    ...markdownHeader(report),
    ...markdownRules(report.rules),
    ...markdownFindings(report.findings),
    ...markdownStats(report.stats),
    ...markdownComposition(report.composition),
  ];
  return `${lines.join('\n')}\n`;
}
