/**
 * Strict JSON parser for the wire's duplicate-key rule (0.4 §6):
 * "Implementations reject duplicate JSON keys ... before processing
 * payloads." JSON.parse keeps the last duplicate silently, so contract
 * fixtures that prove the refusal need this parser. Structure handling
 * mirrors RFC 8252; duplicate object keys throw.
 */
export function parseStrict(text) {
  return new StrictJsonParser(text).parseValue(0).value;
}

class StrictJsonParser {
  constructor(text) {
    if (typeof text !== 'string') throw new SyntaxError('input must be a string');
    this.t = text;
    this.i = 0;
  }

  parseValue(depth) {
    if (depth > 200) this.fail('nesting too deep');
    this.skipWs();
    const c = this.t[this.i];
    if (c === '{') return { value: this.parseObject(depth) };
    if (c === '[') return { value: this.parseArray(depth) };
    if (c === '"') return { value: this.parseString() };
    if (this.t.startsWith('true', this.i)) { this.i += 4; return { value: true }; }
    if (this.t.startsWith('false', this.i)) { this.i += 5; return { value: false }; }
    if (this.t.startsWith('null', this.i)) { this.i += 4; return { value: null }; }
    return { value: this.parseNumber() };
  }

  skipWs() {
    while (this.i < this.t.length) {
      const c = this.t[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i += 1;
      else break;
    }
  }

  fail(message) {
    throw new SyntaxError(`${message} at offset ${this.i}`);
  }

  parseObject(depth) {
    this.i += 1;
    const out = {};
    const seen = new Set();
    this.skipWs();
    if (this.t[this.i] === '}') { this.i += 1; return out; }
    for (;;) {
      this.skipWs();
      if (this.t[this.i] !== '"') this.fail('expected object key');
      const key = this.parseString();
      if (seen.has(key)) this.fail(`duplicate key "${key}"`);
      seen.add(key);
      this.skipWs();
      if (this.t[this.i] !== ':') this.fail('expected ":"');
      this.i += 1;
      out[key] = this.parseValue(depth + 1).value;
      this.skipWs();
      if (this.t[this.i] === ',') { this.i += 1; continue; }
      if (this.t[this.i] === '}') { this.i += 1; return out; }
      this.fail('expected "," or "}"');
    }
  }

  parseArray(depth) {
    this.i += 1;
    const out = [];
    this.skipWs();
    if (this.t[this.i] === ']') { this.i += 1; return out; }
    for (;;) {
      out.push(this.parseValue(depth + 1).value);
      this.skipWs();
      if (this.t[this.i] === ',') { this.i += 1; continue; }
      if (this.t[this.i] === ']') { this.i += 1; return out; }
      this.fail('expected "," or "]"');
    }
  }

  parseString() {
    this.i += 1;
    let out = '';
    for (;;) {
      const c = this.t[this.i];
      if (c === undefined) this.fail('unterminated string');
      if (c === '"') { this.i += 1; return out; }
      if (c === '\\') {
        const e = this.t[this.i + 1];
        this.i += 2;
        if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else if (e === '/') out += '/';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'u') {
          const [hi, lo] = this.parseHexPair();
          out += lo === null ? String.fromCharCode(hi) : String.fromCharCode(hi, lo);
        }
        else this.fail(`bad escape "\\${e ?? ''}"`);
        continue;
      }
      if (c.charCodeAt(0) < 0x20) this.fail('raw control character in string');
      out += c;
      this.i += 1;
    }
  }

  parseHexPair() {
    const hi = this.parseHex4();
    if (hi < 0xd800 || hi > 0xdfff) return [hi, null];
    if (hi > 0xdbff) this.fail('unpaired low surrogate');
    if (this.t[this.i] !== '\\' || this.t[this.i + 1] !== 'u') this.fail('unpaired high surrogate');
    this.i += 2;
    const lo = this.parseHex4();
    if (lo < 0xdc00 || lo > 0xdfff) this.fail('invalid low surrogate');
    return [hi, lo];
  }

  parseHex4() {
    const s = this.t.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(s)) this.fail('bad "\\u" escape');
    this.i += 4;
    return parseInt(s, 16);
  }

  parseNumber() {
    const rest = this.t.slice(this.i);
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!m || m[0] === '') this.fail('unexpected character');
    this.i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.fail('number out of range');
    return n;
  }
}
