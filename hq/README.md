# HQ skeleton

The first slice of [§9 PR 12](../docs/daemon-plugin-split.md#stage-1-local-vertical-slice-wp2wp4)
(#39): HQ core running on the SDK's plugin host ([sdk/](../sdk/README.md)),
beside the existing per-account daemon, which it leaves unchanged
(strangler). No dependencies; Node 20 or later.

```sh
node hq/main.mjs run      # foreground; state in $AGENT_BOT_HQ_HOME or ~/.agent-bot-hq
node hq/main.mjs run --plugins DIR       # also load installed plugins, pinned
node hq/main.mjs run --dev-plugins DIR   # load unpinned plugins; status says so
node hq/main.mjs status   # ask the running HQ, over the control socket
node hq/main.mjs souls    # admitted Souls and their runtimes
```

## What it does

| Piece | Module | Plan |
| --- | --- | --- |
| Durable store: the SDK's tables, blobs and receipts, written atomically to `store.json` (0600) in a 0700 directory. It refuses a wider directory and never overwrites a store it cannot read. | `store.mjs` | §3.2, §4.3 |
| Control socket (owner), admission socket (entry points) and member broker socket. The auth class is the socket, never a client field. Strict NDJSON. Registry refusals are common/v1 error responses; host refusals go in a separate `host_refusal` field. | `socket.mjs` | §7.1, §7.2 |
| Member broker socket ([§9 row 13b](../docs/daemon-plugin-split.md#49-the-member-broker-socket-stage-1)): `broker.sock`, whose frames go to the one plugin serving the broker (`ctx.broker.serve`). It binds a connection with `bind { runtime_id, channel_binding }` through hq-admission's `verifyBinding` and delivers later frames with `ctx.broker.deliver`; consumers authorize by the bound runtime. agent-comms ships the broker plugin; HQ alone refuses every frame with `host.no_broker`. | `hq.mjs`, `socket.mjs` | §4.9 |
| Owner sessions: one per control connection, recorded in the store and closed on disconnect or at the next start. | `hq.mjs` | §7.2 |
| Profile reporting: the profile in force, with the reasons a stronger one is not. Never `managed-protected` before §9 PR 16. | `profile.mjs` | §3.3, R8 |
| Task service ([§9 PR 13](../docs/daemon-plugin-split.md#stage-1-local-vertical-slice-wp2wp4), #40): `task/v1` records in the store, the `task-v1` provider (platform PDR-0024). Members commit through `task.commit` with their runtime, over the admission connection or brokered with their bound runtime; only the task Soul's current lead at the current epoch and lease commits, and a specialist's request is recorded as a proposal (T20). CAS on the expected revision (`revision_conflict`), one commit per operation ID with the stored receipt for an exact repeat (T05), write-scope exclusion (`write_scope_conflict`, unless listed in `concurrentWriters`), and offers whose requester is their authenticated source (T04). The owner offers a task with `tasks.offer` and reads `tasks.list` and `tasks.get`. A bound member reads its Soul's waiting directives with the `task.directives` kind, each a wire/v1 directive-or-query record for a task the owner or HQ offered, and one of its Soul's tasks with `task.get`. A peer's offer is never a directive. | `tasks.mjs` | §4.2, 0.4 §7 |
| hq/v1 Hello (with the admission result), Admit, Equip, Ready and Lease, checked against the pinned schemas in both directions. Versions are N/N−1 (T14). The owner's config holds the accepted definitions, there is one current installation epoch per Soul (T15), and leases have generations and renewal sequences. Runtimes are bound to the admitting connection. | `admission.mjs` | §4.2, 0.4 §5 |
| Bootstrap per §4.4 through the SDK host. Device status comes from the legacy enrollment, so an unenrolled device or an unreadable signer is safe mode, and a revoked device is `device_revoked`. With no identity-service link yet, credentials refuse with `credential_unavailable`. | `hq.mjs`, `legacy.mjs` | §4.4, §4.7 |
| Installed plugins: one directory per plugin, with `plugin.json` (static fields) and `plugin.mjs`. Before any plugin code runs, the tree's sha256-manifest-v1 digest must match its pin in [`governance/plugins.json`](../governance/plugins.json), and the set must resolve from `plugin.json` alone. The code's `definePlugin` fields must then equal `plugin.json`. Symlinks are refused. A refused plugin gets a `hq.plugin.refused` receipt and a reason in status, and its dependents are refused with it. `--dev-plugins` skips the pin and status always names it. Core names (`hq`, `hq-admission`, `hq-tasks`) cannot be taken. | `plugins.mjs` | §4.1, §4.5 |
| The HQ signer ([§9 row 15a](../docs/daemon-plugin-split.md#stage-2a-member-isolation-wp2)): one pinned P-256 key, used only through `sign`. Approval records carry its ES256 signature. The `software` backend keeps a key file in `signer/` (transition custody, `key_storage=software`); the `helper` backend runs an external helper that holds a hardware key and HQ keeps no key file (`key_storage=hardware`). HQ pins the public key's thumbprint, verifies every signature against it, and treats a missing or changed key as an unavailable signer, which is safe mode. `status` names the backend and custody, and a software key is a stated reason the profile is not `managed-protected`. `signer rekey` replaces the key while HQ is stopped. | `signer.mjs` | §3.2, §4.4 |
| The existing daemon is probed and reported. It is started only when `legacy.supervise` is on, and never stopped. | `legacy.mjs` | §8.2 |

## State directory

`config.json` is optional and written by the owner. HQ refuses it if group or
others can write it, and refuses unknown keys:

```json
{
  "acceptedDefinitions": { "agent_<uuid>": ["sha256:<64 hex>"] },
  "leaseTtlMs": 60000,
  "concurrentWriters": ["workspace:shared"],
  "standalone": false,
  "legacy": { "supervise": false, "probeIntervalMs": 30000 },
  "features": { "hardwareSigner": true },
  "signer": { "backend": "helper", "command": ["/usr/local/libexec/hq-signer"] }
}
```

`features` holds feature flags, all off by default. `hardwareSigner` gates
the `helper` signer backend: with it off, HQ refuses a config that names a
helper, and everything else runs on the `software` backend. The hardware
path is experimental until its helpers are qualified on real hardware (§9
row 15b), and no other work waits on it. `status` reports the flag.

[`helpers/tpm2-signer.mjs`](../helpers/tpm2-signer.mjs) is the TPM 2.0
helper for Linux. It needs `tpm2-tools` and access to the TPM device, keeps
the key at a persistent handle inside the TPM, and is tested in CI against a
software TPM only. Its header states its limits.

`signer` is optional. Without it the backend is `software`. A `helper` is
named by absolute path and speaks `agent-bot-hq-signer/1`, described at the
top of [`signer.mjs`](signer.mjs). Changing the backend of a pinned key needs
`node hq/main.mjs signer rekey` with HQ stopped; until then HQ starts in safe
mode and says why.

The directory also holds `store.json`, `control.sock`, `admission.sock` and
`broker.sock`, all 0600, and `signer/` (0700) with the signer's pin and,
under the `software` backend only, its key file.

## Interim account: D4's stated risk

D6 puts HQ in its own account (`_agent-bot-hq` on macOS, `agent-bot-hq` on
Linux), which agent-bot-machine creates in its S6 slice. Until that account
exists, HQ runs in the owner's `user` account. D4's stated residual risk
then covers HQ too: any process in `user`, members included, can read HQ's
store and connect to every socket. The file mode is the only access check,
because Node has no peer-credential API. HQ reports `managed-cooperative`
and names the account as a reason. The skeleton holds no credentials and no
grants. Under the default `software` signer backend it does hold one secret:
the signer's key file, which any process in that account can copy. That key
signs approval records only; it is not the enrolled device key yet, and
`status` and the profile reasons say it is a key file. The `helper` backend
keeps no key file. This is
HQ-RISK-07 in plan §10.3. Moving HQ to its own account, with a
peer-credential check and a service unit, is #88.

## Not in this slice

- Signed plugin packages and plugin upgrade. The pins file is the only
  trust anchor, and changing it is a reviewed change to this repository.
- The rest of the signer row (§9 rows 15b to 15d): the Secure Enclave
  helper and qualification of the TPM helper on real hardware, enrollment and re-enrollment with the
  identity service on the signer's key, and soul tokens without
  `vouch-key.pem`. Until then device status still comes from the legacy
  enrollment, whose device key is not the signer's.
- The identity-service link (PRs 10 and 18), grants and credential references in Equip (PRs 18 and 21), and
  `accept-revision` (PR 21).
- The HQ account, the peer-credential check and the service unit (#88,
  after agent-bot-machine S6), and the Windows named pipe (#89).
- A soul-contracts schema for the hq/v1 request envelope and for the
  Ready/Lease reply. The framing here is HQ's until soul-contracts specifies
  them.
