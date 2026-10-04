type Literal = string | number | boolean | null | Literal[];

/** Parse only inert array literals; never interpret JavaScript or rewrite quotes. */
export function parseQuiverData(html: string): Literal[] {
  const declaration = /\b(?:let|const|var)\s+recentTradesData\s*=\s*/.exec(html);
  if (!declaration) throw new Error('Quiver congress: recentTradesData not found');
  let pos = declaration.index + declaration[0].length;
  const start = pos;
  let values = 0;
  const fail = (): never => { throw new Error(`Quiver congress: invalid data literal at offset ${pos - start}`); };
  const space = () => { while (/\s/.test(html[pos] ?? '') && pos < html.length) pos++; };
  function string(): string {
    const quote = html[pos++];
    let out = '';
    while (pos < html.length && pos - start <= 5_000_000) {
      const char = html[pos++];
      if (char === quote) return out;
      if (char.charCodeAt(0) < 32) fail();
      if (char !== '\\') { out += char; continue; }
      const escaped = html[pos++];
      const escapes: Record<string, string> = { "'": "'", '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (Object.hasOwn(escapes, escaped)) { out += escapes[escaped]; continue; }
      if (escaped !== 'u' && escaped !== 'x') fail();
      const length = escaped === 'u' ? 4 : 2;
      const hex = html.slice(pos, pos + length);
      if (hex.length !== length || !/^[0-9a-f]+$/i.test(hex)) fail();
      out += String.fromCharCode(parseInt(hex, 16));
      pos += length;
    }
    return fail();
  }
  function value(depth: number): Literal {
    space();
    if (depth > 8 || ++values > 100_000 || pos - start > 5_000_000) fail();
    if (html[pos] === '"' || html[pos] === "'") return string();
    if (html[pos] === '[') {
      pos++;
      const result: Literal[] = [];
      space();
      while (html[pos] !== ']') {
        result.push(value(depth + 1));
        space();
        if (html[pos] === ']') break;
        if (html[pos++] !== ',') fail();
        space();
      }
      pos++;
      return result;
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(html.slice(pos));
    if (!token) return fail();
    pos += token[0].length;
    if (token[0] === 'null') return null;
    if (token[0] === 'true') return true;
    if (token[0] === 'false') return false;
    const number = Number(token[0]);
    if (!Number.isFinite(number)) fail();
    return number;
  }
  const rows = value(0);
  space();
  if (!Array.isArray(rows)) return fail();
  if (html[pos] !== ';') fail();
  return rows;
}
