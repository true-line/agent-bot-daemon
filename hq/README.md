# HQ skeleton

The first slice of [§9 PR 12](../docs/daemon-plugin-split.md#stage-1-local-vertical-slice-wp2wp4)
(#39): HQ core running on the SDK's plugin host ([sdk/](../sdk/README.md)),
beside the existing per-account daemon, which it leaves unchanged
(strangler). No dependencies; Node 20 or later.

```sh
node hq/main.mjs run      # foreground; state in $AGENT_BOT_HQ_HOME or ~/.agent-bot-hq
node hq/main.mjs status   # ask the running HQ, over the control socket
node hq/main.mjs souls    # admitted Souls and their runtimes
```

## What it does

| Piece | Module | Plan |
| --- | --- | --- |
| Durable store: the SDK's tables, blobs and receipts, written atomically to `store.json` (0600) in a 0700 directory. It refuses a wider directory and never overwrites a store it cannot read. | `store.mjs` | §3.2, §4.3 |
| Control socket (owner) and admission socket (entry points). The auth class is the socket, never a client field. Strict NDJSON. Registry refusals are common/v1 error responses; host refusals go in a separate `host_refusal` field. | `socket.mjs` | §7.1, §7.2 |
| Owner sessions: one per control connection, recorded in the store and closed on disconnect or at the next start. | `hq.mjs` | §7.2 |
| Profile reporting: the profile in force, with the reasons a stronger one is not. Never `managed-protected` before §9 PR 16. | `profile.mjs` | §3.3, R8 |
| hq/v1 Hello (with the admission result), Admit, Equip, Ready and Lease, checked against the pinned schemas in both directions. Versions are N/N−1 (T14). The owner's config holds the accepted definitions, there is one current installation epoch per Soul (T15), and leases have generations and renewal sequences. Runtimes are bound to the admitting connection. | `admission.mjs` | §4.2, 0.4 §5 |
| Bootstrap per §4.4 through the SDK host. Device status comes from the legacy enrollment, so an unenrolled device or an unreadable signer is safe mode, and a revoked device is `device_revoked`. With no identity-service link yet, credentials refuse with `credential_unavailable`. | `hq.mjs`, `legacy.mjs` | §4.4, §4.7 |
| The existing daemon is probed and reported. It is started only when `legacy.supervise` is on, and never stopped. | `legacy.mjs` | §8.2 |

## State directory

`config.json` is optional and written by the owner. HQ refuses it if group or
others can write it, and refuses unknown keys:

```json
{
  "acceptedDefinitions": { "agent_<uuid>": ["sha256:<64 hex>"] },
  "leaseTtlMs": 60000,
  "standalone": false,
  "legacy": { "supervise": false, "probeIntervalMs": 30000 }
}
```

The directory also holds `store.json`, `control.sock` and `admission.sock`,
all 0600.

## Interim account: D4's stated risk

D6 puts HQ in its own account (`_agent-bot-hq` on macOS, `agent-bot-hq` on
Linux), which agent-bot-machine creates in its S6 slice. Until that account
exists, HQ runs in the owner's `user` account. D4's stated residual risk
then covers HQ too: any process in `user`, members included, can read HQ's
store and connect to both sockets. The file mode is the only access check,
because Node has no peer-credential API. HQ reports `managed-cooperative`
and names the account as a reason. The skeleton holds no credentials, no
grants and no signing key, so nothing it stores is a secret. This is
HQ-RISK-07 in plan §10.3. Before HQ moves to its own account, a
peer-credential check must replace the file mode.

## Not in this slice

- Discover and load from disk, the `governance/plugins.json` digest check
  and `--dev-plugins` (§4.5). HQ loads its built-in plugin set.
- The real signer and enrollment (§9 PR 15), the identity-service link (PRs
  10 and 18), grants and credential references in Equip (PRs 18 and 21), and
  `accept-revision` (PR 21).
- Windows named pipes, and a launchd or systemd unit.
- A soul-contracts schema for the hq/v1 request envelope and for the
  Ready/Lease reply. The framing here is HQ's until soul-contracts specifies
  them.
