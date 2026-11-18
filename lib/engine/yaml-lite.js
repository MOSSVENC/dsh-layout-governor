/**
 * A very small YAML subset parser used when the optional `yaml` package is not
 * installed. It exists so the CLI and the host tool keep working from a bare
 * checkout with no `npm install`.
 *
 * Supported: `#` comments, indented block mappings, `- ` block sequences,
 * inline sequences `[a, b]`, inline mappings `{a: b}`, single/double quoted
 * strings, integers, floats, booleans, `null`/`~`, and empty values.
 *
 * Deliberately not supported: anchors, aliases, tags, block scalars (`|`, `>`),
 * multi-document streams, flow nesting beyond one level.
 */

const BOOL_TRUE = new Set(['true', 'True', 'TRUE']);
const BOOL_FALSE = new Set(['false', 'False', 'FALSE']);
const NULLISH = new Set(['null', 'Null', 'NULL', '~', '']);
const INT_RE = /^[-+]?\d+$/;
const FLOAT_RE = /^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Parse a YAML document into plain JavaScript values.
 *
 * @param {string} text Raw YAML source.
 * @returns {unknown} Parsed document; `null` for an empty document.
 * @throws {Error} When the indentation or a flow collection is malformed.
 */
export function parseYamlLite(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const [value, next] = parseBlock(tokens, 0, tokens[0].indent);
  if (next < tokens.length) {
    throw new Error(`yaml-lite: unexpected content at line ${tokens[next].line}`);
  }
  return value;
}

function tokenize(text) {
  const raw = String(text).replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const tokens = [];
  for (let n = 0; n < raw.length; n += 1) {
    const lineNo = n + 1;
    let line = raw[n];
    if (line.trim() === '---' || line.trim() === '...') continue;
    const expanded = line.replace(/^\t+/, (m) => ' '.repeat(m.length));
    const indentMatch = /^ */.exec(expanded);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const body = stripComment(expanded.slice(indent));
    if (body.trim() === '') continue;
    tokens.push({ indent, text: body.replace(/\s+$/, ''), line: lineNo });
  }
  return tokens;
}

function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function isSeqItem(text) {
  return text === '-' || text.startsWith('- ');
}

function parseBlock(tokens, index, indent) {
  if (index >= tokens.length) return [null, index];
  if (isSeqItem(tokens[index].text)) return parseSeq(tokens, index, indent);
  return parseMap(tokens, index, indent);
}

function parseSeq(tokens, index, indent) {
  const out = [];
  let i = index;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.indent !== indent || !isSeqItem(token.text)) break;
    const body = token.text === '-' ? '' : token.text.slice(2).trim();

    if (body === '') {
      i += 1;
      if (i < tokens.length && tokens[i].indent > indent) {
        const [value, next] = parseBlock(tokens, i, tokens[i].indent);
        out.push(value);
        i = next;
      } else {
        out.push(null);
      }
      continue;
    }

    if (findKeyColon(body) !== -1) {
      // `- key: value` is a mapping whose first key sits on the dash line.
      const virtual = { indent: indent + 2, text: body, line: token.line };
      const spliced = tokens.slice();
      spliced[i] = virtual;
      const [value, next] = parseMap(spliced, i, indent + 2);
      out.push(value);
      i = next;
      continue;
    }

    out.push(parseScalar(body));
    i += 1;
  }
  return [out, i];
}

function parseMap(tokens, index, indent) {
  const out = {};
  let i = index;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.indent < indent) break;
    if (token.indent > indent) {
      throw new Error(`yaml-lite: unexpected indentation at line ${token.line}`);
    }
    if (isSeqItem(token.text)) break;

    const colon = findKeyColon(token.text);
    if (colon === -1) {
      throw new Error(`yaml-lite: expected "key: value" at line ${token.line}`);
    }
    const key = String(parseScalar(token.text.slice(0, colon).trim()));
    const rest = token.text.slice(colon + 1).trim();

    if (rest !== '') {
      out[key] = parseScalar(rest);
      i += 1;
      continue;
    }

    i += 1;
    if (i < tokens.length && tokens[i].indent > indent) {
      const [value, next] = parseBlock(tokens, i, tokens[i].indent);
      out[key] = value;
      i = next;
      continue;
    }
    if (i < tokens.length && tokens[i].indent === indent && isSeqItem(tokens[i].text)) {
      const [value, next] = parseSeq(tokens, i, indent);
      out[key] = value;
      i = next;
      continue;
    }
    out[key] = null;
  }
  return [out, i];
}

function findKeyColon(text) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

function parseScalar(text) {
  const s = String(text).trim();
  if (s === '') return null;

  const first = s[0];
  if (first === '"' || first === "'") {
    if (s.length < 2 || s[s.length - 1] !== first) {
      throw new Error(`yaml-lite: unterminated quoted string: ${s}`);
    }
    return first === "'" ? unquoteSingle(s) : unquoteDouble(s);
  }

  if (first === '[') {
    if (!s.endsWith(']')) throw new Error(`yaml-lite: unterminated inline sequence: ${s}`);
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner, ',').map((part) => parseScalar(part));
  }

  if (first === '{') {
    if (!s.endsWith('}')) throw new Error(`yaml-lite: unterminated inline mapping: ${s}`);
    const inner = s.slice(1, -1).trim();
    const out = {};
    if (inner === '') return out;
    for (const part of splitTopLevel(inner, ',')) {
      const colon = findKeyColon(part);
      if (colon === -1) throw new Error(`yaml-lite: bad inline mapping entry: ${part}`);
      const key = String(parseScalar(part.slice(0, colon).trim()));
      out[key] = parseScalar(part.slice(colon + 1).trim());
    }
    return out;
  }

  if (NULLISH.has(s)) return null;
  if (BOOL_TRUE.has(s)) return true;
  if (BOOL_FALSE.has(s)) return false;
  if (INT_RE.test(s)) return Number.parseInt(s, 10);
  if (FLOAT_RE.test(s)) return Number.parseFloat(s);
  return s;
}

function unquoteSingle(s) {
  return s.slice(1, -1).split("''").join("'");
}

function unquoteDouble(s) {
  const body = s.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '0':
        out += '\0';
        break;
      case 'u': {
        const hex = body.slice(i + 1, i + 5);
        out += String.fromCharCode(Number.parseInt(hex, 16) || 0);
        i += 4;
        break;
      }
      default:
        out += `\\${next}`;
    }
  }
  return out;
}

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}
