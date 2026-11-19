/**
 * The code half of the index: symbols and imports, extracted per language.
 *
 * `codegraph` builds a semantic graph with real parsers and 38 language backends.
 * This module does something narrower and honest: line-oriented extraction of the
 * two things an agent asks for first — "where is this defined" and "what does this
 * file depend on". It is not a parser, it does not resolve scope, and it does not
 * pretend to a call graph. What it buys is that those two questions are answered
 * from a table instead of a grep over 15 000 files.
 *
 * Every pattern here was chosen against the languages this workspace actually
 * contains, measured before writing it: Python, JS/TS/MJS, shell, C/C++, Rust, Go
 * and GDScript.
 */

/** Files larger than this are data, not code worth indexing. */
export const MAX_CODE_BYTES = 2 * 1024 * 1024;

/** Extension to language family. */
export const LANGUAGES = new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.jsx', 'javascript'],
  ['.py', 'python'],
  ['.gd', 'gdscript'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.zsh', 'shell'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.rs', 'rust'],
  ['.go', 'go'],
]);

/** Directories whose contents are someone else's code, never the workspace's. */
const VENDOR = /(?:^|\/)(node_modules|\.venv|venv|site-packages|dist|build|target|\.git)(?:\/|$)/;

/**
 * Whether a path should be parsed at all.
 * @param {string} rel Path relative to the root.
 * @param {string} ext Lower-case extension including the dot.
 * @param {number} size File size in bytes.
 * @returns {string|null} Language, or null when the file is out of scope.
 */
export function languageOf(rel, ext, size) {
  if (VENDOR.test(rel)) return null;
  if (!Number.isFinite(size) || size > MAX_CODE_BYTES) return null;
  return LANGUAGES.get(ext) ?? null;
}

/** Symbol patterns per language: [regex, kind]. First match per line wins. */
const SYMBOL_RULES = {
  javascript: [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, 'function'],
    [/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/, 'function'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, 'binding'],
    [/^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/, 'type'],
  ],
  python: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w.]*)/, 'function'],
    [/^\s*class\s+([A-Za-z_][\w.]*)/, 'class'],
    [/^\s*([A-Za-z_][\w.]*)\s*=\s*(?:lambda|.*def\s)/, 'binding'],
  ],
  gdscript: [
    [/^\s*func\s+([A-Za-z_][\w]*)/, 'function'],
    [/^\s*class_name\s+([A-Za-z_][\w]*)/, 'class'],
    [/^\s*(?:var|const)\s+([A-Za-z_][\w]*)\s*=/, 'binding'],
    [/^\s*signal\s+([A-Za-z_][\w]*)/, 'signal'],
  ],
  shell: [
    [/^\s*function\s+([A-Za-z_][\w-]*)\s*(?:\{|\(|\s)/, 'function'],
    [/^\s*([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/, 'function'],
  ],
  c: [
    [/^\s*struct\s+([A-Za-z_][\w]*)/, 'struct'],
    [/^\s*(?:static\s+)?[A-Za-z_][\w*]*\s+([A-Za-z_][\w]*)\s*\(/, 'function'],
    [/^\s*typedef\s+.*?\b([A-Za-z_][\w]*)\s*;/, 'type'],
  ],
  cpp: [
    [/^\s*(?:class|struct)\s+([A-Za-z_][\w]*)/, 'class'],
    [/^\s*namespace\s+([A-Za-z_][\w]*)/, 'namespace'],
    [/^\s*[A-Za-z_][\w:<>,*& ]*\s+([A-Za-z_][\w]*)\s*\(/, 'function'],
  ],
  rust: [
    [/^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/, 'function'],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, 'type'],
    [/^\s*(?:pub\s+)?mod\s+([A-Za-z_][\w]*)/, 'module'],
  ],
  go: [
    [/^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/, 'function'],
    [/^\s*type\s+([A-Za-z_][\w]*)/, 'type'],
  ],
};

/** Import patterns per language: [regex, index of the target group]. */
const IMPORT_RULES = {
  javascript: [
    [/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/, 1],
    [/^\s*import\s+['"]([^'"]+)['"]/, 1],
    [/\brequire\(\s*['"]([^'"]+)['"]\s*\)/, 1],
  ],
  typescript: [
    [/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/, 1],
    [/^\s*import\s+['"]([^'"]+)['"]/, 1],
    [/\brequire\(\s*['"]([^'"]+)['"]\s*\)/, 1],
  ],
  python: [
    [/^\s*from\s+([A-Za-z_][\w.]*)\s+import/, 1],
    [/^\s*import\s+([A-Za-z_][\w.]*)/, 1],
  ],
  gdscript: [
    [/^\s*extends\s+([A-Za-z_][\w./]*)/, 1],
    [/\b(?:preload|load)\(\s*['"]([^'"]+)['"]/, 1],
  ],
  shell: [
    [/^\s*(?:source|\.)\s+([^\s;]+)/, 1],
  ],
  c: [[/^\s*#include\s+["<]([^">]+)[">]/, 1]],
  cpp: [[/^\s*#include\s+["<]([^">]+)[">]/, 1]],
  rust: [
    [/^\s*(?:pub\s+)?use\s+([A-Za-z_][\w:]*)/, 1],
    [/^\s*(?:pub\s+)?mod\s+([A-Za-z_][\w]*)\s*;/, 1],
  ],
  go: [
    [/^\s*import\s+"([^"]+)"/, 1],
    // A grouped import block lists bare quoted paths, one per line.
    [/^\s*"([^"]+)"\s*$/, 1],
  ],
};

/**
 * Extract symbols and imports from one file's text.
 *
 * @param {string} text File contents.
 * @param {string} lang Language family from {@link languageOf}.
 * @returns {{ symbols: Array<{name: string, kind: string, line: number}>, imports: Array<{target: string, line: number}> }}
 */
export function extract(text, lang) {
  const symbols = [];
  const imports = [];
  const symbolRules = SYMBOL_RULES[lang] ?? [];
  const importRules = IMPORT_RULES[lang] ?? [];
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    for (const [pattern, kind] of symbolRules) {
      const match = pattern.exec(line);
      if (match === null) continue;
      symbols.push({ name: match[1], kind, line: lineNumber });
      break;
    }

    for (const [pattern, group] of importRules) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const target = match[group];
      if (typeof target === 'string' && target !== '') imports.push({ target, line: lineNumber });
      break;
    }
  }

  return { symbols, imports };
}
