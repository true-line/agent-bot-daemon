// A JSON Schema (draft 2020-12) validator for the keywords the pinned
// soul-contracts schemas use, and no others. A schema that uses a keyword
// outside this set is refused rather than half-checked (fail closed), so a
// soul-contracts release that starts using `$ref` or `oneOf` breaks the
// tests loudly instead of passing records through unvalidated.
//
// `format: date-time` is asserted (RFC 3339), because records carry
// timestamps that HQ compares.

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default']);
const ASSERTIONS = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'minProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains',
  'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'if', 'then', 'else',
]);
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t);
const isObject = (v) => typeOf(v) === 'object';

// Structural equality for enum, const and uniqueItems (key order ignored).
function equal(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b) || typeof a !== 'object' || a === null) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

function validDateTime(s) {
  const m = DATE_TIME.exec(s);
  if (!m) return false;
  const [, y, mo, d, h, mi, sec, , , oh, om] = m;
  const days = new Date(Date.UTC(+y, +mo, 0)).getUTCDate();
  return +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= days && +h <= 23 && +mi <= 59 && +sec <= 60 && (oh === undefined || (+oh <= 23 && +om <= 59));
}

const patterns = new Map();
const regex = (p) => {
  if (!patterns.has(p)) patterns.set(p, new RegExp(p, 'u'));
  return patterns.get(p);
};

// Throws on a schema this validator cannot fully check.
export function checkSchemaSupported(schema, where = '#') {
  if (typeof schema === 'boolean') return;
  if (!isObject(schema)) throw new TypeError(`${where}: a schema is an object or a boolean`);
  for (const [k, v] of Object.entries(schema)) {
    if (ANNOTATIONS.has(k)) continue;
    if (!ASSERTIONS.has(k)) throw new TypeError(`${where}: keyword ${k} is not supported by the SDK validator`);
    if (k === 'properties') for (const [p, s] of Object.entries(v)) checkSchemaSupported(s, `${where}/properties/${p}`);
    if (['additionalProperties', 'items', 'contains', 'if', 'then', 'else'].includes(k)) checkSchemaSupported(v, `${where}/${k}`);
    if (k === 'format' && v !== 'date-time') throw new TypeError(`${where}: format ${v} is not supported`);
    if (k === 'pattern') regex(v);
  }
}

// Returns a list of { path, keyword, message }; empty means valid.
export function validate(schema, value) {
  checkSchemaSupported(schema);
  const errors = [];
  walk(schema, value, '', errors);
  return errors;
}

function walk(schema, v, path, errors) {
  if (schema === true) return;
  const err = (keyword, message) => errors.push({ path: path || '/', keyword, message });
  if (schema === false) { err('false', 'no value is allowed here'); return; }
  const s = schema;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => isType(v, t) || (t === 'number' && typeOf(v) === 'integer'))) { err('type', `expected ${types.join(' or ')}, got ${typeOf(v)}`); return; }
  }
  if (s.enum !== undefined && !s.enum.some((e) => equal(e, v))) err('enum', `not one of ${JSON.stringify(s.enum)}`);
  if (s.const !== undefined && !equal(s.const, v)) err('const', `must be ${JSON.stringify(s.const)}`);

  if (typeof v === 'string') {
    const len = [...v].length; // code points, per the spec
    if (s.minLength !== undefined && len < s.minLength) err('minLength', `shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && len > s.maxLength) err('maxLength', `longer than ${s.maxLength}`);
    if (s.pattern !== undefined && !regex(s.pattern).test(v)) err('pattern', `does not match ${s.pattern}`);
    if (s.format === 'date-time' && !validDateTime(v)) err('format', 'not an RFC 3339 date-time');
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) err('minimum', `less than ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) err('maximum', `greater than ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) err('minItems', `fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) err('maxItems', `more than ${s.maxItems} items`);
    if (s.uniqueItems && v.some((x, i) => v.findIndex((y) => equal(x, y)) !== i)) err('uniqueItems', 'items are not unique');
    if (s.items !== undefined) v.forEach((x, i) => walk(s.items, x, `${path}/${i}`, errors));
    if (s.contains !== undefined) {
      const n = v.filter((x) => { const e = []; walk(s.contains, x, '', e); return e.length === 0; }).length;
      const min = s.minContains ?? 1;
      if (n < min) err('contains', `fewer than ${min} matching items`);
      if (s.maxContains !== undefined && n > s.maxContains) err('maxContains', `more than ${s.maxContains} matching items`);
    }
  }
  if (isObject(v)) {
    const keys = Object.keys(v);
    if (s.minProperties !== undefined && keys.length < s.minProperties) err('minProperties', `fewer than ${s.minProperties} properties`);
    for (const r of s.required ?? []) if (!Object.hasOwn(v, r)) err('required', `missing ${r}`);
    const props = s.properties ?? {};
    for (const k of keys) {
      const p = `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (Object.hasOwn(props, k)) walk(props[k], v[k], p, errors);
      else if (s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) errors.push({ path: p, keyword: 'additionalProperties', message: `unknown field ${k}` });
        else walk(s.additionalProperties, v[k], p, errors);
      }
    }
  }
  if (s.if !== undefined) {
    const e = [];
    walk(s.if, v, path, e);
    const branch = e.length === 0 ? s.then : s.else;
    if (branch !== undefined) walk(branch, v, path, errors);
  }
}
