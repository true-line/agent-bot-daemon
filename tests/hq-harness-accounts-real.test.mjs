// T01 on real OS accounts (plan §9 row 16a). The CI job creates two harness
// accounts and their endpoint directories, as the provisioner would; this
// test runs HQ as the job's own account and the agent side as each harness
// account, through sudo. The lead's adapter is mapped to the first account
// and the specialist's to the second. It is the proof the logic tests cannot
// give: the kernel refuses one account at another's endpoint, and HQ refuses
// a copied binding from the right kind of endpoint.
//
//   HQ_HARNESS_DIR       the harness endpoint directory
//   HQ_HARNESS_ACCOUNTS  two account names, comma-separated
//   HQ_REQUIRE_HARNESS_ACCOUNTS=1  fail instead of skipping when unset (CI)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceBroker } from './broker-fixture.mjs';
import { DIGEST, helloOn, SOUL, startHQ } from './hq-harness.mjs';

const dir = process.env.HQ_HARNESS_DIR;
const [A, B] = (process.env.HQ_HARNESS_ACCOUNTS ?? '').split(',').filter(Boolean);
const ready = process.platform === 'linux' && dir && A && B;
if (!ready && process.env.HQ_REQUIRE_HARNESS_ACCOUNTS === '1') {
  test('harness accounts are required here', () => assert.fail('HQ_REQUIRE_HARNESS_ACCOUNTS=1 but HQ_HARNESS_DIR and HQ_HARNESS_ACCOUNTS are not set on Linux'));
}

// Run the standalone broker client as `account`. The spawn is asynchronous:
// HQ is serving in this process.
const as = (account, client, input) => new Promise((resolve, reject) => {
  execFile('sudo', ['-n', '-u', account, process.execPath, client, JSON.stringify(input)], { timeout: 20_000 }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`broker client as ${account} failed: ${err.message} ${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});

test('T01 on real accounts: the kernel and HQ both refuse an account that is not the runtime\'s', { skip: ready ? false : 'needs two harness accounts (CI creates them)' }, async () => {
  // The harness accounts cannot read the checkout, so the client goes to /tmp.
  const pub = mkdtempSync('/tmp/hq-member-client-');
  chmodSync(pub, 0o755);
  const client = join(pub, 'member-client.mjs');
  copyFileSync(fileURLToPath(new URL('./member-client.mjs', import.meta.url)), client);
  chmodSync(client, 0o644);

  const config = { acceptedDefinitions: { [SOUL]: [DIGEST] }, harnesses: { dir, accounts: { 'adapter-a': A, 'adapter-b': B } } };
  let t = await startHQ({ platform: 'linux', config, plugins: [referenceBroker()], realSudo: true });
  const { home } = t;
  try {
    const endpoint = (account) => t.status.hq.sockets.harnesses.find((m) => m.account === account).path;
    const entry = await t.entry();
    const admitted = (await entry.request('Hello', helloOn('adapter-a', 'adapter-b'))).result.admitted_runtimes;
    const lead = admitted.find((a) => a.role === 'lead');
    const spec = admitted.find((a) => a.role === 'specialist');
    const bind = (rt, key = rt.channel_binding) => ({ bind: { runtime_id: rt.runtime_id, key } });
    const code = (out) => out.responses[0].refusal?.error ?? out.responses[0].host_refusal?.code;

    const check = async () => {
      // A is A.
      const own = await as(A, client, { path: endpoint(A), steps: [bind(lead)] });
      assert.equal(own.connected, true, JSON.stringify(own));
      assert.equal(own.responses[0].ok, true, JSON.stringify(own));
      assert.equal(own.responses[0].result.member_id, 'm_lead');
      // B cannot open A's endpoint at all: the kernel refuses the connect.
      const trespass = await as(B, client, { path: endpoint(A), steps: [bind(lead)] });
      assert.deepEqual(trespass, { connected: false, error: 'EACCES' });
      // B, on its own endpoint, presents A's runtime and A's binding.
      const copied = await as(B, client, { path: endpoint(B), steps: [bind(lead)] });
      assert.equal(copied.connected, true);
      assert.equal(code(copied), 'caller_mismatch', JSON.stringify(copied));
      // A, on its own endpoint, without its runtime's key.
      const keyless = await as(A, client, { path: endpoint(A), steps: [bind(lead, spec.channel_binding)] });
      assert.equal(code(keyless), 'caller_mismatch', JSON.stringify(keyless));
      // Neither account reaches HQ's own sockets.
      for (const account of [A, B]) {
        assert.equal((await as(account, client, { path: t.hq.paths.broker, steps: [] })).connected, false);
        assert.equal((await as(account, client, { path: t.hq.paths.control, steps: [] })).connected, false);
      }
      // HQ's own account, on the shared socket, does not speak for A either.
      const shared = await t.member();
      assert.equal((await shared.request('bind', { runtime_id: lead.runtime_id, channel_binding: lead.channel_binding })).refusal.error, 'caller_mismatch');
      // B is still B.
      const other = await as(B, client, { path: endpoint(B), steps: [bind(spec)] });
      assert.equal(other.responses[0].ok, true, JSON.stringify(other));
    };

    await check();
    const receipts = t.hq.core.receipts.filter((r) => r.kind === 'hq.bind');
    assert.deepEqual(receipts.map((r) => [r.member_id, r.caller_account, r.proof]), [['m_lead', A, 'hmac-sha256'], ['m_spec', B, 'hmac-sha256']]);

    // Still after a restart, from the store.
    await t.done({ keep: true });
    t = await startHQ({ home, platform: 'linux', config, plugins: [referenceBroker()], realSudo: true });
    await check();
  } finally {
    await t.done();
    rmSync(pub, { recursive: true, force: true });
  }
});
