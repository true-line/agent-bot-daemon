// definePlugin, manifest validation, plugin semver and the hq/v1 operation
// table (plan §4.1, §4.2, §4.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definePlugin, validateManifest, staticManifest, supportedHostApis, HOST_SERVICES } from '../sdk/plugin.mjs';
import { compareVersions, satisfies, validRange } from '../sdk/semver.mjs';
import { HQ_OPERATIONS, SAFE_MODE_OPERATIONS, ADMISSION_OPERATIONS } from '../sdk/operations.mjs';

const base = { name: 'agent-comms', version: '0.6.0', hostApi: 1, async init() {} };
const invalid = (m, pattern) => assert.throws(() => validateManifest(m), (e) => e.code === 'host.invalid_manifest' && pattern.test(e.message));

test('the plan §4.1 example manifest is valid', () => {
  const p = definePlugin({
    ...base,
    optional: { 'agent-bot-souls': '>=0.1.0 <1' },
    services: ['config', 'store', 'log', 'receipts', 'identityService', 'credentials', 'launch', 'events', 'approvals', 'budgets'],
    identityServiceRoutes: ['/api/daemon/notices*'],
  });
  assert.ok(Object.isFrozen(p));
  assert.equal(typeof p.start, 'function');
  assert.deepEqual(staticManifest(p).identityServiceRoutes, ['/api/daemon/notices*']);
  assert.equal(JSON.stringify(staticManifest(p)).includes('init'), false, 'plugin.json carries no code');
});

test('manifest refusals', () => {
  invalid({ ...base, name: 'Agent_Bot' }, /name must match/);
  invalid({ ...base, name: 'x'.repeat(65) }, /name must match/);
  invalid({ ...base, version: '1.0' }, /version/);
  invalid({ ...base, hostApi: 0 }, /hostApi/);
  invalid({ ...base, surprise: true }, /unknown field surprise/);
  invalid({ ...base, requires: { [base.name]: '^0.6.0' } }, /itself/);
  invalid({ ...base, requires: { a: 'latest' } }, /invalid range/);
  invalid({ ...base, requires: { a: '^1.0.0' }, optional: { a: '^1.0.0' } }, /both required and optional/);
  invalid({ ...base, services: ['filesystem'] }, /unknown host service filesystem/);
  invalid({ ...base, services: ['store', 'store'] }, /duplicates/);
  invalid({ ...base, identityServiceRoutes: ['/api/x'] }, /needs the identityService service/);
  invalid({ ...base, services: ['identityService'], identityServiceRoutes: ['api/x'] }, /absolute route/);
  invalid({ ...base, init: undefined }, /init must be a function/);
  invalid({ ...base, stop: 'later' }, /stop must be a function/);
});

test('host services match the plan §4.3 table, with no host-side secret store', () => {
  assert.deepEqual([...HOST_SERVICES].sort(), ['approvals', 'budgets', 'clock', 'config', 'credentials', 'events', 'identityService', 'launch', 'log', 'profile', 'random', 'receipts', 'store']);
});

test('hostApi window is N and N-1, never 0', () => {
  assert.deepEqual(supportedHostApis(1), [1]);
  assert.deepEqual(supportedHostApis(3), [3, 2]);
});

test('semver comparison and ranges', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-a'), -1);
  const cases = [
    ['1.4.2', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.3.1', '^0.3.0', true], ['0.4.0', '^0.3.0', false],
    ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false], ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false],
    ['0.5.0', '>=0.1.0 <1', true], ['1.0.0', '>=0.1.0 <1', false], ['0.5.0', '>=0.1.0 <1.0.0', true],
    ['1.9.0', '<=1', true], ['2.0.0', '<=1', false], ['1.3.0', '>1.2', true], ['1.2.9', '>1.2', false],
    ['1.2.7', '1.2', true], ['1.3.0', '1.2', false], ['1.7.0', '^1', true], ['1.9.9', '~1', true], ['2.0.0', '~1', false], ['3.0.0', '^1.0.0 || ^3.0.0', true],
    ['1.0.0-rc.1', '^1.0.0', false], ['1.0.0-rc.2', '>=1.0.0-rc.1', true], ['1.1.0-rc.1', '>=1.0.0-rc.1', false],
    ['9.9.9', '*', true], ['1.0.0', '=1.0.0', true], ['1.0.1', '1.0.0', false],
  ];
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `${v} ${r}`);
  assert.equal(validRange('>=0.1.0 <1'), true);
  for (const r of ['', ' ', '1.0.0 ||', '>>1.0.0', '01.2', '1.x', 'latest', 42]) assert.equal(validRange(r), false, JSON.stringify(r));
});

test('hq/v1 operations: every one has an auth class; entry points are the admission set', () => {
  for (const [op, auth] of Object.entries(HQ_OPERATIONS)) assert.ok(['owner', 'entry-point'].includes(auth), op);
  assert.deepEqual([...ADMISSION_OPERATIONS].sort(), ['Admit', 'Equip', 'Hello', 'Lease', 'Ready']);
  for (const op of ADMISSION_OPERATIONS) assert.equal(HQ_OPERATIONS[op], 'entry-point');
  for (const op of SAFE_MODE_OPERATIONS) assert.equal(HQ_OPERATIONS[op], 'owner', op);
  for (const op of ['start', 'stop', 'pause', 'resume', 'drain', 'sleep', 'move', 'fork', 'accept-revision', 'rollback-revision', 'retire']) {
    assert.equal(HQ_OPERATIONS[op], 'owner', op);
  }
});
