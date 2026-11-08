# @agent-bot/sdk

The HQ plugin contract, which the platform registers to agent-bot-daemon
as `hq-plugin-contract`. Its specification is
[docs/daemon-plugin-split.md §4](../docs/daemon-plugin-split.md#4-plugin-contract-inside-hq).
This is v0 (#78, §9 PR 7). It has no dependencies and runs on Node 20 or
later.

```js
// plugin.mjs: exactly one default export
import { definePlugin } from '@agent-bot/sdk';

export default definePlugin({
  name: 'agent-comms',
  version: '0.6.0',
  hostApi: 1,
  services: ['store', 'log'],
  async init(ctx) {
    ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler: async () => ctx.services.store.tx((tx) => tx.list('tasks')) });
  },
});
```

```js
// A plugin repository's test
import { createTestHost, checkPlugin } from '@agent-bot/sdk';

const host = createTestHost({ plugins: [plugin] });
await host.start();
await host.dispatch('tasks.list', { auth: 'owner' });

const r = await checkPlugin(plugin);
assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
```

## Modules

| Module | What it is | Plan |
| --- | --- | --- |
| `plugin.mjs` | `definePlugin` and manifest validation. Unknown fields are refused. | §4.1 |
| `declarations.mjs` | Tool and command declarations for `ctx.tools.register` and `ctx.commands.register`. Unknown fields are refused. | §4.2.1, §4.2.2 |
| `operations.mjs` | The `hq/v1` operations, the auth class of each, and the safe-mode and admission sets. | §4.2, §7.3 |
| `host.mjs` | `createHost`: resolve, identity-first bootstrap in HQ core (device status from the signer; `status`, `device.status` and `device.enroll` answered by core), init and start in dependency order, stop in reverse order under a deadline, registration, and `dispatch` with auth. | §4.2, §4.4 |
| `services.mjs` | The host services in memory: store, credentials, identityService, approvals, budgets, launch, events, receipts, log, config, clock, random and profile. | §4.3 |
| `test-host.mjs` | `createTestHost`, which adds a fake identity service with Ed25519-signed canned responses, a fake signer, a deterministic clock and random, and fake member principals. | §4.6 |
| `conformance.mjs` | `checkPlugin`, the plugin conformance suite. | §4.6 |
| `semver.mjs` | Plugin versions and dependency ranges. | §4.5 |
| `errors.mjs` | `HostError`, registry codes (wire) and `host.*` codes (in HQ only). | §4.7 |
| `wire/` | RFC 8785 canonical JSON and digests, strict JSON parsing, a JSON Schema validator for the keywords the pinned schemas use (it refuses any other keyword), and N/N−1 version and capability negotiation. | §2.3, §4.5 |

## Identity is HQ core

Per [PDR-0027](https://github.com/true-line/agent-bot-platform/blob/main/docs/04-decisions/PDR-0027-hq-identity-authority-lives-in-agent-bot-daemon.md),
enrollment, the identity-service link, the device key and signer, credential
references, grants and approvals are built into HQ, not a plugin. The host
reads device status from the signer before any plugin runs, and no plugin can
register `status`, `device.status` or `device.enroll`. agent-bot-identity's
plugin registers member surfaces only: `ctx.tools`, `ctx.commands` and
`ctx.hooks`.

## Credential custody

HQ holds the device key and short-lived credentials only in memory (D4 and
the platform's trust-domains page). The SDK keeps to that in four ways:

- `credentials.resolve` mints one token per task and operation. It holds
  the token in memory until the operation finishes, the token expires or
  the device is revoked, and never writes it to the store.
- Every live token is redacted from receipts and logs.
- `credentials.issue` gives members an opaque `credref_…`, never a token.
- `launch.member` refuses environment variables whose names look like
  secrets.

The SDK has no service for host-side credentials at rest or for signed
policy. Both stay in agent-bot-machine's admin sandbox.

## Not in v0

- **No discover or load from disk, and no `governance/plugins.json` digest
  check.** The host takes plugin objects. Reading `plugin.json`, hashing
  the installed tree and `--dev-plugins` arrive with HQ in §9 PR 12.
- **No real signer, identity-service client or daemon–machine channel.**
  The §4.7 link hardening (DPoP, response-signature checks, pinned keys)
  and the `daemon-machine-channel` seam to agent-bot-machine replace the
  fakes in later PRs.
- **No binding-proof or presence codecs yet.** They wait for the
  `observation-v1` contract that PDR-0023 assigns to soul-contracts.
