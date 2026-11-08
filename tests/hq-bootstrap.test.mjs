// Identity-first bootstrap in the real HQ (plan §4.4, §4.7), re-proving the
// SDK's three outcomes with device status read through the legacy bridge
// instead of the fake signer: safe mode, device_revoked and
// credential_unavailable. The identity-service link and the hardware signer
// are still to come (§9 PRs 10, 15 and 18), so those halves stay fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definePlugin } from '../sdk/plugin.mjs';
import { validate } from '../sdk/wire/schema.mjs';
import { errorResponseSchema, hello, startHQ } from './hq-harness.mjs';

test('unenrolled: safe mode; status and device.status answer, nothing else does, and no Soul is admitted', async () => {
  const t = await startHQ({ device: 'unenrolled' });
  try {
    assert.equal(t.status.mode, 'safe');
    assert.match(t.status.reason, /not enrolled/);
    assert.equal(t.status.admissions, false);
    assert.equal(t.status.plugins[0].state, 'waiting');
    const owner = await t.owner();
    assert.equal((await owner.request('status')).result.mode, 'safe');
    assert.equal((await owner.request('device.status')).result.device, 'unenrolled');
    assert.equal((await owner.request('souls.list')).host_refusal.code, 'host.safe_mode');
    const entry = await t.entry();
    assert.equal((await entry.request('Hello', hello())).host_refusal.code, 'host.safe_mode');
  } finally { await t.done(); }
});

test('an unreadable legacy enrollment is an unavailable signer: safe mode', async () => {
  const t = await startHQ({ device: 'broken' });
  try {
    assert.equal(t.status.mode, 'safe');
    assert.match(t.status.reason, /signer unavailable/);
  } finally { await t.done(); }
});

test('enrollment is refused in HQ until the HQ signer lands, with a pointer to the existing CLI', async () => {
  const t = await startHQ({ device: 'unenrolled' });
  try {
    const owner = await t.owner();
    const res = await owner.request('device.enroll', {});
    assert.equal(res.host_refusal.code, 'host.invalid_request');
    assert.match(res.host_refusal.explanation, /agent-bot server enroll/);
  } finally { await t.done(); }
});

test('revoked at startup: device_revoked, not safe mode; admissions stay open for local work', async () => {
  const t = await startHQ({ device: 'revoked' });
  try {
    assert.equal(t.status.mode, 'device_revoked');
    assert.match(t.status.reason, /re-enroll/);
    assert.equal(t.status.admissions, true);
    const entry = await t.entry();
    assert.equal((await entry.request('Hello', hello())).ok, true);
    assert.ok(t.hq.core.receipts.some((r) => r.kind === 'device.revoked'));
  } finally { await t.done(); }
});

test('revoked at runtime: the next legacy probe moves HQ to device_revoked', async () => {
  const t = await startHQ();
  try {
    assert.equal(t.hq.status().mode, 'running');
    t.legacy.state.device = 'revoked';
    await t.hq.legacyTick();
    assert.equal(t.hq.status().mode, 'device_revoked');
    assert.equal(t.hq.status().identity.device, 'revoked');
  } finally { await t.done(); }
});

test('no identity-service link: credentials wait with credential_unavailable (retryable), sent as a common/v1 refusal', async () => {
  const probe = definePlugin({
    name: 'credential-probe',
    version: '0.0.1',
    hostApi: 1,
    services: ['credentials'],
    async init(ctx) {
      ctx.hq.register({ op: 'grants.list', auth: 'owner', handler: () => ctx.services.credentials.resolve('ref_x', { task: 't1', operation: 'op1' }) });
    },
  });
  const t = await startHQ({ plugins: [probe] });
  try {
    const owner = await t.owner();
    const res = await owner.request('grants.list');
    assert.equal(res.refusal.error, 'credential_unavailable');
    assert.match(res.refusal.explanation, /no identity-service link/);
    assert.deepEqual(validate(errorResponseSchema, res.refusal), []);
  } finally { await t.done(); }
});
