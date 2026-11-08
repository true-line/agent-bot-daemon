// Strict JSON parsing for contract messages.
//
// JSON.parse accepts duplicate object keys (the last one wins), so two
// readers of one message can disagree about its content. soul-contracts'
// parse-refusal fixtures require a strict parser to refuse them. This parser
// follows RFC 8259 and additionally refuses:
// - duplicate keys in one object;
// - lone UTF-16 surrogates in strings (they cannot round-trip through JCS);
// - nesting deeper than `maxDepth`.
// Object keys are defined as own data properties, so a `__proto__` key is
// data, never a prototype change.
import { fail } from '../errors.mjs';

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WS = /[ \t\n\r]*/y;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function parseStrict(text, { maxDepth = 64 } = {}) {
  if (typeof text !== 'string') text = Buffer.from(text).toString('utf8');
  let i = 0;
  const bad = (why) => fail('host.invalid_json', `invalid JSON at offset ${i}: ${why}`, { offset: i });
  const ws = () => { WS.lastIndex = i; WS.exec(text); i = WS.lastIndex; };

  function string() {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= text.length) bad('unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) bad('unescaped control character in string');
      i += c === 0x5c ? 2 : 1;
    }
    i++;
    let s;
    try {
      s = JSON.parse(text.slice(start, i));
    } catch {
      i = start;
      bad('malformed string escape');
    }
    if (LONE_SURROGATE.test(s)) { i = start; bad('lone surrogate in string'); }
    return s;
  }

  // depth: how many objects and arrays enclose this value.
  function value(depth) {
    ws();
    const c = text[i];
    if ((c === '{' || c === '[') && depth >= maxDepth) bad(`nesting deeper than ${maxDepth}`);
    if (c === '{') {
      i++;
      const obj = {};
      const keys = new Set();
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') bad('expected a string key');
        const keyAt = i;
        const key = string();
        if (keys.has(key)) { i = keyAt; bad(`duplicate key ${JSON.stringify(key)}`); }
        keys.add(key);
        ws();
        if (text[i] !== ':') bad('expected ":"');
        i++;
        Object.defineProperty(obj, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        bad('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        bad('expected "," or "]"');
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m && m[0].length > 0) {
      i = NUMBER.lastIndex;
      const n = Number(m[0]);
      if (!Number.isFinite(n)) bad('number out of range');
      return n;
    }
    return bad('unexpected token');
  }

  if (text.charCodeAt(0) === 0xfeff) bad('byte order mark');
  const result = value(0);
  ws();
  if (i !== text.length) bad('trailing content');
  return result;
}
