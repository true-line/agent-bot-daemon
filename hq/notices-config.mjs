// HQ's owner-written configuration for the broker's identity-service queues.
// Content, custody and polling live in agent-bot-comms, behind host services.
const DAY = 24 * 60 * 60 * 1000;
const RANGES = { pollIntervalMs: [1000, 3600_000], count: [1, 50], leaseSeconds: [10, 3600], maxMessages: [1, 100_000], maxBytes: [64 * 1024, 1024 * 1024 * 1024], retentionMs: [7 * DAY, 90 * DAY] };

export function validateNoticesConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('HQ config: notices is an object');
  const allowed = new Set(['harnesses', 'wakeClass', ...Object.keys(RANGES)]);
  for (const name of Object.keys(input)) if (!allowed.has(name)) throw new Error(`HQ config: unknown key notices.${name}`);
  if (!Array.isArray(input.harnesses) || input.harnesses.length < 1 || input.harnesses.length > 32
    || input.harnesses.some((h) => typeof h !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(h)) || new Set(input.harnesses).size !== input.harnesses.length) throw new Error('HQ config: notices.harnesses is a unique list of 1 to 32 harness names');
  for (const [name, [lo, hi]] of Object.entries(RANGES)) if (input[name] !== undefined && (!Number.isSafeInteger(input[name]) || input[name] < lo || input[name] > hi)) throw new Error(`HQ config: notices.${name} must be an integer from ${lo} to ${hi}`);
  if (input.wakeClass !== undefined && !['none', 'notify'].includes(input.wakeClass)) throw new Error('HQ config: notices.wakeClass is none or notify');
  return input;
}
