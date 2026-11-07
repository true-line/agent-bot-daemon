/**
 * Dependency-free validator for the JSON Schema draft 2020-12 subset the
 * contract schemas use. The supported keyword list is pinned in
 * contracts/README.md; extending it means extending that list in the same
 * change.
 */
const SUPPORTED_KEYWORDS = new Set([
  '$schema', 'title', 'description',
  'type', 'properties', 'required', 'additionalProperties', 'minProperties',
  'enum', 'const', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'format', 'if', 'then',
]);

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const FORMATS = {
  'date-time': (v) => DATE_TIME.test(v) && Number.isFinite(Date.parse(v)),
};

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export function assertKeywordsUsed(schema) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`unsupported schema keyword "${key}" — extend tests/support/validator.mjs and contracts/README.md`);
    }
  }
}

export function validate(value, schema) {
  const errors = [];
  check(value, schema, '$', errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function check(value, schema, path, errors) {
  if (typeof schema === 'boolean') {
    if (!schema) errors.push({ path, message: 'false schema refuses everything' });
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      errors.push({ path, message: `expected type ${types.join('|')}, got ${actual}` });
      return;
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push({ path, message: 'value not in enum' });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `longer than maxLength ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `does not match pattern ${schema.pattern}` });
    }
    if (schema.format !== undefined) {
      const f = FORMATS[schema.format];
      if (f && !f(value)) errors.push({ path, message: `not a valid ${schema.format}` });
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `above maximum ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `fewer than minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `more than maxItems ${schema.maxItems}` });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) {
            errors.push({ path, message: `items ${i} and ${j} are equal but uniqueItems is set` });
          }
        }
      }
    }
    if (schema.items !== undefined) {
      value.forEach((v, i) => check(v, schema.items, `${path}[${i}]`, errors));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push({ path, message: `missing required property "${name}"` });
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push({ path, message: `fewer than minProperties ${schema.minProperties}` });
    }
    for (const [name, sub] of Object.entries(props)) {
      if (name in value) check(value[name], sub, `${path}.${name}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!(name in props)) {
          errors.push({ path, message: `additional property "${name}" is not allowed` });
        }
      }
    }
  }
  if (schema.if !== undefined) {
    const probe = [];
    check(value, schema.if, path, probe);
    if (probe.length === 0 && schema.then !== undefined) {
      check(value, schema.then, path, errors);
    }
  }
}
