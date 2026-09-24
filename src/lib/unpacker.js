// Robust Dean Edwards packer unpacker.
// Many video hosts (Mixdrop, Lulustream, Uqload...) hide the m3u8 inside
// eval(function(p,a,c,k,e,d){...}('payload',radix,count,'keywords',0,{}))
// We locate the full eval(...) call with string-aware paren counting, then
// evaluate the inner function-call expression to recover the original source.

function findEvalBlock(src, from = 0) {
  const start = src.indexOf('eval(function(p,a,c,k,e', from);
  if (start === -1) return null;
  // Walk from the '(' after 'eval' and count parens, skipping string literals.
  let i = src.indexOf('(', start);
  if (i === -1) return null;
  let depth = 0;
  let inStr = false;
  let strCh = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = true; strCh = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        // inner = everything between eval( and the matching )
        const inner = src.slice(src.indexOf('(', start) + 1, i);
        return { inner, end: i + 1 };
      }
    }
  }
  return null;
}

// Parse the four packer arguments out of the inner call expression, WITHOUT eval
// (Cloudflare Workers forbid eval/new Function).
function unescapeJS(lit) {
  let s = lit.slice(1, -1);
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (m, g) => {
    if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    switch (g) {
      case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r';
      case 'b': return '\b'; case 'f': return '\f'; case 'v': return '\v';
      case '0': return '\0'; default: return g; // \\ \' \" \/ etc.
    }
  });
}
function decodePacker(p, a, c, k) {
  const enc = function (cc) {
    return (cc < a ? '' : enc(parseInt(cc / a))) + ((cc = cc % a) > 35 ? String.fromCharCode(cc + 29) : cc.toString(36));
  };
  const d = {};
  let i = c;
  while (i--) d[enc(i)] = k[i] || enc(i);
  return p.replace(/\b\w+\b/g, (m) => (Object.prototype.hasOwnProperty.call(d, m) ? d[m] : m));
}
function parsePackerArgs(inner) {
  const m = inner.match(/\}\s*\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/);
  if (!m) return null;
  return { p: unescapeJS(m[1]), a: parseInt(m[2], 10), c: parseInt(m[3], 10), k: unescapeJS(m[4]).split('|') };
}

// Unpack the FIRST packer block found. Returns unpacked source string or null.
function unpackOnce(src, from = 0) {
  const block = findEvalBlock(src, from);
  if (!block) return null;
  try {
    const args = parsePackerArgs(block.inner);
    if (!args) return null;
    const code = decodePacker(args.p, args.a, args.c, args.k);
    if (typeof code === 'string' && code) return { code, end: block.end };
    return null;
  } catch (e) {
    return null;
  }
}

// Some pages nest multiple packers; unpack recursively (packer inside packer).
// Returns the concatenation of the original source + all unpacked layers, so
// URL searching sees everything.
function unpackAll(src, maxDepth = 5) {
  let layers = [src];
  let current = src;
  for (let d = 0; d < maxDepth; d++) {
    const r = unpackOnce(current, 0);
    if (!r || !r.code) break;
    layers.push(r.code);
    if (!/eval\(function\(p,a,c,k,e/.test(r.code)) break;
    current = r.code;
  }
  return layers.join('\n');
}

module.exports = { unpackOnce, unpackAll, findEvalBlock };
