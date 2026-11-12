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
| Harness accounts ([§9 row 16a](../docs/daemon-plugin-split.md#stage-2a-member-isolation-wp2), Linux; D7 as amended by platform PDR-0053): with `harnesses` in the config, each harness account gets its own broker endpoint, `<dir>/<account>/broker.sock`, mode 0660 in a 2750 directory of that account's private group, so the file system tells HQ which account is calling. Accounts are keyed by adapter ID and shared by the agents of every Soul on that harness; several adapters may name one account, which then has one endpoint. A runtime is bound at admission to the account of its role's adapter, and that is kept in the store. It then binds only from that account's endpoint and only with a keyed proof: `bind.challenge { runtime_id }` returns a nonce, and `bind { runtime_id, proof }` answers with HMAC-SHA-256 over it, keyed with the channel binding, which is never sent. Anything else is `caller_mismatch`. The endpoint proves the account, the harness credential; two agents in one account are told apart only by the proof, and are one trust domain to the host. A role whose adapter has no account stays on the shared socket. HQ verifies the directory layout and refuses to start on any other; the provisioner makes it. | `harness-accounts.mjs`, `admission.mjs`, `hq.mjs` | §9 row 16a |
| Agent launch ([§9 row 16b](../docs/daemon-plugin-split.md#stage-2a-member-isolation-wp2), Linux): HQ starts an agent in its harness account, as its parent, through the sudoers rule agent-bot-machine installs, in one fixed form: `sudo -n -H -u <account> -- /bin/sh -c '<shell>' sh <soul_id> <member_id> <command>`, where the fixed shell creates `$HOME/.agent-bot-hq/souls/<soul_id>/<member_id>/` at 0700 as that account and starts the command there; the IDs and the command are arguments, never part of the script. The child gets only the four `AGENT_BOT_SOULS_*` variables a request may set, `AGENT_BOT_SOULS_BROKER` set by HQ to the account's own endpoint, and a fixed `PATH`. On the admission socket, the connection that owns the runtime sends `launch { runtime_id, command, env }` and gets a launch ID and a one-time token (30 seconds); `launch.attach { launch_id, attach }`, the first and only request on a new connection, starts the agent and makes that connection its stdin and stdout. One launch runs per Soul and agent. sudo runs detached. Before the agent starts, the fixed shell reads its own process group from `/proc/self/stat` and prints `agent-bot-hq-launch pgid <n>` on stderr; HQ takes the first such line as the launch's group and does not log it (no marker within five seconds of a stop: sudo's pid). `launch.stop { launch_id }`, a closed connection and HQ's own stop close the agent's stdin and send `kill -TERM -<pgid>`, then `kill -KILL -<pgid>` after a grace period, as the account; an agent that exits on its own gets the KILL to its group. Nothing else is signalled: a process that leaves its group (setsid, or a group of its own) is not stopped by HQ and keeps running in the harness account, whose agents are one trust domain; containing it needs a cgroup and so root. A failed signal, or sudo still running after the KILL, leaves the launch `uncontained`: its slot is held until HQ restarts and its receipt says `contained: false`. Account homes are verified at start (a directory owned by the account, mode exactly 0700); a bad one refuses the start. HQ asks sudo once per account whether the rule covers it; without it HQ serves row 16a and refuses launch for that account. `status` lists launches and each account's readiness, never commands or environments; receipts `hq.launch`, `hq.launch.refused` and `hq.launch.exited` carry a digest of the command, never the environment or the token. Agent stderr goes to HQ's log, clipped and rate limited, with the agent's token replaced by `[redacted]` first. If sudo cannot be run at all (missing or not executable), nothing starts: the exit receipt says `reason: 'spawn-failed'` with the error code in `spawn_error`, the slot is freed, and launch in that account is unavailable until HQ restarts. Any other spawn error (the process limit, for example) gives the same receipt and fails that launch only. | `launch.mjs`, `harness-accounts.mjs`, `socket.mjs`, `hq.mjs` | §9 row 16b |
| Owner sessions: one per control connection, recorded in the store and closed on disconnect or at the next start. | `hq.mjs` | §7.2 |
| Profile reporting: the profile in force, with the reasons a stronger one is not. Never `managed-protected` before §9 PR 16. | `profile.mjs` | §3.3, R8 |
| Task service ([§9 PR 13](../docs/daemon-plugin-split.md#stage-1-local-vertical-slice-wp2wp4), #40): `task/v1` records in the store, the `task-v1` provider (platform PDR-0024). Members commit through `task.commit` with their runtime, over the admission connection or brokered with their bound runtime; only the task Soul's current lead at the current epoch and lease commits, and a specialist's request is recorded as a proposal (T20). CAS on the expected revision (`revision_conflict`), one commit per operation ID with the stored receipt for an exact repeat (T05), write-scope exclusion (`write_scope_conflict`, unless listed in `concurrentWriters`), and offers whose requester is their authenticated source (T04). The owner offers a task with `tasks.offer` and reads `tasks.list` and `tasks.get`. A bound member reads its Soul's waiting directives with the `task.directives` kind, each a wire/v1 directive-or-query record for a task the owner or HQ offered, and one of its Soul's tasks with `task.get`. A peer's offer is never a directive. | `tasks.mjs` | §4.2, 0.4 §7 |
| hq/v1 Hello (with the admission result), Admit, Equip, Ready and Lease, checked against the pinned schemas in both directions. Versions are N/N−1 (T14). The owner's config holds the accepted definitions, there is one current installation epoch per Soul (T15), and leases have generations and renewal sequences. Runtimes are bound to the admitting connection. | `admission.mjs` | §4.2, 0.4 §5 |
| Bootstrap per §4.4 through the SDK host. Device status comes from the legacy enrollment, so an unenrolled device or an unreadable signer is safe mode, and a revoked device is `device_revoked`. With no identity-service link yet, credentials refuse with `credential_unavailable`. | `hq.mjs`, `legacy.mjs` | §4.4, §4.7 |
| Installed plugins: one directory per plugin, with `plugin.json` (static fields) and `plugin.mjs`. Before any plugin code runs, the tree's sha256-manifest-v1 digest must match its pin in [`governance/plugins.json`](../governance/plugins.json), and the set must resolve from `plugin.json` alone. The code's `definePlugin` fields must then equal `plugin.json`. Symlinks are refused. A refused plugin gets a `hq.plugin.refused` receipt and a reason in status, and its dependents are refused with it. `--dev-plugins` skips the pin and status always names it. Core names (`hq`, `hq-admission`, `hq-tasks`) cannot be taken. | `plugins.mjs` | §4.1, §4.5 |
| The HQ signer ([§9 row 15a](../docs/daemon-plugin-split.md#stage-2a-member-isolation-wp2)): one pinned P-256 key, used only through `sign`. Approval records carry its ES256 signature. The `software` backend keeps a key file in `signer/` (transition custody, `key_storage=software`); the `helper` backend runs an external helper that holds a hardware key and HQ keeps no key file (`key_storage=hardware`). HQ pins the public key's thumbprint, verifies every signature against it, and treats a missing or changed key as an unavailable signer, which is safe mode. `status` names the backend and custody, and a software key is a stated reason the profile is not `managed-protected`. `signer rekey` replaces the key while HQ is stopped. | `signer.mjs` | §3.2, §4.4 |
| HQ's own enrollment ([§9 row 15c](../docs/daemon-plugin-split.md#stage-2a-member-isolation-wp2)), when `enrollment.source` is `hq`: the identity service's device-code grant with the proof signed by the signer's key, so the device record names that key and its `key_storage`. `device.enroll` returns the code to approve and HQ polls in the background; `device.status` and `status` show pending, approved or failed, and the outcome is a receipt. Re-enrollment makes a fresh key first, and a revoked record is never reused. It also builds the jwt-bearer assertion the identity-service link will send. | `enrollment.mjs` | §4.4, §4.7 |
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
  "enrollment": { "source": "hq", "server": "https://agents.true-line.ai" },
  "features": { "hardwareSigner": true },
  "signer": { "backend": "helper", "command": ["/usr/local/libexec/hq-signer"] }
}
```

`enrollment.source` says where device status and enrollment come from.
`legacy` (the default) is the existing agent-bot's enrollment, read through
its CLI. `hq` is HQ's own enrollment with the identity service at
`enrollment.server`, on the signer's key: `node hq/main.mjs enroll --harness
NAME` starts the device-code grant, prints the code to approve, and waits.
HQ is enrolled from its next start. `--force` re-enrolls with a fresh key.

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
under the `software` backend only, its key file. With `enrollment.source`
`hq` it also holds `identity/` (0700): the device record, the record a
re-enrollment replaced, and the pinned response-signing key. None of those
is a secret.

`harnesses` (Linux only) gives each harness its OS account, one per harness
credential ([platform PDR-0053](https://github.com/true-line/agent-bot-platform/blob/main/docs/04-decisions/PDR-0053-soul-life-and-agent-replace-member.md)):
`{ "dir": "/run/agent-bot-hq/members", "accounts": { "<adapter ID>": "<account>" } }`.
The default directory's name predates PDR-0053. The 16a key `members` is
refused. An agent's working state is in its own directory in its harness
account's home, outside this directory, and an agent HQ starts there can
read nothing in this directory, connect to none of its sockets, and run none
of HQ's tooling against it (T02, run in CI on two throwaway accounts).
Launches are in memory only: after a restart nothing runs under HQ.

## Interim account: D4's stated risk

D6 puts HQ in its own account (`_agent-bot-hq` on macOS, `agent-bot-hq` on
Linux), which agent-bot-machine creates in its S6 slice. Until that account
exists, HQ runs in the owner's `user` account. D4's stated residual risk
then covers HQ too: any process in `user` can read HQ's store and connect
to every socket, and so can every agent that runs in `user`, which is
every agent unless HQ starts it in a harness account (row 16b). The file mode is the only access check,
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

- The rest of the Linux protected profile (§9 rows 16c and 16d). Rows 16a
  and 16b make HQ tell harness accounts apart and start agents in them; HQ
  does not create the accounts or install the sudoers rule (that is
  agent-bot-machine's), and it does not block their network (16c). HQ
  still reports `managed-cooperative`. Without `harnesses` the reason is
  that agents of every harness share one account; with it, the reasons name
  any admitted agent whose harness has no account and any account HQ cannot
  launch in. HQ's own account, the qualification and a hardware key remain
  stated reasons. The Soul entry point in agent-bot-souls does not start
  agents through HQ yet; an agent's working directory is not captured into
  its Soul's package; a launched agent is not stopped when its runtime's
  lease expires or is superseded; HQ does not clean up after a crash, so an
  agent left by a crashed HQ runs on until the owner ends it; and a process
  that leaves its launch's group is not stopped by HQ (containing it needs a
  cgroup, which needs root).
  The agent-comms broker plugin
  ([agent-bot-comms#312](https://github.com/true-line/agent-bot-comms/pull/312))
  and the Soul runtime
  ([agent-bot-souls#3](https://github.com/true-line/agent-bot-souls/pull/3))
  bind by the challenge. Nothing creates the endpoint directories yet; that
  is agent-bot-machine's.
- Signed plugin packages and plugin upgrade. The pins file is the only
  trust anchor, and changing it is a reviewed change to this repository.
- The rest of the signer row (§9 rows 15b to 15d): the Secure Enclave
  helper and qualification of the TPM helper on real hardware, and soul
  tokens without `vouch-key.pem`.
- Making HQ's enrollment the default. On 2026-11-10 a throwaway HQ on macOS
  enrolled with the real identity service on a software key: the service
  accepted the signed proof, the owner approved the code, and HQ came up
  enrolled after a restart. That device has not been used for anything
  since, because HQ cannot ask for an access token yet (the link, PRs 10
  and 18), so `enrollment.source` stays `legacy`. Unlike the legacy
  client, a forced re-enrollment does not keep the old enrollment alive
  while the new grant is pending.
- The identity-service link (PRs 10 and 18), grants and credential references in Equip (PRs 18 and 21), and
  `accept-revision` (PR 21).
- The HQ account, the peer-credential check and the service unit (#88,
  after agent-bot-machine S6), and the Windows named pipe (#89).
- A soul-contracts schema for the hq/v1 request envelope and for the
  Ready/Lease reply. The framing here is HQ's until soul-contracts specifies
  them.
