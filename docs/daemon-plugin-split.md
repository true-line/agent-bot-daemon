# Splitting agent-bot into a daemon (HQ) and plugins

**Status:** Draft. This is the implementation plan for HQ and its plugins.
The soul-contracts pin (§4.6) is built; nothing else in it is yet.
**Decision owner:** the owner.
**Platform:** [true-line/agent-bot-platform](https://github.com/true-line/agent-bot-platform),
read at `main`, is the product source of truth (platform PDR-0001, PDR-0020).
The requirements (R1–R12), conformance tests (T01–T30), architecture, trust
domains, repository catalog, seams and cross-repository decisions live there.
This plan links to them and does not restate them. This repository's charter
is its [catalog entry](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/repository-catalog.md#agent-bot-daemon). Where this plan and the
platform disagree, the platform wins, and the conflict is recorded in the
platform's [drift register](https://github.com/true-line/agent-bot-platform/blob/main/docs/00-governance/drift-register.md).
**What stays here:** the plugin contract (§4, the current home of the
`hq-plugin-contract` seam), HQ's owner-interface design (§7), the migration
plan (§9), this repository's decisions (§10.1) and the module inventory
(Appendix A).
**Governing spec:** *Soul Agent Platform*, whitepaper draft 0.4 (2026-10-27),
called **0.4** below. The platform pins it as source S6
([frozen conversion](https://github.com/true-line/agent-bot-platform/blob/main/docs/papers/soul-platform-draft-0.4.md)). Where 0.4
and an accepted platform decision differ, the decision wins.
**Sources read, pinned:**

| Source | Ref |
| --- | --- |
| Soul Agent Platform, draft 0.4 | DOCX supplied 2026-10-27, SHA-256 `6e8b85af…dd3030` |
| Native Shareable Soul Packages, draft 0.3 (0.4's [S4]) | Two-page overview; full paper at Zenodo 10.5281/zenodo.23547566 |
| `qwts/agent-bot-identity` | `959daf9` (v0.13.0, after #1181 server mode) |
| `qwts/agent-comms` | `09f1a52` (v0.5.4) |
| agent-bot server API, as deployed | `https://agents.true-line.ai/docs/api.md`, read 2026-10-27 through its deployment alias; response key `kid` `KAqTzL7HfHmOiSbT` |
| Org / SOP | `qwts/qwts-agent-org@180f6dd`, `qwts/qwts-agent-sop@ee554a3` |

## 0. Summary

- **0.4 is the target.** HQ is a trusted local host service in its own
  account. It runs admission, grants, approvals, budgets, the task and action
  ledgers, and the broker. The agent-bot server is the **identity service**:
  it holds keys, mints short-lived device-bound tokens and records each
  issuance, and never gets lifecycle or execution control. Relays route
  sealed frames and nothing else. The Soul (its entry point and members) is
  untrusted for authority.
- **The repositories map onto 0.4** as the platform's
  [repository catalog](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/repository-catalog.md) charters them (platform PDR-0002):
  - **agent-bot-daemon** is HQ: admission, grants, approvals, budgets, the
    task and action ledgers, the device key and the plugin host.
  - **agent-bot-identity** is the identity toolset inside each Soul: the
    `agent-bot` CLI, hooks, the fail-closed `gh` and attribution. Its HQ
    half moves to agent-bot-daemon.
  - **agent-comms** provides the broker in HQ, the comms client in the
    Soul, and relay mode for the relays.
  - **agent-bot-souls** is the Soul runtime: the entry point, member
    supervision and dreams. **soul-package** owns the package format,
    validation and render, and **soul-adapters** the per-harness adapters.

  Inside HQ, plugins talk only through host services and events.
- **This replaces the first version of this plan.** That version treated the
  daemon as untrusted, put approvals and policy on the server, and added
  server-to-daemon RPC over the relay. All three contradict 0.4 (R2, R3,
  §3), and §10.4 records what changed and why.
- **The soul package follows 0.4 §11:** `Example.soul/Contents/` with
  `SoulInfo.json`, `SoulLock.json`, `primitives/`, `memorial/`, `dreams/`,
  `comms/`, `home/<member>/` and `workspaces/`. Formats 1 and 2 migrate to
  it, and SOUL.md becomes the persona primitive.
- **The migration is 30 small PRs, mapped to 0.4's stages 0–4 and work
  packages WP1–WP7.** Stage 0 happens in place in `agent-bot-identity`
  behind golden tests. HQ then wraps the existing daemon (strangler) before
  taking over its authority. The `agent-bot` CLI and MCP tools keep working
  throughout.

## 1. Where we start

### 1.1 Facts

- **agent-bot-identity** has 286 runtime `.mjs` files outside `tests/`,
  `scripts/` and `tools/`. 47 of them are one-line re-export shims left by
  ADR-0645 step 6, which leaves 239 real modules and about 75.6k lines. On
  top of that come `keyd/` (Rust), `hooks/`, `web/` and the tests.
- **`governance/runtime-modules.json`** assigns each file to one of these
  modules: `identity`, `soul`, `comms`, `harness`, `org`, `shared`, `host`
  or `cli`. `tests/module-boundaries.test.mjs` enforces the import rules,
  and the published entries are `identity-host`, `identity-soul`,
  `identity-cli`, `identity-format`, `daemon-client` and
  `identity-presence`. This plan uses that map as the starting inventory,
  and it is the WP1 compatibility inventory 0.4 Appendix E asks for
  (Appendix A here).
- **Today's daemon is one process per OS user,** running in the same account
  as its souls (ADR-0332 decision 1, ENG-0339). By 0.4's definitions that is
  at best the **managed cooperative** profile, because HQ-like functions
  share a trust domain with the members. Where App keys sit in readable
  files it is closer to **standalone unenforced**. It already composes modules through injected
  ports (`createIdentityRoutes`, `createSoulRoutes` in `agent-daemon.mjs`
  around L575–589), which is the seed of the plugin contract.
- **An extraction is already approved.** `docs/identity-extraction-plan.md`
  extracts identity to `qwts/agent-identity`, and the owner answered its
  questions on 2026-10-11. This plan replaces that end state (D1).
- **The identity service exists in part** (`identity/server-client.mjs`,
  #1181, opt-in). It has:
  - RFC 8628 device enrollment;
  - a software P-256 device key in `device-key.pem`;
  - 15-minute DPoP-bound tokens;
  - Ed25519-signed responses;
  - repo-scoped installation tokens;
  - notices (`peek`, `take`, `ack`, `release`);
  - App webhooks.

  It doesn't yet bind mints to grants, keep issuance records, offer an
  owner-unlock vault, or check hardware attestation (0.4 §4, Appendix A).
  The server's canonical address is `agents.true-line.ai`.
- **The other repositories.** agent-bot-souls is empty and designated as the
  Soul runtime's home; soul-package and soul-adapters are skeletons;
  agent-comms is active in `qwts` (catalog, platform PDR-0002).

### 1.2 0.4 components and where they live

The platform owns this map. Its [architecture](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/overview.md) places 0.4's
components, and its [repository catalog](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/repository-catalog.md) assigns each one to a
repository.

### 1.3 Size by destination

This is the result of the inventory in Appendix A. Appendix A names plugin
destinations; the second column gives the catalog repository for each.

| Appendix A target | Repository (catalog) | Files | Lines |
| --- | --- | ---: | ---: |
| `soul-runtime` (core, HQ side, entry point) | agent-bot-souls; package and render code to soul-package | 98 | 30,284 |
| `daemon` (HQ core, member surfaces, CLI, SDK, org) | agent-bot-daemon | 63 | 22,393 |
| `identity` | agent-bot-identity for the CLI, hooks and attribution; HQ authority to agent-bot-daemon core (PDR-0027) | 49 | 14,773 |
| `comms` (agent-bot side) | agent-comms | 14 | 4,087 |
| `comms` (today's agent-comms) | agent-comms | 105 | 12,683 |
| `identity service` | true-line/agent-bot | 9 | 2,258 |
| `deprecated` | none | 6 | 1,848 |

## 2. Inventory and dependency map

The full per-module table is **Appendix A**. It gives each module's lines,
current module, target, 0.4 trust domain, filesystem/worktree/keyd/comms
coupling, fan-in and fan-out, cross-repo imports and cycle membership. This
section summarises it.

### 2.1 Mapping rules

| Current ADR-0645 module | Goes to |
| --- | --- |
| `identity` | HQ authority (enrollment, the identity-service link, device key and signer, grants, approvals, credential references) becomes part of HQ core in agent-bot-daemon, not a plugin (PDR-0027). The tools members run (gh shim, credential helper, git hooks) stay in agent-bot-identity on the Soul side and are cooperative-profile only; its HQ plugin registers only member surfaces (MCP tools, CLI commands, hook handlers) that resolve to broker queries. Key custody, secret stores and App management go to the identity service; the inbox is deprecated. |
| `soul` | The Soul runtime, in three parts: `core/` (pure, used on both sides), `hq/` (validation, render, admission, launch, transfer) and `entry-point/` (front door, members, recovery). The entry point goes to agent-bot-souls, package validation, digests and render to soul-package, and adapter manifests to soul-adapters. |
| `comms` | agent-comms: broker mode in HQ, client mode in the Soul. |
| `host`, `cli` | agent-bot-daemon. The member-facing surfaces (`agent-bot mcp`, `reach-mcp`, the hook runner) run in the Soul and only ask HQ. |
| `shared`, `harness` | `@agent-bot/sdk`, vendored by digest. Adapter manifests follow 0.4 §10. |
| `org` | agent-bot-daemon `org/`. Per-soul SOP selection goes to soul-runtime core. |

### 2.2 What couples to what

These are heuristic scans; Appendix A has the per-file flags.

- **Filesystem.** 128 of the 239 modules import `node:fs`. In ADR-0645's
  soul module, 61 of 94 do. That includes 28 of the 53 core candidates, such
  as `soul-revisions`, `soul-memory`, `agent-population` and
  `skill-library`.
- **Worktrees.**
  - Soul side: `setup-worktree`, `claude-worktree-create`,
    `soul-worktrees`, `soul-join`, `soul-home`, `soul-env*` and
    `confinement`.
  - Identity side: `agent-binding`, `resolve-agent`, `worktree-token`,
    `git-credential-bot` and `signed-commit`.

  Under 0.4 these become HQ-mediated workspace views: a task's write scope
  plus mounted views in the protected profile (§4, §7).
- **keyd.**
  - Identity: `keyd-client`, `owner-presence`, `owner-decision-trust`,
    `soul-credentials`, `identity-apps` and `vouch`.
  - Host: `keyd-supervisor`.
  - Soul: `soul-credential-migration` and `soul-secrets`.

  keyd's App-key role ends and its device-key role moves into HQ's signer.
- **comms imported from soul.** These are `cold-wake` → `comms-relay`,
  `soul-join`/`soul-fork`/`soul-remove` → `comms-membership`, `soul-comms`
  and `soul-remove` → `daemon-status`, `soul-build`/`soul-builder` →
  `reach-contract`, `cold-wake-settings` → `wake-webhook-store`, and
  `owner-action` → `owner-principal`. Each becomes a host service, an event
  or a broker message kind.
- **soul to identity goes through one door:** 15 of the 17 crossings import
  `identity/identity-soul.mjs`. That entry becomes a service object of HQ
  core's identity (PDR-0027).
- **Plugins reaching the host.** These are `keyd-supervisor` →
  `daemon-supervisor`, `delegation-grants` and `cli/soul-env-transfer` →
  `agent-jobs`, `telegram-adapter` → `agent-daemon` and `agent-interaction`,
  and `wake-plane` → `agent-jobs` and `daemon-mcp`. All of them become host
  services.

### 2.3 Wire code duplicated across repos

The SDK `wire/` folder should own these once, and 0.4 WP1 turns them into
versioned schemas. None of them is wire framing, which agent-comms owns
(catalog):

| Code | Copies |
| --- | --- |
| Binding proof | `identity/binding-proof.mjs` = agent-comms `lib/binding-proof.mjs` (ADR-0008 amendment 1) |
| Presence verifier | `identity/presence-verifier.mjs` + `identity-presence.mjs` = agent-comms `lib/vendor/agent-bot-presence/` |
| Owner-decision journal | `identity/owner-decision-journal-frame.mjs`, `-prepared`, `-bytes` ≈ agent-comms `lib/owner-decision-*` |
| Canonical JSON | `canonical-json.mjs` in both. 0.4 §6 proposes JCS (RFC 8785) for signed structures. |
| Windows task jobs, secret store | `windows-task-job.mjs`, `secret-store.mjs` in both |

### 2.4 Cycles

There are five strongly connected components at file level, found with
Tarjan's algorithm over shim-resolved imports.

| ID | Files | Crosses | How to break it |
| --- | --- | --- | --- |
| **C1** | 14: `identity/soul-credentials` → `soul-app-declarations` → `agent-population` → `soul-mode`/`soul-model` → `cold-wake-settings` → `identity/identity-soul` → `identity/soul-credentials`. The other members are `owner-action`, `identity-app-store`, `ensure-private-key`, `mint-token`, `git-credential-bot`, `credential-reconciler` and `agent-backfill`. | **identity ↔ soul.** This is the only `identity → soul` edge, through the `soul-app-declarations` contract. | (1) Soul-runtime registers an `appDeclarations()` provider with identity at init (inversion). (2) Under 0.4, which service identity a mint uses comes from the *grant*, not from soul declarations, so the edge disappears. (3) `ownerGate` moves out of `cold-wake-settings` into HQ approval records. Row 3a did (3) as an approvals port and moved the census's settings readers out of the gate's reach, so no cycle crosses identity ↔ soul. It left two cycles within one domain: `agent-backfill` ↔ `agent-population`, and `identity-app-store` / `mint-token` / `soul-credentials`. The edge itself (row 3b) needs (1) or (2). (1) reverses the owner's decision on qwts/agent-bot-identity#645, which keeps minting working without the daemon. (2) changes runtime behavior. |
| C2 | `agent-space` ↔ `soul-memory` | none | Both become `memorial/` storage behind the life-store port. |
| C3 | 9: `sandbox`, `sandbox-export`, `sandbox-remove`, `skill-manifest`, `sop`, `soul-comms`, `soul-env-export`, `soul-profile`, `soul-revisions` | soul ↔ org (`sop`) | Split `sop.mjs` (org resolver / soul selection). A `RevisionStore` port removes the back-edges. |
| C4 | `soul-env` ↔ `soul-env-migrate` | none | Extract the descriptor reader that both use. |
| C5 | `agent-daemon` ↔ `agent-web` ↔ `daemon-supervisor` | none (host) | A daemon `state` module. |

## 3. Target architecture

```text
 tier 1  cloud relay  (agent-comms relay mode; untrusted for content; sealed frames)
            ▲  outbound, store-and-forward, no execution channel
 tier 2  site relay   (same code; first to ship)
            ▲
 ┌──────────┴───────────────────────── host ─────────────────────────────────────────┐
 │ tier 3  HQ = agent-bot-daemon            (own OS account; trusted host service)     │
 │   core: hq/v1 control socket · owner sessions · authoritative store · profiles     │
 │         member launch under per-member principals · identity-service link         │
 │         identity: enrollment · signer · grants · approvals · credential refs      │
 │   plugins (in process): comms (broker) · Soul runtime (hq side) · member surfaces │
 │   signer: non-exportable device key (Secure Enclave / TPM), HQ account only        │
 │        ▲ hq/v1 (owner)            ▲ broker socket + Hello/Admit/Equip/Ready/Lease  │
 │   GeniusBar · HQ CLI          ┌───┴──────────────── tier 4  Soul ───────────────┐  │
 │   (owner account)             │ entry point `agent-bot soul run` (ACP + chat)   │  │
 │                               │   tier 5: lead · specialist(s) · dream member   │  │
 │                               │   (per-member principals in the protected profile)│ │
 │                               └─────────────────────────────────────────────────┘  │
 └──────────────────────────────────┬──────────────────────────────────────────────────┘
                                    │ HTTPS out: DPoP + signed responses (§4.7)
                 identity service: agent-bot server at agents.true-line.ai
                 (keys, per-owner encryption, grant-bound minting, issuance records,
                  webhooks → notices; never lifecycle)
```

HQ dials out to the identity service and to relays. It accepts no inbound
network connection. The control socket and broker socket are local and
access-controlled. Remote owner administration uses a tunnel the owner opens
(SSH forwarding of the control socket in the MVP, per 0.4 §4).

### 3.1 The repositories

The platform's [repository catalog](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/repository-catalog.md) is the charter for each
repository: one purpose, what it owns and must not own, its trust domain and
its seams. The [seams](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/seams.md) page lists every contract between them. This
repository provides `hq-v1`, `task-v1` and `hq-plugin-contract`; the plugin
contract's home is §4 of this plan.

The first version of this table gave the HQ signer, grants, approval records
and credential references to agent-bot-identity; the task service, budgets
and brokered adapters to comms; and the package format, render and adapter
manifests to the Soul runtime. The catalog gives the HQ authority to
agent-bot-daemon, the package format and render to soul-package, and the
adapters to soul-adapters. This plan now follows the catalog; the difference
was recorded as DRIFT-016, now resolved. PDR-0027 settled the last question:
HQ identity authority is part of HQ core, and agent-bot-identity's plugin
registers member surfaces only.

Two points are internal to this repository: it pins a `true-line/soul-contracts`
release by digest and keeps no copies (D5), and an HQ release ships the pinned
plugin set (`governance/plugins.json`) with launchers for macOS, Windows and
Linux.

### 3.2 Trust domains, per plugin

The trust domains and the enforcement rule are the platform's
([trust domains and profiles](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/trust-domains-and-profiles.md)). The tables below place each piece of
the plugins in one of them; which repository ships each piece follows §3.1.

#### Daemon (HQ core)

| Piece | Domain | Why |
| --- | --- | --- |
| `hq/v1` control socket, owner sessions, lifecycle | HQ | R2: lifecycle and the admin channel end at local HQ. |
| Authoritative store: grants, spent nonces, task revisions, dedup, action ledger, budgets, approvals | HQ, inaccessible to members | 0.4 §11: a member-writable ledger can't fence a hostile member. |
| Member launch, per-member principals, profile reporting | HQ | R3, R8 |
| Identity-service link (assertions signed by the HQ signer; DPoP tokens in memory) | HQ | No long-lived secret on the host. |
| `agent-bot mcp`, `reach-mcp`, hook runner, commands members run | Soul | Thin clients. HQ repeats every check. |
| Network listeners | none | HQ dials out only. The optional browser PWA's `127.0.0.1` listener is the one exception (§7). |

#### Identity

| Piece | Domain | Why |
| --- | --- | --- |
| Device key | HQ signer (Secure Enclave or TPM, HQ account only) | Non-exportable. Revoking the device needs no key rotation. A software key is a stage 0–1 transition only, and the identity service may refuse to mint for it per policy (§4.7). |
| Enrollment | HQ, plus the owner confirming on the identity service | One-time, owner-confirmed challenge (0.4 §3). |
| GitHub App keys and other service identities | Identity service | 0.4 §4, §12 |
| Minting, issuance records | Identity service | Bound to the device and the grant. Each issuance is recorded. |
| Credential references → short-lived tokens | HQ (memory), used only by brokered adapters | Members get references, never secrets (Equip, 0.4 §5). |
| Grants, grant handles, caller binding | HQ | R3. Handles are caller-bound per runtime admission. |
| Approval records | HQ, signed, from the owner session | 0.4 §8: bound to the digest of the proposed action. |
| Soul ID, member, runtime and installation records; receipts | HQ store | R1 |
| gh shim, credential helper, git hooks | Soul, **cooperative profile only** | In the protected profile members hold no service token, and service writes go through the broker's adapter. |
| Vouch / soul-token key (today `vouch-key.pem`) | **HQ signer only**, non-exportable | No long-lived signing key as a file on the host. Secure Enclave and most TPMs hold P-256 rather than Ed25519, so soul tokens move to a `v2` signed with ES256. The agent-comms broker verifies `v2` and accepts `v1` (Ed25519) only during the transition window. If a host has no hardware signer, the identity service signs soul tokens instead, and HQ asks for them like any other credential. |

#### Comms

| Piece | Domain | Why |
| --- | --- | --- |
| Broker: mailbox, tasks, dedup, receipts, budgets, brokered egress | HQ | 0.4 §3: same trust domain as HQ. |
| Comms client and CLI | Soul | Early validation only. The broker repeats every check. |
| Site and cloud relays | Relay | Sealed inner content. They can't create grants, mint directives or wake processes. |
| Notices (GitHub webhook events) | Identity service; pulled by the broker | Arrive as provenance `external-untrusted`, so they never cold-start a Soul (§4.8). |
| Principal credentials | Owner client | Never readable by members. |
| Channel tokens (Telegram) | Identity service, via a credential reference | Long-lived. |

#### Soul runtime

| Piece | Domain | Why |
| --- | --- | --- |
| Validation, manifest digests, render, admission checks, export, candidate promotion | HQ | Accepted content is immutable to members (0.4 §11). |
| Entry point: front door, member supervision, role routing, recovery ladder | Soul | 0.4 §3: it holds no keys and doesn't decide its own grants. |
| Members (lead, specialists, dream) | Soul, a principal per member in the protected profile | R3 |
| Life (`memorial/`, `dreams/`, `comms/` mirror, `home/<member>/`, `workspaces/`) | Soul root | HQ's store wins wherever authority state diverges. |
| Definition (`SoulInfo.json`, `SoulLock.json`, `primitives/`) | Immutable to members; HQ promotes revisions | R4, 0.4 §10 |

### 3.3 Enforcement profiles (0.4 §4, R8)

The profiles (managed protected, managed cooperative and standalone
unenforced) and what each one guarantees are defined by the platform
([trust domains and profiles](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/trust-domains-and-profiles.md)). Today's layout is managed
cooperative. What HQ does with them:

- Every receipt and the GeniusBar header name the profile actually in force.
  A protected claim under a weaker profile is refused with
  `profile_insufficient`.
- `legacy-local-custody` is **off by default** and can be turned on only in
  the standalone profile. `doctor` and `status` flag it, and every receipt
  names it.
- The Linux reference host qualifies for managed protected first (§9 PR 16);
  macOS per-member accounts plus a sandbox come second (PR 29, D7).

### 3.4 Rules that keep the split honest

1. Plugins import only `@agent-bot/sdk`, never the daemon and never each
   other. A boundary test checks this in each repo.
2. Every cross-plugin need is a named, versioned **host service** or an
   **event**.
3. No contract names a model, provider or harness vendor (R10). Vendors
   appear only in configuration, adapter manifests and evaluation records.
4. soul-runtime `core/` imports none of `node:fs`, `node:child_process`,
   `node:os`, `node:net` or `process.env`.
5. Zero npm dependencies. The SDK and plugins arrive vendored and pinned by
   digest (`governance/plugins.json`), and HQ checks the digests at load.

## 4. Plugin contract (inside HQ)

Plugins are HQ's internal structure. 0.4 doesn't define them, and they add
no trust boundary: every plugin runs in HQ's trust domain. The Soul-side
entry point is a separate process, not a plugin.

### 4.1 Manifest and entry

```js
// plugin.mjs — exactly one default export
import { definePlugin } from '@agent-bot/sdk';

export default definePlugin({
  name: 'agent-comms',              // ^[a-z0-9-]{1,64}$
  version: '0.6.0',                 // the plugin's semver
  hostApi: 1,                       // HQ plugin-API major
  requires: {},                     // plugin name → semver range
  optional: { 'agent-bot-souls': '>=0.1.0 <1' },
  services: ['config', 'store', 'log', 'receipts', 'identityService', 'credentials', 'launch', 'events', 'approvals', 'budgets'],
  identityServiceRoutes: ['/api/daemon/notices*'],   // allowlist for services.identityService
  async init(ctx) { /* register; read-only probes only; return provided services */ },
  async start(ctx) {},
  async stop(ctx, { reason, deadlineMs }) {},
});
```

HQ reads the static fields from `plugin.json` and runs no plugin code until
the set has resolved and every digest matches (§4.5).

### 4.2 What a plugin registers

| Kind | Call | Notes |
| --- | --- | --- |
| `hq/v1` operations | `ctx.hq.register({ op, auth: 'owner'\|'entry-point', schema, handler })` | Only the operations in 0.4 §5 exist (Hello, Admit, Equip, Ready, Lease, start, stop, pause, resume, drain, sleep, move, fork, accept-revision, rollback-revision, retire), plus owner read views. Plugins implement parts; HQ core owns the dispatch and auth. |
| Broker message kinds | `ctx.broker.registerKind({ kind, schema, consume })` | `directive` (HQ → Soul) and `query` (Soul → HQ) per 0.4 §5, plus plugin queries such as `credential.reference`, `grant.request` and `notices.take`. A peer can't acquire the `directive` kind through its text (T04). |
| Brokered adapters | `ctx.broker.registerAdapter({ id, class: 'inference'\|'service', validate, call, lookup })` | Validates operation type, resource scope, redirects, resolved destination and payload class (0.4 §4). `lookup` supports reconciliation of `unknown` effects. |
| Member surfaces | `ctx.tools.register(tool)`, `ctx.commands.register(cmd)` | MCP tools and CLI commands that members run in the Soul. They resolve to broker queries, never to direct authority. |
| Events | `ctx.events.publish/subscribe(type, payload)` | In process, at most once. Anything durable goes through the store. |
| Readiness probes | `ctx.readiness.register(probe)` | Splits `readiness.mjs` (3.1k lines). |
| Provided services | `return { provides: { … } }` | Dependents receive them as `ctx.deps[name]`. |

There is no remote RPC registration. No component outside the host can
invoke a plugin (R2).

### 4.3 Host services

| Service | Interface (abridged) | Implementation |
| --- | --- | --- |
| `config` | `get`, `section`: read-only, schema-validated, no secrets | `~/.config/agent-bot/config.json` (HQ account), the plugin's section |
| `store` | `tx(fn)` with plugin-scoped tables, `blob`, `lock` | A transactional embedded database in HQ's account (0.4 §12). Authority tables are separate from mirrors of member-writable state. The plugin `name` is validated before any path is built. |
| `credentials` | `resolve(reference, { task, operation }) → token` (HQ memory only, one operation), `issue(reference)` for Equip | Asks the identity service for a token bound to the device key, the grant, the task and the operation, and never reuses it across operations (§4.7). **A plaintext secret never reaches a member.** If the service is down, the result is `credential_unavailable` (R9); if the device is revoked, `device_revoked`. |
| `identityService` | `call(method, route, body)` | Limited to the allowlist. Hardened per §4.7. |
| `approvals` | `request({ action, digest, scope, reason, cost, expiry })`, `decided(id)` | Produces an HQ-signed approval record from an owner session (0.4 §8). Editing the action invalidates it (T24). |
| `launch` | `member({ soul, role, principal, home, env })`, `track`, `stop` | Per-member principals and private `HOME`/`XDG_*`/`PATH`/temp inside the member's state (0.4 §4). |
| `budgets` | `reserve`, `settle`, `release` | One Soul ceiling with working and maintenance sub-allocations (R5). |
| `receipts`, `log` | `receipts.append(record)`, `log.*` | Receipt fields per 0.4 §7; redacted logs; OTLP with no content and no credentials. |
| `events`, `clock`, `random`, `profile` | as named | `profile.current()` names the enforcement profile. |

### 4.4 Lifecycle and bootstrap order

```text
discover → resolve → load → init (topological order) → start (topological order) → running → stop (reverse order, deadline)
```

- **discover** reads `plugin.json`, validates `name` and checks the
  plugin's digest.
- **resolve** checks semver and `hostApi`, then requires an acyclic
  `requires` graph.
- **`init`** is idempotent. Apart from registering, it may run read-only
  probes (reading its config or the store, for example). It must
  not write authority state, call the identity service or start long-lived
  work; every host service that changes state refuses during `init`. It
  times out at 10 s. A failed or timed-out `init` loses its context: an
  `init` still running in the background gets `host.context_revoked` from
  every service and registration.
- **`stop`** gets a deadline. After `stop`, every plugin context is revoked
  and short-lived credentials are dropped, so a retained context cannot
  mint a new one.

**Bootstrap, with identity first and hard-required.** Identity is HQ core,
not a plugin (PDR-0027), so it is ready before any plugin code runs:

1. **HQ core:** store, control socket (owner sessions), profile detection,
   signer discovery.
2. **Core identity:** device status from the signer.
   - **Unenrolled** (no device record) → **safe mode**: only `status`,
     `enroll` and `doctor` work, no plugin starts, and no Soul is admitted.
     A signer that is missing or reports no status is also safe mode.
   - **Revoked** → the **`device_revoked`** state, which is distinct from
     safe mode and defined in §4.7.
   - **Identity service unreachable** → neither of the above. Admission
     proceeds, and only protected effects that need a fresh credential wait
     with `credential_unavailable` (R9).
3. **Core identity link:** identity-service link (assertion, token, key-set
   check per §4.7), grants, credential references.
4. **Plugins, in dependency order:** comms (broker) drains identity-service
   notices and connects to configured relays; the Soul runtime's HQ side
   (requires comms) brings validation, render and admission handlers;
   agent-bot-identity registers its member surfaces.
5. **`hq/v1` admissions open.** Entry points can now send `Hello`.

`status`, `device.status` and `device.enroll` are answered by core; a plugin
that registers one is refused. If a plugin fails, it is marked `degraded`,
its dependents don't start, and `status` reports why.

### 4.5 Versioning and compatibility

- **Plugin semver** and an integer **`hostApi`** (N and N-1 supported).
- **Wire contracts version on their own** and support N and N-1 with
  explicit capability negotiation (R7): `hq/v1`, broker wire, `task/v1`,
  the 0.4 Appendix A records, the package format, and the identity-service
  signature `agent-bot-sig-v1`. Unknown required semantics are rejected
  (T14).
- **Each HQ release pins one compatible set** in `governance/plugins.json`
  (`name`, `version`, `sha256`). CI refuses a mismatch. **HQ also verifies at
  load:** it hashes each plugin's installed tree (sorted paths, normalised
  modes, the same framing as package digests) and refuses a mismatch with a
  receipt and a `status` reason. A mismatch on identity means safe mode.
  `--dev-plugins PATH` is the only override, and `status` always reports it.
  Pins never move backwards.

### 4.6 Usable on its own for testing

The SDK ships `createTestHost({ plugins, services })` with an in-memory
store, a fake identity service (canned signed responses), a deterministic
clock and random, a fake signer, and fake member principals. Each plugin
repo runs its own tests on it, plus the SDK's **plugin conformance suite**,
which checks:

- idempotent registration;
- repeatable `start`/`stop`;
- `stop` within its deadline;
- no global state;
- no writes outside the store;
- unique names;
- an `auth` class on every `hq/v1` operation.

The 0.4 WP1 fixtures (positive and negative), loaded from the pinned `soul-contracts` release, run against the real plugins. The pin is `governance/soul-contracts.json`, which names the tag, commit and a `sha256-manifest-v1` digest (the §5.3 framing over `errors/`, `fixtures/` and `schemas/`). `scripts/soul-contracts.mjs` verifies the pin and returns the checked copy under `.cache/` for tests to load.

### 4.7 Identity-service link hardening

These rules apply to every call from HQ to the identity service.
`identity/server-client.mjs` already does the first two; the rest are new.

- **No redirects.** Every fetch uses `redirect: 'error'`.
- **DPoP on every request.** The proof carries `htm`, `htu`, `iat`, a fresh
  `jti` and `ath`, signed by the ephemeral key bound to the token's `jkt`.
  The jwt-bearer assertion that gets the token is signed by the **HQ
  signer's** non-exportable device key.
- **Signed responses are required.** Every response must carry three
  headers:
  - `Agent-Bot-Signature`, an Ed25519 signature over
    `agent-bot-sig-v1\n<status>\n<hex sha256(body)>\n<request jti>`;
  - `Agent-Bot-Request-Jti`, equal to this request's jti;
  - `Agent-Bot-Key-Id`, naming a key in the pinned set.

  Unsigned, unknown or retired `kid`, failed, mismatched or skewed
  (more than 5 minutes) responses are refused before parsing, including
  error responses.
- **Release-pinned keys.** The HQ release ships `server-keys.json`
  (`kid`, `x`, `notBefore`, `notAfter`, `status: active|next|retired`) for
  `agents.true-line.ai`. TOFU is allowed only for a non-default identity
  service named explicitly in config, and is flagged.
- **Rotation.** The `next` key is published at least one release before
  use. An emergency rotation ships as an HQ patch release.
- **Outage.** Tokens already minted are used until expiry and never after.
  An outage widens no authority and gives no component an execution
  channel (0.4 §6).
- **One token per task and operation.** HQ asks for a credential with
  `{ task, operation }`. The identity service records both in the credential
  issuance record, extending 0.4 Appendix A's fields with `task_id` and
  `operation_id`. HQ never reuses a token for another operation: a token is
  held in memory for that operation only and dropped when its action record
  reaches a terminal state. The cost is one mint per protected operation,
  bounded by a per-device rate limit at the identity service.
- **Software device keys.** Until stage 2a a host may still enroll with a
  software key (`key_storage=software`). The identity service can refuse to
  mint for software-key devices **per owner policy**. Once that policy is on,
  those mints are refused with `profile_insufficient`, and the receipt
  names the device's key storage. The device itself is not revoked.
- **`device_revoked`.** When the identity service answers that the device is
  revoked (today `invalid_grant` on `/oauth/token`, or an explicit revoked
  status on any call), HQ maps it to `device_revoked` and does the
  following:
  - it **drops every cached token and resolved credential immediately**,
    without waiting for expiry;
  - it refuses every new credential resolution and every protected external
    effect not yet submitted with `device_revoked`;
  - it moves effects already submitted to reconciliation, as for any
    uncertain outcome;
  - it records a receipt and shows "device revoked: re-enroll" in `status`,
    GeniusBar and the HQ CLI.

  Members see `device_revoked` as the result of their query or task step,
  and the affected tasks wait with reason `credential unavailable` and that
  code. Local conversations, local tasks and operations that need no
  credential continue, so HQ does *not* enter safe mode. Recovery requires a
  **new enrollment** (`enroll --force`) with a fresh device key. The revoked
  device record is never revived. This differs from safe mode's
  "unenrolled" (never enrolled: no Soul admitted) and from
  `credential_unavailable` (transient: retried when the service returns).

### 4.8 Relays, notices and wake

This section replaces the previous "relay RPC" design, which contradicted
R2.

- **Relays are agent-comms in relay mode** (0.4 §6). A site relay ships
  first, then a cloud relay running the same routing code in a restricted
  configuration. `relay.true-line.ai` on a Cloudflare Durable Object is a
  deployment choice that lives in configuration, not in the contract (R10).
- **HQ dials out** to its configured relays over authenticated transport.
  Enrollment uses a node key and an owner-confirmed one-time challenge.
  Relays never get an execution channel.
- **Frames follow the broker wire.**
  - The outer frame carries destination Soul, epoch hint, message ID,
    expiry, size, wake class and required capabilities.
  - The inner message is sealed between endpoint brokers. Relays can't
    decrypt it, extend expiry or change the destination.
  - Public federation stays off until the crypto profile is reviewed
    (Q8). No reviewer is named yet, and that does not block anything
    through Stage 3.
- **No remote control.** Relays and the identity service can't start, stop,
  exec or call plugin code. A relay frame that looks like lifecycle never
  reaches the control socket (T12).
- **Wake.** A cloud or site relay delivers to the local broker, which alone
  decides whether to wake a Soul. It checks wake class, wake grant,
  provenance and budget. `external-untrusted` frames never cold-start a
  Soul.
- **Notices (GitHub events from the identity service):**
  - The broker pulls them from the identity service with
    `notices/take`, on a schedule, on reconnect and on demand.
  - Each notice becomes a mailbox message whose message ID is the notice
    ID, with provenance `external-untrusted` and wake class `none` or
    `notify`.
  - The broker **acks the notice only after durable custody in HQ's
    store**. A notice taken twice dedups by message ID, and a crash before
    custody lets the lease expire and the notice return.
  - Delivery is at least once, with one committed transition per message
    ID (T05).
  - There is no relay-pushed "notices waiting" hint (Q7). Pull latency
    and volume are measured first.
- **Outages.** If the relay is down, local conversations, tasks and
  permitted operations continue and outbound messages queue (R9, T13). If
  the identity service is down, notices wait in its queue (kept 7 days).

## 5. Soul package (0.4 §11, [S4])

The package format is the `soul-package-format` seam, provided by
soul-package (catalog). This section records what HQ needs from it.

### 5.1 Layout

The layout and its data classes are described on the platform's
[package format](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/interfaces/package-format.md) page;
soul-package holds the specification.

Authoritative grants, spent nonces, key material, task revisions, dedup and
action records live in HQ's store, not in the package. Copying a `.soul`
directory doesn't transfer authority.

### 5.2 Where SOUL.md fits

The persona is a primitive: `primitives/persona/SOUL.md`, of class
"instructions". Its manifest marks it **required, render-first** for every
adapter, so `soul build` places it ahead of the other guidance in each
harness's native file. Because it is a primitive, the rules of 0.4 §10
apply. Only owner acceptance changes it: a dream run can only propose a
candidate. It can't be marked optional for an adapter. The current
`AGENTS.md` becomes `primitives/standing-instructions/`, and the existing
skills become `primitives/<name>/`. The file name stays `SOUL.md` (Q3);
SoulInfo.json and SoulLock.json remain the only configuration authorities,
and the persona is rendered by `soul build` and pinned by digest.

### 5.3 Digests and manifest

- **The manifest** maps each canonical path to its SHA-256, size and file
  mode. Signed structures use JCS (RFC 8785), as 0.4 §6 proposes.
- **The definition digest** covers exactly the Definition-class entries
  (`SoulInfo.json`, `SoulLock.json`, `primitives/`) and leaves out the
  manifest's own digest field. WP1 fixes the byte rules and publishes vectors.
- **Validation** refuses traversal, absolute paths, symlink escapes,
  archive-expansion overruns, incompatible platforms and dependency cycles
  before activation (T16). Today's `archive-budget.mjs` and format-2 checks
  are the starting point.
- **A digest is not an identity.** The Soul ID is the stable identity
  (R1); a definition digest names one accepted revision.

### 5.4 Moving off formats 1 and 2

`soul.json`, the root `AGENTS.md`, `skills/` and `.soul-state/` are "naming
history" in 0.4 terms, not a second authority.
`agent-bot soul migrate --to contents-1`, an owner operation through
`hq/v1`, converts them:

| From | To |
| --- | --- |
| `soul.json` | `SoulInfo.json` (declarations) + `SoulLock.json` (resolved pins, including `runtime-pins.json`) |
| `AGENTS.md`, `skills/`, `hooks/`, `bin/` | `primitives/` |
| `.soul-state/space` (Agent Space) | `memorial/knowledge/` |
| `.soul-state/runs` | receipts in HQ's store, plus a `comms/` mirror |
| `.soul-state/runtimes` | `opt/` |
| `worktrees/` | `workspaces/` |
| `revision` / `parentRevision` | Recorded as provenance of the first `contents-1` revision |

Formats 1 and 2 stay readable for one major version, and HQ refuses to
downgrade.

### 5.5 Transfer, backup, template, fork (0.4 §5, §11)

| Operation | Soul ID | Carries | Never carries |
| --- | --- | --- | --- |
| **move** (life transfer) | Kept | Definition, selected life, plus an authenticated HQ export of operation history (settled watermark, unresolved operations) | Secrets, reusable grants, active leases |
| **backup / restore** | Kept | Selected life, restored only after a new admission | Old grants. They aren't valid after restore; runtime credentials and leases are reissued. |
| **template** | New | Definition plus seed knowledge | Private history, credentials, grants |
| **fork** | New, with parent provenance | Definition plus selected, authorized knowledge | Credentials, live grants, active leases, unsettled side effects |

The first transfer release requires a coordinated drain, settlement,
revocation of old handles, a transfer record and explicit activation on the
destination. There is **one active installation per Soul**: HQ refuses to
activate a copy it has already activated, and the epoch fences commits but
never inbound delivery. Because keys stay at the identity service, a move
needs only re-enrollment of the destination device.

### 5.6 Conformance

0.4's tests govern. The package and runtime gates are T10, T15, T16, T19,
T22 and T27–T30. On top of them, the soul-runtime conformance suite adds the
fixtures that keep the HQ side and the entry point in step, and keep the core
pure so that a hosted runtime remains possible later (D3).

| # | Area | Must hold |
| --- | --- | --- |
| P1 | Validation vectors | Identical accept/refuse and error codes for shared positive and negative fixtures (stage 0 exit) |
| P2 | Definition digest | Byte-identical digests for the published vectors |
| P3 | Render | Golden output per adapter, persona first; `render_failed` for a non-optional primitive an adapter can't render |
| P4 | Migration | A format-1 or format-2 fixture migrates to `contents-1`, preserving unknown files under `primitives/legacy/` and the revision provenance |
| P5 | Transfer | T15 plus: a move reports missing host requirements, and indexes rebuild from knowledge records |
| P6 | Template and fork | A template excludes private history; a fork records its parent; neither carries grants |
| P7 | Taint | Derived notes inherit source restrictions, and export selection applies them (T19) |
| P8 | Determinism | With clock and random injected, the core produces byte-identical outputs |

## 6. soul-runtime: split and adapter ports

The core is pure, and the HQ side and the entry point implement its ports.
A "hosted" column records what a later server-side runtime would need. That
runtime is outside 0.4's MVP (D3) and is kept possible only by the purity
rule.

```js
createSoulCore({ store, credentials, exec, comms, identity, approvals, clock, random, log })
```

| Port | Interface (abridged) | HQ side / entry point (MVP) | Hosted (post-MVP, not in 0.4) |
| --- | --- | --- | --- |
| `store` | Definition read and promote (CAS on the parent digest); life get/put/append/list; registry | HQ: package directory plus HQ's store (authority); entry point: life writes in the Soul root, limited by member principals | Per-owner encrypted object store |
| `credentials` | `reference(name, purpose)` → opaque reference | HQ `credentials` service. Members only ever see references. | Identity service directly |
| `exec` | `launch(member)`, `turn(...)`, `cancel`, `workspace.view(task)` | HQ `launch` under per-member principals; entry point drives ACP sessions; workspace views from the task's write scope | Sandbox per turn |
| `comms` | `send`, `inbox`, `ack`, `onDirective`, `query` | Broker socket (comms client in the Soul) | Broker in the hosted environment |
| `identity` | `soulId`, `memberId`, `runtimeId`, `epoch`, `coAuthorTrailer` | HQ core identity (PDR-0027) | Same records |
| `approvals` | `request(...)`, `decided(id)` | HQ approval records | The same contract |
| `clock`, `random`, `log` | injected | Host services | Equivalents |

Source modules: Appendix A, `soul-runtime/core`, `/hq` and `/entry-point`.
53 modules are core candidates, and 28 of them still import `node:fs`.

## 7. Owner interface: `hq/v1` for GeniusBar and the HQ CLI

The `hq-v1` seam's records are in soul-contracts `schemas/hq/v1`, and the
platform's [hq/v1 interface](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/interfaces/hq-v1.md)
page describes it. This section is HQ's design for serving it.

### 7.1 Transport

| Platform | Transport | Who may connect |
| --- | --- | --- |
| macOS, Linux | `hq/v1` over a Unix domain socket in HQ's state directory | The owner, i.e. the host account that installed HQ (0.4 §4), checked by peer credentials |
| Windows | Named pipe with a DACL for the owner SID | Owner SID |
| Remote / headless | The owner forwards the control socket over SSH (MVP); OAuth or Kerberos authenticators later | Owner, through the tunnel. **Never through a relay** (R2). |
| Browser PWA (optional, read-only for the pilot, Q6) | Today's `agent-web` on `127.0.0.1`, with a pairing code from the owner CLI and an HttpOnly cookie | Owner session. It is the only TCP listener, loopback only, and off unless `agent-bot web open` is run. Status, receipts and task inspection only, enforced at the API boundary; no approvals, policy, grant, lifecycle, task-submission or credential operations. Meets WCAG 2.2 AA. |
| Mobile | Post-MVP, and only through an owner-opened tunnel | Owner |

GeniusBar and the HQ CLI are clients of HQ, not sources of authority.
Every approved operation is available through both (0.4 §3, §8).

### 7.2 Authentication and approvals

- The owner session is the authenticated control-socket peer. HQ records the
  session reference on every approval, grant and lifecycle request.
- An approval is an **HQ-signed record bound to the digest of the proposed
  action**. It names the action or policy change, the resource and data
  destination, why existing authority isn't enough, the expected cost and
  the expiry. Editing the action invalidates it (T24).
- Members, peers, relays and the identity service can't produce an
  approval. A peer saying "the owner approved" stays peer data (T04).
- On the identity service, the owner authenticates with a passkey to unlock
  the vault and confirm device enrollment. The WebAuthn RP ID is
  `agents.true-line.ai`, fixed before passkeys are registered.

### 7.3 Main calls

| Area | `hq/v1` |
| --- | --- |
| Status | `status` (profile in force, plugins and versions, identity-service and relay reachability, degraded reasons) |
| Lifecycle | `start`, `stop`, `pause`, `resume`, `drain`, `sleep` (schedule), `move`, `fork`, `accept-revision`, `rollback-revision`, `retire` |
| Authority | `grants.list/create/revoke`, `approvals.list/decide`, `destinations.list/approve`, `budgets.get/set` (ceiling and sub-allocations) |
| Work | `tasks.list/get` (state, waiting reason, evidence), `receipts.query`, `actions.unknown` with `actions.resolve` (owner-resolved outcome) |
| Souls | `souls.list/get` (roles, readiness, unevaluated harnesses), `candidates.list/get` (change list, per-cell matrix, provenance warnings, cost), `evaluations.get` |
| Device | `device.status`, `device.enroll` (starts the identity-service device grant) |
| Events | `events.subscribe` (stream on the same socket) |

Today's `/v0` and `/v1` loopback routes are served by a compatibility layer
until GeniusBar moves. The route-auth test extends to `hq/v1`.

## 8. What happens to the current surfaces

### 8.1 Kept unchanged

The following keep their names, arguments, exit codes and `--json` shapes,
pinned by golden tests (PR 2):

- the `agent-bot` command and its subcommands;
- the `agent-comms` command;
- the hook path `agent-bot hook <name>`;
- bindings and Agent ID records;
- the `QWTS_*` and `AGENT_BOT_*` variables.

Under 0.4 the owner commands talk to HQ over `hq/v1`, and the member
commands talk to the broker. The root-level shims stay for at least two
releases.

### 8.2 Deprecated

| Old | Replacement | Removed |
| --- | --- | --- |
| MCP `take_inbox`, `POST /v0/inbox/take`, `gh-inbox-query`, `inbox-probe` | Broker-pulled notices (§4.8) and a member query `notices.peek` | Two releases after notices ship |
| `gh-app-hook` Worker, `wrangler.toml`, `INBOX_TOKEN`, `WEBHOOK_SECRETS`, `SUBSCRIBERS` | Identity-service webhooks and notices | After a dual-run window |
| Local App key custody: `ensure-private-key`, `identity-app-store`, `soul-credentials`, `credential-reconciler`, keyd App items, `migrate-credentials` | Identity service; HQ credential references | Off by default from PR 18, opt-in only under the standalone profile and flagged by `doctor`/`status`. **Code removed at stage 3 exit or on 2027-01-31, whichever comes first** (decided 2026-10-27, §10.1). The opt-in stops working on that date. |
| `secret*.mjs`, Proton Pass providers, `soul secret set` | Identity-service vault (owner-unlock); HQ credential references | Same switch and the same dated removal as local App key custody |
| `vouch-key.pem`, `/v0/keyd/grant`, keyd `credential`/`git_credential` tools | HQ signer only (soul token `v2`, ES256), or identity-service signing where no hardware signer exists; brokered service adapter | Stage 2a for the key; stage 2b for the tools |
| `device-key.pem` (software) | HQ signer hardware key, after re-enrollment. Until then the identity service may refuse software-key devices per policy. | Stage 2a |
| Owner gate through keyd Touch ID or the admin dialog in an agent account; agent-comms principal credential checks for revisions | HQ approval records from the owner session | Stage 3 |
| One daemon per agent account | One HQ per host in its own account (strangler; the old daemon is retired when HQ passes the same contract and recovery tests) | Stage 3 |
| `soul.json` format 1/2 packages | `contents-1` layout (§5.4) | One major after migration ships |

## 9. Migration plan

Each step is one PR with one objective, mergeable on its own and reversible.
A row that names two repositories is one PR in each. The stages and exits
follow 0.4 §13, and each PR names its work package. Each one follows the SOP
(issue first, PR-first, validate before push, bot-signed commits) and uses
`Refs #N` for partial work. The **Repo** column follows the platform's
[repository catalog](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/repository-catalog.md). Each row is tracked by an issue in the
repository that does the work; this repository tracks only its own rows.

### Stage 0: contract baseline and in-place preparation (WP1)

| # | Repo | WP | PR | Done when |
| --- | --- | --- | --- | --- |
| 1 | soul-contracts | WP1 | **Contracts** in `true-line/soul-contracts` (D5): glossary, JSON Schemas for 0.4 Appendix A records, error registry (0.4's minimum codes), positive and negative fixtures, the R1–R12 → tests traceability matrix, and this inventory as the compatibility baseline (referenced from there at a pinned commit) | Fixtures validate; a schema review finds no vendor token (R10) |
| 2 | agent-bot-identity | WP7 | **Golden surface tests** for every `agent-bot` command, MCP tool and route-auth row | Green on `main` unchanged |
| 3a | agent-bot-identity | WP2 | **Break C1's crossing:** an approvals port for `ownerGate`, and gate-free settings readers for the census | No cycle crosses identity ↔ soul |
| 3b | agent-bot-identity | WP2 | **Remove the `identity → soul` edge** (§2.4 C1, remedy 1 or 2), once the owner decides between superseding the qwts/agent-bot-identity#645 decision and waiting for grant-based minting | The `identity → soul` edge is gone |
| 4 | agent-bot-identity | WP3 | **Break C2, C4, C5** and the two cycles 3a leaves | Only C3 remains |
| 5 | agent-bot-identity | WP3 | **Break C3** (`sop.mjs` split, `RevisionStore`) | No cycles |
| 6 | agent-bot-identity | WP1 | **Target and domain columns** in `runtime-modules.json`, plus a test forbidding new plugin → plugin edges | Merged, no runtime change |
| 7 | agent-bot-daemon | WP1 | **SDK v0:** `definePlugin`, host services, `createTestHost`, plugin conformance suite, the `wire/` shared codecs (§2.3; framing stays in agent-comms); pins the `soul-contracts` release from PR 1 by digest (the pin landed first, #76) | Pinned, digested copy |
| 8 | agent-bot-identity | WP2 | **Route registry** (generalises `createIdentityRoutes`/`createSoulRoutes`) | `daemon-route-auth.test.mjs` unchanged |
| 9 | agent-bot-identity | WP3 | **MCP and CLI registries** | Golden tests green |
| 10 | agent-bot-identity | WP2 | **Identity-service link split and hardening** (§4.7) | Each refusal tested |
| 11 | agent-bot-identity | WP4 | **Notices pulled with custody-then-ack;** `take_inbox` becomes an alias | T05-style dedup test passes |

### Stage 1: local vertical slice (WP2–WP4)

| # | Repo | WP | PR | Done when |
| --- | --- | --- | --- | --- |
| 12 | agent-bot-daemon | WP2 | **HQ skeleton** in its own account: store, control socket with owner sessions, profile reporting, `hq/v1` Hello/Admit/Equip/Ready/Lease. It **supervises the existing daemon unchanged** (strangler). | HQ reports `managed cooperative` honestly; T14 |
| 13 | agent-bot-daemon | WP4 | **Task service in HQ's store** (`task/v1`, CAS, operation keys, proposals versus commitments, write-scope exclusion), as the `task-v1` provider; agent-comms mirrors the records through its codec and carries directives and queries as broker kinds (platform PDR-0024) | T04, T05, T20 |
| 14 | agent-bot-souls | WP3 | **Entry point** `agent-bot soul run`: ACP front door and terminal chat; lead plus specialist on fake adapters; role routing; handoff notes; recovery ladder | One task completes with scoped proposals and one final commitment |

### Stage 2a: member isolation (WP2)

| # | Repo | WP | PR | Done when |
| --- | --- | --- | --- | --- |
| 15 | agent-bot-daemon | WP2 | **HQ signer:** device key in TPM (Linux) or Secure Enclave (macOS) under the HQ account; soul-token key in the signer (`v2`, ES256), with `vouch-key.pem` removed; re-enrollment path | `key_storage=hardware`; no signing key file on the host; the agent-comms broker verifies soul token `v2`; T02 |
| 16 | agent-bot-daemon | WP2 | **Linux protected profile:** per-member service identities, namespaces, broker socket and workspace views as the only exits, caller-bound grant handles | T01–T03, T21 |

### Stage 2b: brokered adapters (WP2, WP4)

| # | Repo | WP | PR | Done when |
| --- | --- | --- | --- | --- |
| 17 | agent-bot | WP2 | **Identity service:** grant-bound minting per task and operation, credential issuance records with `task_id` and `operation_id`, live tokens revoked on device revoke and `device_revoked` on every call afterwards, hardware attestation, an owner policy to refuse software-key devices, device self-revoke, owner-unlock vault | Documented in the server API docs; revocation test shows cached tokens dropped and `device_revoked` |
| 18 | agent-bot-daemon | WP2 | **Credential references resolved by HQ;** `legacy-local-custody` off by default and opt-in only under the standalone profile; `doctor` and `status` flag it and any key file | No long-lived secret on a fresh host |
| 19 | agent-bot-daemon | WP4 | **Brokered inference and service adapter** (GitHub), action ledger with reconciliation, budgets and sub-allocations. Under `managed-protected`, service writes go only through this adapter; members get no service tokens and no member-side `signed-commit` (Q4) | T06–T11, T17–T19, T23, T25, T26; negative tests for a direct member write and for a weaker profile claiming protected |
| 20 | agent-bot-identity | WP4 | **Retire gh-app-hook** | `doctor` has no `inbox.*` checks |

### Stage 3: operator pilot (WP5, WP6)

| # | Repo | WP | PR | Done when |
| --- | --- | --- | --- | --- |
| 21 | agent-bot-daemon | WP6 | **Owner interface:** `hq/v1` owner operations, approval records, enrollment and receipts in the HQ CLI; GeniusBar moves to `hq/v1` | T24; the pilot rubric runs through terminal chat and ACP only |
| 22 | soul-package | WP5 | **`contents-1` package,** validator, `soul migrate`, render per adapter with digests in `SoulLock.json` | T16; P1–P4 |
| 23 | agent-bot-souls | WP5 | **Dream workflow per 0.4 §10:** dream member, dream grant, staged candidate tree, per-cell evaluation, owner acceptance of the digest | T22, T27–T30 |
| 24 | agent-comms | — | **agent-comms as one HQ plugin package:** broker, client and relay modes; carry agent-bot's comms modules. The name stays (platform PDR-0002 decision 5); a rename would need a platform decision first | Plugin conformance green |
| 25 | agent-bot-identity | — | **Shed host, soul and comms** from agent-bot-identity, leaving the identity CLI, hooks and attribution its charter keeps; HQ authority moves to agent-bot-daemon | Golden surface tests green; no HQ authority left in agent-bot-identity |
| 26 | agent-bot-souls, soul-package | — | **Carry core, `hq/` and `entry-point/`** into agent-bot-souls, and the package and render code into soul-package (path-filtered history, re-signed with origin trailers) | P1–P8 green |
| 27 | agent-bot-daemon | WP7 | **First bundled HQ release** (`governance/plugins.json`); Homebrew, GeniusBar and the Linux bundle switch; the old per-account daemon is retired after the contract and recovery suites pass | Golden surface tests green against the release |

### Stage 4: portability and relay (WP4, WP5)

| # | Repo | WP | PR | Done when |
| --- | --- | --- | --- | --- |
| 28 | agent-bot-daemon, soul-package | WP5 | **Coordinated move and fork** with transfer records | T15; P5, P6 |
| 29 | agent-bot-daemon | WP2 | **macOS protected profile** (per-member accounts plus a sandbox; HQ in its own account) | Same hostile-member suite as Linux |
| 30 | agent-comms | WP4 | **Relay mode:** site relay, then cloud relay. The crypto profile stays a candidate, and public federation stays off, until it is reviewed (Q8) | T12, T13 |

**Post-MVP:** the installation authority (partition-tolerant moves), hosted
Souls (D3), mobile owner clients, exposed specialist endpoints, public
federation.

## 10. Decisions, open questions, risks

### 10.1 Decisions

D1–D4 were decided on 2026-10-27, after PR #2 merged (issue #1); D5–D7 on 2026-11-07. Each is tracked in this repository's [Decisions discussions](https://github.com/true-line/agent-bot-daemon/discussions/categories/decisions).

These are this repository's decisions, and the platform's [decision log](https://github.com/true-line/agent-bot-platform/blob/main/docs/04-decisions/decision-log.md) cites them. A new decision that binds another repository is raised in the platform's [Decisions](https://github.com/true-line/agent-bot-platform/discussions/categories/decisions) category instead.

- **D1. agent-bot-daemon is HQ. Accepted.** managed-machine stays the
  provisioner: it creates HQ's account and the member accounts. The
  follow-ups are:
  - **0.4's component table and Appendix C:** no draft 0.4.1 exists
    (DRIFT-015). The platform records this decision in PDR-0002 decision 3
    and the repository catalog, and reads 0.4 together with PDR-0002;
  - **ADR-0645's `qwts/agent-identity` extraction:** retired by ADR-1183
    (qwts/agent-bot-identity#1194);
  - **ENG-0128:** its extraction amendment is replaced by ENG-0111
    (qwts/qwts-agent-sop#112). ENG-0128 was at its docs-gov token budget,
    so the change is a new record rather than another amendment.
- **D2. Provider credentials that can't be short-lived: (c) for the pilot,
  (a) as the target.** The pilot key:
  - is resolved from the identity service when HQ starts, never from a config
    file;
  - is held in HQ memory only, never on disk;
  - is named as an exception on every receipt;
  - is capped and rotated on the provider side.

  The target is per-task inference credentials, or the identity service
  acting as an inference gateway, so the key never reaches a host. **Q1
  (2026-10-27, "pick the best"):** for the pilot, the key is injected into
  the harness process environment for the soul's declared provider only.
  A loopback inference proxy (qwts/agent-bot-identity#1190) ends that. It
  must land before any `managed protected` claim, or at stage 3 exit,
  whichever comes first. Shipped in qwts/agent-bot-identity#1188.
- **D3. Hosted Souls: accepted as recommended.** soul-runtime's core stays
  pure, and there is no server-runtime work before the pilot gates. Hosted
  Souls remain the plan for hosts that can't run a daemon, so nothing may be
  designed that rules them out.
- **D4. Credentials and policy live in agent-bot-machine's `admin` sandbox;
  owner presence is a Secure Enclave signature checked there. Accepted
  2026-10-31.** On macOS, Homebrew and agent-bot-machine run in the `admin`
  account, and that account is the sandbox:
  - **Host-side credentials** (agent-machine's own keys; provider keys that
    can't be short-lived; App keys on a host not yet in server mode) live
    only in `admin`-owned `0600` files or `admin` keychain items. Members
    and the owner's `user` account cannot read them. They are used only by
    agent-machine, on agent-daemon's signed requests, and never returned:
    agent-machine performs the operation or returns a short-lived result.
  - **Policy** (harness → App map, server mode, feature gates, approvers)
    is readable by the daemon and the owner and writable only by
    agent-machine. A member that edits a copy changes nothing; the daemon
    refuses unsigned policy, keeps the last signed version, and alerts.
  - **Owner presence is enforced at the client and verified at the
    sandbox.** The owner's client (the `agent-bot` CLI, the local web UI,
    or the daemon acting for the owner) holds a non-exportable Secure
    Enclave key with a user-presence access control, so every signature
    needs Touch ID or the login password. Policy changes, pairing, adding
    an App and owner-gated actions carry that signature over the exact
    action digest, fresh and single-use. agent-machine pins the public
    key at pairing and refuses a privileged request without a valid
    signature, even when it is validly signed by the daemon. agent-machine
    never shows a prompt itself.
  - **keyd splits.** Key custody and signing move into agent-bot-machine
    (`admin`). What stays in the owner's session is the presence prompt and
    its Secure Enclave key, which hold nothing readable. keyd no longer
    depends on GeniusBar, which is a GUI only: both pieces get their own
    Developer ID-signed, notarized releases and Homebrew packages, and
    `agent-bot keyd install` points at them.
  - **Residual risk, stated:** while members share the owner's `user`
    account, any process there can use the daemon's machine-client key, so
    routine brokered operations (status, receipts, a credential-backed
    request) are reachable by any `user` process. They never yield a raw
    secret and are receipted with soul and session. Privileged and policy
    operations are not reachable, because they need the presence
    signature. Per-member accounts (D7) close the rest for members; what
    stays in `user` is the owner and the owner's delegates (D7).
  - **Repository home:** the target account is `true-line`, as
    [platform PDR-0002](https://github.com/true-line/agent-bot-platform/blob/main/docs/04-decisions/PDR-0002-repository-topology-and-admission.md) decision 7 now records, under the catalog's
    names (agent-bot-daemon, agent-bot-identity, agent-bot-souls,
    agent-comms, agent-bot-machine). Work lands in the current `qwts`
    repositories, and the owner transfers them when no install breaks.
  - **Signing team:** for now the same Developer ID team that signs
    GeniusBar, `Z5DM34QS5U` (identifier `agent-bot-keyd`, confirmed with
    `codesign -dv` on 2026-10-31; hosts pin it as `settings.keydTeamId`);
    later True-Line AI LLC's own team. The presence helper must ship as a
    bundle carrying an embedded Developer ID provisioning profile that
    grants `keychain-access-groups` (`$(AppIdentifierPrefix)<bundle-id>`),
    because macOS requires a provisioning profile to use the
    data-protection keychain and Secure Enclave keys under a Developer ID
    signature. The team change is a
    planned rotation, not a silent swap: a Secure Enclave key lives in its
    team's keychain access group, so the new build makes a new presence
    key; the old key signs a statement naming the new public key; the
    owner approves the re-pin at agent-machine and the agent-bot signer pin
    (`presence.signer`) changes through the owner gate. Until that
    statement is accepted, a build from the new team is refused.
- **D5. The WP1 contracts live in `true-line/soul-contracts`, not in
  this repository. Accepted 2026-11-07.**
  §3.1 and §9 row 1 had put the WP1 schemas and fixtures here, while the
  Soul Agent Platform repository plan (platform source S7,
  [2026-10-24](https://github.com/true-line/agent-bot-platform/blob/main/docs/papers/repository-plan-2026-10-24.md)) puts them in soul-contracts,
  which already shipped `hq/v1` Hello and admission result. The two
  baselines were derived independently (agent-bot-daemon#59 here, and
  soul-contracts 0.2.0) and then merged into soul-contracts 0.3.0.
  - **Why there:** HQ is one implementer among several (soul-package,
    agent-comms, agent-bot-identity, soul-adapters, soul-conformance), and
    0.4 forbids an implementer editing a shared schema to make its own code
    pass. Keeping the contracts in HQ's own repository would break that
    rule and point the other repositories' dependencies at HQ.
  - **Here:** agent-bot-daemon pins a soul-contracts release by digest (PR
    7) and keeps no local copies. This plan's Appendix A stays the
    compatibility inventory, which soul-contracts references at a pinned
    commit.
- **D6. HQ runs in its own OS account. Accepted 2026-11-07 (answers
  Q2).** The account is `_agent-bot-hq` on macOS (a hidden role account) and
  `agent-bot-hq` on Linux, created by agent-bot-machine (the provisioner,
  D1). HQ does not share `admin` with agent-bot-machine: if it did, it could
  read the admin-owned keys and files directly, and D4's presence check on
  privileged requests would stop being a boundary. Members and the owner's
  `user` account cannot read HQ's store.
- **D7. On macOS, one OS account per member. Accepted 2026-11-07 (answers
  Q1).** ENG-0339 is amended rather than replaced: its account creation and
  sandbox profile are kept, keyed by member instead of by harness, so two
  members on the same harness no longer share state (0.4 §4, T01–T03). The
  amendment lands in the SOP repository; #56 depends on it.
  - **Delegates stay in the owner's account.** Per-member accounts are for
    Soul members doing development work, which authenticate as their
    agent-bot bot identity. An agent the owner runs in their own `user`
    account is the owner's **delegate**. It has the
    owner's unbounded access, works on owner-level tasks rather than
    routine development, acts as the owner and says so when it posts, and
    where a delegate and another agent conflict the delegate generally takes
    precedence. D7 does not move delegates. D4 is unchanged: a privileged
    request still needs the owner's presence signature, which a delegate
    can request but not produce.
- **`legacy-local-custody`: removed at stage 3 exit or on 2027-01-31,
  whichever comes first.** It is off by default until then. It shipped off
  by default, with the date enforced in code, in
  qwts/agent-bot-identity#1185.

### 10.2 Open questions

- **Q1.** Answered by D7.
- **Q2.** Answered by D6.
- **Q3.** Answered ([#70](https://github.com/true-line/agent-bot-daemon/discussions/70)): keep `SOUL.md` (§5.2).
- **Q4.** Answered ([#71](https://github.com/true-line/agent-bot-daemon/discussions/71)): under `managed-protected`, service
  writes go only through the broker's GitHub adapter; member-side
  `signed-commit` stays only in the cooperative and unenforced profiles,
  which receipts name (Stage 2b, PR 19).
- **Q5.** Answered in soul-contracts' Decisions: Appendix A's directive or
  query (`wire/v1/directive-or-query`) is authoritative. agent-watcher maps
  its vocabulary onto it or records its own model as superseded, and
  anything it has that Appendix A lacks arrives as a soul-contracts change.
- **Q6.** Answered ([#72](https://github.com/true-line/agent-bot-daemon/discussions/72)): keep the PWA, read-only for the pilot
  (§7.1). A browser write path needs its own reviewed presence design.
- **Q7.** Answered ([#73](https://github.com/true-line/agent-bot-daemon/discussions/73)): the broker's pull is enough for the
  MVP, with no relay-pushed hint (§4.8). Measure notice latency and volume
  first; any later hint is an authenticated `notify`-class signal that
  cannot cold-start a Soul.
- **Q8.** Answered ([#74](https://github.com/true-line/agent-bot-daemon/discussions/74); soul-contracts
  [C19](https://github.com/true-line/soul-contracts/discussions/22)): no
  paid external reviewer, because the project has no budget for one. The
  decision is that no reviewer is named yet and federation stays off:
  - **Gated:** public federation and agent-comms step 6, until a reviewer
    is named. The reviewer can be an agent or a service the owner adds to
    the remote control plane; the profile states what kind of review it
    had.
  - **Not blocked:** local HQ-to-Soul work, the pilot, and everything
    through Stage 3.
  - **The agent-comms federation candidate** is input only. Agents may keep
    preparing it; they may not accept it or turn on public federation.
  - **`wire/v1` and `sealed-inner-v1`** do not change until a reviewed
    profile lands in soul-contracts as a contract change.

### 10.3 Risks

Risks the whole platform shares are in the platform's
[risk register](https://github.com/true-line/agent-bot-platform/blob/main/docs/10-program/risk-register.md): RISK-001 (vendor harnesses under strong
enforcement), RISK-002 and RISK-003 (HQ concentrates authority; the identity
service concentrates key custody), RISK-005 (the Linux protected profile
versus macOS) and RISK-008 (two daemons during the strangler period). The
risks below are this plan's own. Their IDs use the `HQ-RISK-` prefix so they
do not collide with the requirements R1–R12 (DRIFT-010); the old label is in
brackets.

| ID | Risk | Mitigation |
| --- | --- | --- |
| HQ-RISK-01 (R1) | Hub files: `agent-daemon.mjs` (2.4k lines), `readiness.mjs` (3.1k), `agent-population.mjs` (1.6k, 65 importers), `soul-runtimes.mjs` (1.5k) | Registries first (PRs 8–9) |
| HQ-RISK-02 (R2) | GitHub installation tokens are 1 h bearer tokens | They stay in HQ memory for brokered adapters only; device revoke revokes live tokens (PR 17) |
| HQ-RISK-03 (R7) | GeniusBar, installed hooks and the Worker load modules by path | Shims for two or more releases; golden tests |
| HQ-RISK-04 (R8) | The domain move strands enrolled devices (`ServerSession.device()` refuses on a server mismatch) | A signed alias statement from the identity service, with `server enroll --force` as fallback; passkeys only on `agents.true-line.ai` |
| HQ-RISK-05 (R9) | Windows parity | Windows comes later in 0.4; keep agent-comms' Windows acceptance suite running against the broker |
| HQ-RISK-06 (R10) | agent-bot-identity is busy | Stage 0 happens in place; each repo split is a single cut |
| HQ-RISK-07 | Until agent-bot-machine creates `_agent-bot-hq` (D6, its S6 slice), HQ runs in the owner's `user` account. D4's stated residual risk then covers HQ too: any `user` process, members included, can read HQ's store and reach its sockets, which the file mode alone guards | HQ reports `managed-cooperative` and names the account. The skeleton holds no credentials, grants or keys. A peer-credential check replaces the file mode before HQ moves accounts ([hq/README.md](../hq/README.md)) |

### 10.4 What changed from the first version of this plan

| First version | Now | Why |
| --- | --- | --- |
| The daemon runs as the agent user and is untrusted | HQ is trusted, in its own account | 0.4 §3, R3 |
| Policy, approvals, vault and soul storage on the server | Approvals, grants, budgets and ledgers in HQ; the server is the identity service only | 0.4 §3, §4, R2 |
| Server → daemon RPC over a Cloudflare relay (review fix) | Removed. Relays are agent-comms relay mode with sealed frames; notices are pulled | R2: relays get no execution channel. The review asked for RPC; this departs from it on 0.4's authority. |
| Leased provider secrets in plaintext in an agent-UID process | Brokered inference in HQ; members get references only (D2 covers static keys) | 0.4 §4, §5 |
| A home-made v3 with `soul.json` + `SOUL.md` + `AGENTS.md` | 0.4 §11 `Contents/` layout; SOUL.md is the persona primitive | [S4] owns the layout |
| A `/v2` UI API with a mobile relay path | `hq/v1` on the control socket; remote only through an owner tunnel | R2, 0.4 §4 |
| Server-side soul-runtime as a deliverable | Post-MVP (D3) | Outside 0.4 scope |
| Our own phases | 0.4 stages 0–4, WP1–WP7, T01–T30 | Shared gates |

---

## Appendix A. Module inventory and dependency map

**Stale.** The scan is pinned at agent-bot-identity `959daf9` (v0.13.0, 286
runtime files). On 2026-11-07 its `main` was v0.15.17 with 301 runtime files.
The table is refreshed when §9 PR 6 adds the target and domain columns to
`runtime-modules.json`. The **Target** column names plugin destinations, not
repositories: `soul-runtime/*` is agent-bot-souls (package and render code
goes to soul-package), `comms` is agent-comms, and `identity` splits as §2.1
describes.

Generated from a static scan at the pinned commits. Shims are resolved to
their targets. The **Domain** column uses the 0.4 trust domains: `HQ`,
`Soul`, `HQ + Soul` (shared library or core used on both sides),
`identity service`, `owner client` and `removed`.

Coupling flags are heuristic text matches:

- `fs` is `node:fs`;
- `exec` is `node:child_process`;
- `worktree`, `keyd` and `comms` are mentions;
- `net` is `fetch` or `node:http(s)`/`node:net`;
- `os-secret` is Keychain, pass or DPAPI;
- `key-material` is PEM or key generation.

### A.1 agent-bot-identity runtime modules

Static scan of every non-shim runtime `.mjs` (239 files; 47 one-line re-export shims omitted; tests, `scripts/`, `tools/`, `web/` and `keyd/` excluded).
Columns: **Now** is the ADR-0645 module; **Target** is the destination; **Domain** is the draft 0.4 trust domain the code runs in (§3.2); **Coupling** is a heuristic text scan; **Out/In** is internal imports / importers; **Cross-repo imports** are the edges that must become a host service, an `hq/v1` call or an SDK import; **Cycle** is the strongly connected component from §2.4.

| Module | Lines | Now | Target | Domain | Coupling | Out/In | Cross-repo imports | Cycle | Note |
| --- | ---: | --- | --- | --- | --- | ---: | --- | --- | --- |
| `acp-engine.mjs` | 729 | soul | soul-runtime/entry-point | Soul | exec | 3/1 | - |  |  |
| `acp-registry.mjs` | 387 | soul | soul-runtime/hq | HQ + Soul | fs, comms | 0/15 | - |  | Adapter manifests. |
| `agent-approvals.mjs` | 154 | cli | daemon | owner client | fs, keyd | 3/0 | `approval-action` `identity/identity-cli` |  |  |
| `agent-backfill.mjs` | 143 | soul | soul-runtime/core | HQ + Soul | fs, worktree | 1/1 | - | C1 |  |
| `agent-bot.mjs` | 52 | cli | daemon | owner client | fs, worktree, comms | 3/0 | - |  |  |
| `agent-daemon.mjs` | 2402 | host | daemon | HQ | fs, exec, worktree, keyd, comms, net, os-secret | 61/4 | `identity/identity-host` `agent-space` `soul-routes` `soul-history` `soul-memory` `agent-population` `soul-templates` `delegation-grants` `grant-github` `approval-action` `owner-action` `comms-membership` `comms-client` `agent-wake` `soul-mode` `identity-app-souls` `soul-profile` `soul-env` `sandbox` `soul-model` `cold-wake-settings` `daemon-launch` `team-start` `soul-home` `harness-auth` `wake-webhook` `acp-registry` `soul-package` `soul-env-migrate` `soul-runtimes` `soul-secrets` `soul-revisions` `wake-plane` `task-turns` `comms-relay` `soul-asides` `wake-resume` `skill-dream-service` `skill-dream-evidence` `soul-join` `soul-fork` | C5 | Becomes HQ (strangler, 0.4 §13). |
| `agent-hook.mjs` | 602 | host | daemon | Soul | fs, exec, worktree, comms | 5/1 | `identity/identity-host` `confinement` `agent-population` |  | Hook runner in harness processes; cooperative checks. |
| `agent-interaction.mjs` | 980 | host | daemon | HQ | fs, comms | 5/2 | `identity/identity-host` `agent-population` `soul-asides` |  |  |
| `agent-jobs.mjs` | 1180 | host | daemon | HQ | fs | 3/6 | - |  |  |
| `agent-mcp.mjs` | 505 | host | daemon | Soul | fs, exec, worktree | 3/0 | `identity/identity-host` |  | `agent-bot mcp` runs as an MCP server inside the Soul; asks HQ. |
| `agent-population.mjs` | 1644 | soul | soul-runtime/core | HQ + Soul | fs, worktree, comms | 9/65 | - | C1 |  |
| `agent-space-pack.mjs` | 382 | soul | soul-runtime/hq | HQ | fs, worktree, key-material | 3/1 | `identity/identity-soul` |  |  |
| `agent-space.mjs` | 670 | soul | soul-runtime/hq | HQ | fs, worktree | 7/10 | - | C2 |  |
| `agent-wake.mjs` | 157 | comms | comms | HQ | - | 0/1 | - |  |  |
| `agent-web.mjs` | 667 | host | daemon | HQ | fs, exec | 2/1 | `identity/identity-host` | C5 | Optional loopback PWA (owner only). |
| `approval-action.mjs` | 45 | soul | soul-runtime/core | HQ + Soul | - | 1/2 | - |  |  |
| `archive-budget.mjs` | 351 | soul | soul-runtime/core | HQ + Soul | fs | 0/1 | - |  |  |
| `bootstrap.mjs` | 827 | cli | daemon | owner client | fs, exec, worktree, os-secret | 8/0 | `identity/identity-cli` |  |  |
| `canonical-json.mjs` | 13 | shared | daemon/sdk | HQ + Soul | - | 0/10 | - |  |  |
| `child-env.mjs` | 59 | shared | daemon/sdk | HQ + Soul | keyd, comms | 0/8 | - |  |  |
| `claude-worktree-create.mjs` | 351 | soul | soul-runtime/entry-point | Soul | fs, exec, worktree | 11/0 | `identity/identity-soul` |  |  |
| `cli/dispatch.mjs` | 273 | cli | daemon | owner client | fs, exec, worktree, keyd, comms, os-secret | 2/1 | - |  |  |
| `cli/identity-apps.mjs` | 20 | cli | identity (owner command) | owner client | comms | 3/0 | `identity-app-souls` `owner-action` |  |  |
| `cli/identity.mjs` | 234 | cli | identity (owner command) | owner client | exec, worktree | 6/0 | `agent-population` `soul-package` |  |  |
| `cli/migrate-credentials.mjs` | 22 | cli | deprecated | removed | comms | 2/0 | `owner-action` |  |  |
| `cli/output.mjs` | 53 | cli | daemon | owner client | worktree, keyd, comms, os-secret | 0/1 | - |  |  |
| `cli/owner.mjs` | 33 | cli | identity (owner command) | owner client | keyd | 3/0 | `owner-action` |  |  |
| `cli/parse.mjs` | 72 | cli | daemon | owner client | worktree, keyd | 0/1 | - |  |  |
| `cli/principal.mjs` | 18 | cli | identity (owner command) | owner client | comms | 2/0 | `owner-action` |  |  |
| `cli/sandbox-export.mjs` | 26 | cli | soul-runtime (owner command) | owner client | - | 2/0 | - |  |  |
| `cli/skill-references.mjs` | 44 | cli | daemon | owner client | worktree, keyd | 0/1 | - |  |  |
| `cli/soul-dream.mjs` | 161 | cli | soul-runtime (owner command) | owner client | fs | 5/1 | `identity/identity-cli` |  |  |
| `cli/soul-env-transfer.mjs` | 28 | cli | soul-runtime (owner command) | owner client | - | 2/1 | `agent-jobs` |  | move/fork via `hq/v1`. |
| `cli/soul-skill.mjs` | 344 | cli | soul-runtime (owner command) | owner client | fs, worktree, keyd | 12/0 | - |  |  |
| `cold-wake-lock.mjs` | 43 | shared | daemon/sdk | HQ + Soul | fs | 1/3 | - |  |  |
| `cold-wake-settings.mjs` | 203 | soul | soul-runtime/hq | HQ | fs, comms | 7/14 | `identity/identity-soul` `wake-webhook-store` | C1 | Exports `ownerGate`; move to HQ approvals. |
| `cold-wake.mjs` | 405 | soul | soul-runtime/entry-point | Soul | worktree, comms | 7/1 | `comms-relay` |  |  |
| `comms-client.mjs` | 958 | comms | comms | HQ + Soul | fs, exec, comms, net, key-material | 2/4 | - |  |  |
| `comms-membership.mjs` | 54 | comms | comms | HQ | fs, worktree, comms | 2/4 | - |  |  |
| `comms-relay.mjs` | 73 | comms | comms | HQ | exec, worktree, comms | 1/3 | - |  |  |
| `comms-windows.mjs` | 606 | comms | comms | HQ + Soul | fs, exec, comms | 1/1 | - |  |  |
| `computer-use-activity.mjs` | 26 | host | daemon | HQ | - | 0/1 | - |  |  |
| `config-migration.mjs` | 95 | shared | daemon/sdk | HQ + Soul | fs | 2/2 | - |  |  |
| `config.mjs` | 592 | shared | daemon/sdk | HQ + Soul | fs, keyd | 1/42 | - |  |  |
| `confinement.mjs` | 467 | soul | soul-runtime/entry-point | Soul | fs, exec, worktree, keyd, os-secret, key-material | 11/1 | `identity/identity-soul` |  |  |
| `daemon-diagnostics.mjs` | 127 | host | daemon | HQ | - | 1/1 | - |  |  |
| `daemon-launch.mjs` | 531 | soul | soul-runtime/hq | HQ | fs, worktree, comms | 9/2 | - |  | HQ launches members under their principals. |
| `daemon-log.mjs` | 60 | shared | daemon/sdk | HQ + Soul | fs | 0/2 | - |  |  |
| `daemon-mcp.mjs` | 881 | host | daemon | Soul | fs, worktree, comms | 10/1 | `agent-population` `comms-relay` `soul-threads` `soul-asides` `identity/identity-host` `reach-contract` |  | `reach-mcp` inside the Soul; asks HQ. |
| `daemon-status.mjs` | 65 | comms | daemon | HQ | comms | 2/3 | `comms-client` |  |  |
| `daemon-supervisor.mjs` | 874 | host | daemon | HQ | fs, exec, keyd, comms | 6/4 | - | C5 |  |
| `delegation-grants.mjs` | 272 | host | identity | HQ | keyd | 3/1 | `agent-jobs` |  | Grant handles, caller-bound. |
| `detect-harness.mjs` | 568 | harness | daemon/sdk | HQ + Soul | exec, worktree | 2/12 | - |  |  |
| `diagnostic-redact.mjs` | 100 | shared | daemon/sdk | HQ + Soul | key-material | 0/3 | - |  |  |
| `diagnostics-cli.mjs` | 115 | cli | daemon | owner client | fs | 2/0 | `identity/identity-cli` |  |  |
| `diagnostics.mjs` | 224 | shared | daemon/sdk | HQ + Soul | fs | 2/2 | - |  |  |
| `doctor.mjs` | 131 | cli | daemon | owner client | worktree | 2/0 | `identity/identity-cli` |  |  |
| `executor-contract.mjs` | 432 | soul | soul-runtime/core | HQ + Soul | worktree | 2/3 | - |  |  |
| `file-lock.mjs` | 260 | shared | daemon/sdk | HQ + Soul | fs | 0/23 | - |  |  |
| `grant-github.mjs` | 142 | host | identity | HQ | os-secret | 2/1 | - |  | Grants are HQ records (0.4 §4). |
| `harness-auth.mjs` | 166 | soul | soul-runtime/entry-point | Soul | fs, exec | 7/2 | - |  |  |
| `hook-dialects.mjs` | 756 | harness | daemon/sdk | HQ + Soul | worktree | 0/6 | - |  |  |
| `identity-app-souls.mjs` | 18 | soul | soul-runtime/core | HQ + Soul | - | 2/2 | - |  |  |
| `identity-presence.mjs` | 4 | identity | daemon/sdk | HQ + Soul | - | 1/0 | - |  |  |
| `identity/agent-audit.mjs` | 180 | identity | identity | HQ | fs | 1/1 | - |  |  |
| `identity/agent-binding.mjs` | 474 | identity | identity | HQ + Soul | fs, exec, worktree | 3/10 | - |  |  |
| `identity/agent-identity.mjs` | 768 | identity | identity | HQ | fs, exec, worktree, comms | 5/10 | - |  |  |
| `identity/agent-principals.mjs` | 657 | identity | identity | HQ | fs, comms | 3/2 | - |  |  |
| `identity/binding-proof.mjs` | 61 | identity | daemon/sdk | HQ + Soul | comms | 0/5 | - |  | Duplicated in agent-comms; superseded by protected caller binding in the protected profile. |
| `identity/cli/mint-output.mjs` | 10 | identity | identity | Soul | - | 0/1 | - |  |  |
| `identity/cli/mint-token.mjs` | 82 | identity | identity | Soul | - | 7/0 | - |  |  |
| `identity/credential-reconciler.mjs` | 326 | identity | identity service | identity service | fs, keyd, os-secret, key-material | 5/2 | `identity/mint-token` | C1 |  |
| `identity/daemon-client.mjs` | 378 | identity | daemon/sdk | HQ + Soul | fs, exec, worktree, keyd, comms, os-secret | 3/33 | `identity/agent-binding` |  | Client of `hq/v1` and the member socket. |
| `identity/ensure-private-key.mjs` | 478 | identity | identity service | identity service | fs, keyd, os-secret, key-material | 6/2 | `identity/resolve-agent` | C1 | App key custody leaves the host (0.4 §3). |
| `identity/gh-app-hook.mjs` | 845 | identity | deprecated | removed | net | 0/0 | - |  | Replaced by identity-service webhooks + notices. |
| `identity/gh-inbox-query.mjs` | 158 | identity | deprecated | removed | fs | 0/0 | - |  | Notice filters replace it. |
| `identity/gh-pr-view-json.mjs` | 97 | identity | identity | Soul | fs, worktree | 1/0 | `identity/identity-app-store` |  |  |
| `identity/gh-shim.mjs` | 448 | identity | identity | Soul | worktree | 1/1 | - |  | Cooperative profile only. |
| `identity/git-credential-bot.mjs` | 224 | identity | identity | Soul | fs, worktree | 9/5 | - | C1 | Members never hold service tokens in the protected profile; brokered service adapter instead. |
| `identity/git-publish-scan.mjs` | 742 | identity | identity | Soul | worktree | 0/1 | - |  | Runs from git hooks. |
| `identity/identity-app-store.mjs` | 186 | identity | identity service | identity service | fs, keyd, os-secret, key-material | 4/8 | - | C1 |  |
| `identity/identity-apps.mjs` | 863 | identity | identity (owner command) → identity service | owner client | fs, exec, keyd, net, os-secret, key-material | 11/2 | `organization-profile` `identity/soul-credentials` `identity/ensure-private-key` `identity/identity-app-store` |  | App onboarding at the identity service. |
| `identity/identity-cli.mjs` | 28 | identity | identity | owner client | keyd | 18/12 | `identity/credential-reconciler` `identity/identity-app-store` `identity/inbox-probe` `identity/secret-store` `identity/secret` `identity/soul-credentials` |  |  |
| `identity/identity-entry.mjs` | 235 | identity | identity | HQ | worktree | 2/0 | - |  |  |
| `identity/identity-format.mjs` | 325 | identity | daemon/sdk | HQ + Soul | fs, worktree, keyd, os-secret | 1/86 | - |  | Wire/format constants. |
| `identity/identity-host.mjs` | 39 | identity | identity | HQ | keyd, comms, os-secret | 21/16 | `identity/inbox-take` `identity/secret-providers/pass-cli-credentials` `identity/secret-store` `identity/secret` |  |  |
| `identity/identity-routes.mjs` | 381 | identity | identity | HQ | worktree, keyd, comms, os-secret | 10/1 | `identity/identity-app-store` `identity/inbox-take` |  |  |
| `identity/identity-soul.mjs` | 29 | identity | identity | HQ | keyd | 14/18 | `identity/credential-reconciler` `identity/identity-app-store` `identity/soul-credentials` | C1 |  |
| `identity/inbox-probe.mjs` | 94 | identity | deprecated | removed | comms, net | 0/1 | - |  |  |
| `identity/inbox-take.mjs` | 243 | identity | deprecated | removed | exec, worktree, comms, os-secret | 3/2 | `identity/secret-providers/proton-pass` `identity/secret-store` |  | `take_inbox` → notices pulled by the broker. |
| `identity/install-gh-shim.mjs` | 503 | identity | identity | owner client | fs, exec | 3/1 | - |  |  |
| `identity/keyd-client.mjs` | 296 | identity | identity | HQ | fs, keyd, net, os-secret | 4/7 | - |  | Client of the HQ signer. |
| `identity/mint-token.mjs` | 319 | identity | identity | HQ | fs, worktree, keyd, net, key-material | 5/6 | `identity/soul-credentials` `identity/server-client` | C1 | Credential-reference resolution via the identity service. |
| `identity/owner-approval.mjs` | 110 | identity | identity | HQ | exec, worktree, keyd | 3/3 | - |  |  |
| `identity/owner-decision-action.mjs` | 236 | identity | identity | HQ | keyd, comms | 2/4 | - |  |  |
| `identity/owner-decision-bytes.mjs` | 31 | identity | identity | HQ | comms | 0/8 | - |  |  |
| `identity/owner-decision-evidence.mjs` | 481 | identity | identity | HQ | comms | 3/3 | - |  |  |
| `identity/owner-decision-journal-frame.mjs` | 243 | identity | identity | HQ | comms | 2/4 | - |  |  |
| `identity/owner-decision-journal-store.mjs` | 1082 | identity | identity | HQ | fs, comms | 8/2 | - |  |  |
| `identity/owner-decision-linked-event.mjs` | 105 | identity | identity | HQ | comms | 2/1 | - |  |  |
| `identity/owner-decision-local-outcome.mjs` | 113 | identity | identity | HQ | comms | 3/0 | - |  |  |
| `identity/owner-decision-prepared.mjs` | 109 | identity | identity | HQ | comms | 5/0 | - |  |  |
| `identity/owner-decision-receipt.mjs` | 131 | identity | identity | HQ | keyd, comms | 3/1 | - |  |  |
| `identity/owner-decision-trust.mjs` | 913 | identity | identity | HQ | fs, keyd, comms, os-secret, key-material | 4/2 | - |  |  |
| `identity/owner-gate.mjs` | 214 | identity | identity | HQ | worktree, keyd, comms, os-secret | 6/6 | - |  | Becomes HQ approval records (0.4 §8). |
| `identity/owner-presence.mjs` | 589 | identity | identity | HQ | fs, exec, worktree, keyd, os-secret | 6/7 | - |  | Owner session on the control socket replaces presence prompts for approvals. |
| `identity/owner-statement.mjs` | 986 | identity | identity | HQ | fs, exec, keyd | 4/4 | - |  |  |
| `identity/owner-text.mjs` | 32 | identity | identity | HQ | - | 0/2 | - |  |  |
| `identity/presence-verifier.mjs` | 38 | identity | daemon/sdk | HQ + Soul | keyd | 0/3 | - |  |  |
| `identity/resolve-agent.mjs` | 238 | identity | identity | HQ + Soul | fs, exec, worktree | 6/11 | `organization-profile` |  |  |
| `identity/secret-providers/pass-cli-credentials.mjs` | 88 | identity | identity service | identity service | os-secret | 2/2 | - |  |  |
| `identity/secret-providers/pass-cli.mjs` | 77 | identity | identity service | identity service | exec, os-secret | 0/2 | - |  | Proton Pass is a long-lived local secret path. |
| `identity/secret-providers/proton-pass.mjs` | 312 | identity | identity service | identity service | exec, os-secret | 1/2 | - |  |  |
| `identity/secret-store.mjs` | 157 | identity | identity service | identity service | - | 0/5 | - |  |  |
| `identity/secret.mjs` | 81 | identity | identity service | identity service | - | 3/2 | - |  | Vault: owner-unlock, per-owner encryption. |
| `identity/server-client.mjs` | 448 | identity | daemon (link) + identity (enrollment) | HQ | fs, exec, net, key-material | 1/1 | - |  | Identity-service link; device key in the HQ signer. |
| `identity/session-approvals.mjs` | 28 | identity | identity | HQ | - | 0/2 | - |  |  |
| `identity/signed-commit.mjs` | 310 | identity | identity | Soul | exec, worktree | 4/0 | - |  | Becomes a brokered service operation. |
| `identity/soul-credentials.mjs` | 553 | identity | identity service | identity service | fs, exec, keyd, os-secret, key-material | 9/7 | `identity/agent-identity` `identity/owner-gate` `soul-app-declarations` `identity/mint-token` | C1 | HQ gets credential references resolved to short-lived tokens instead. |
| `identity/soul-genesis.mjs` | 33 | identity | identity | HQ | - | 2/1 | - |  |  |
| `identity/uninstalled-identity-hook.mjs` | 900 | identity | identity | Soul | fs, exec | 2/1 | - |  |  |
| `identity/vouch.mjs` | 318 | identity | identity | HQ | fs, comms, key-material | 1/5 | - |  | Signing key moves into the HQ signer (non-exportable; soul token `v2`, ES256). |
| `identity/worktree-token.mjs` | 207 | identity | identity | Soul | fs, exec, worktree | 7/0 | - |  |  |
| `install.mjs` | 512 | cli | daemon | owner client | fs, exec, worktree | 7/3 | `spaces-cutover` `sandbox` |  |  |
| `keyd-supervisor.mjs` | 116 | host | identity | HQ | fs, exec, keyd, os-secret | 2/0 | `daemon-supervisor` |  | Supervises the HQ signer. |
| `metrics.mjs` | 393 | host | daemon | HQ | fs, exec, worktree, comms | 4/1 | `identity/identity-host` |  |  |
| `muse-acp.mjs` | 408 | soul | soul-runtime/entry-point | Soul | fs, exec | 0/0 | - |  |  |
| `organization-profile-schema.mjs` | 539 | shared | daemon/sdk | HQ + Soul | keyd | 0/3 | - |  |  |
| `organization-profile.mjs` | 33 | org | daemon | HQ | fs | 1/6 | - |  |  |
| `otlp-export.mjs` | 256 | host | daemon | HQ | - | 0/1 | - |  |  |
| `owner-action.mjs` | 268 | soul | soul-runtime/hq | HQ | keyd, comms | 4/16 | `identity/identity-soul` `owner-principal` | C1 | Becomes HQ approval records. |
| `owner-decision-computer-use.mjs` | 85 | host | daemon | HQ | comms | 4/0 | `identity/identity-host` `agent-population` |  |  |
| `owner-decision-effect-gate.mjs` | 126 | host | daemon | HQ | comms | 7/1 | `identity/identity-host` `owner-decision-target` `agent-population` `comms-client` |  |  |
| `owner-decision-identity-port.mjs` | 18 | host | daemon | HQ | comms | 1/1 | `identity/identity-host` |  |  |
| `owner-decision-reconcile.mjs` | 84 | host | daemon | HQ | fs, comms | 4/0 | `identity/identity-host` `soul-revisions` |  |  |
| `owner-decision-revision-port.mjs` | 77 | host | daemon | HQ | fs, comms | 0/2 | - |  |  |
| `owner-decision-target.mjs` | 84 | soul | soul-runtime/core | HQ + Soul | comms | 2/1 | - |  |  |
| `owner-decision-watch.mjs` | 57 | comms | comms | HQ | comms | 0/1 | - |  |  |
| `owner-principal.mjs` | 57 | comms | comms | owner client | comms | 2/1 | - |  |  |
| `process-ownership.mjs` | 112 | soul | soul-runtime/hq | HQ | fs, exec | 0/3 | - |  |  |
| `reach-contract.mjs` | 4 | comms | comms | HQ + Soul | - | 0/3 | - |  |  |
| `reach-env.mjs` | 9 | shared | daemon/sdk | HQ + Soul | - | 0/2 | - |  |  |
| `readiness.mjs` | 3119 | cli | daemon | owner client | fs, exec, worktree, keyd, comms, os-secret, key-material | 25/2 | `agent-space` `soul-memory` `soul-env` `sandbox` `agent-population` `spaces-cutover` `identity/identity-cli` `soul-builder` `soul-build` `soul-harness-contract` `setup-worktree` |  | 3.1k-line hub; plugins contribute probes. |
| `runtime-catalog.mjs` | 380 | soul | soul-runtime/core | HQ + Soul | - | 0/2 | - |  |  |
| `sandbox-export.mjs` | 443 | soul | soul-runtime/hq | HQ | fs, exec | 6/2 | - | C3 |  |
| `sandbox-remove.mjs` | 186 | soul | soul-runtime/hq | HQ | comms | 4/1 | - | C3 |  |
| `sandbox.mjs` | 804 | soul | soul-runtime/hq | HQ | fs, exec, worktree, comms | 7/5 | `sop` | C3 |  |
| `session-bind.mjs` | 154 | cli | identity | Soul | exec, worktree | 3/0 | - |  |  |
| `setup-worktree.mjs` | 535 | soul | soul-runtime/entry-point | Soul | fs, exec, worktree | 7/3 | `identity/identity-soul` |  |  |
| `shell-path.mjs` | 266 | shared | daemon/sdk | HQ + Soul | fs, exec, comms | 1/4 | - |  |  |
| `skill-dream-evidence.mjs` | 255 | soul | soul-runtime/core | HQ + Soul | fs | 3/1 | - |  |  |
| `skill-dream-inputs.mjs` | 465 | soul | soul-runtime/core | HQ + Soul | fs | 3/4 | - |  |  |
| `skill-dream-notices.mjs` | 226 | soul | soul-runtime/core | HQ + Soul | - | 2/1 | - |  |  |
| `skill-dream-outcomes.mjs` | 193 | soul | soul-runtime/core | HQ + Soul | - | 2/4 | - |  |  |
| `skill-dream-previews.mjs` | 124 | soul | soul-runtime/core | HQ + Soul | fs | 2/1 | - |  |  |
| `skill-dream-scheduler.mjs` | 815 | soul | soul-runtime/core | HQ + Soul | - | 5/3 | - |  |  |
| `skill-dream-service.mjs` | 252 | host | soul-runtime/hq | HQ | fs, comms | 8/1 | - |  | Dream admission under a dream grant. |
| `skill-dream-store.mjs` | 189 | soul | soul-runtime/core | HQ + Soul | fs | 1/1 | - |  |  |
| `skill-github.mjs` | 114 | soul | soul-runtime/core | HQ + Soul | - | 1/2 | - |  |  |
| `skill-install.mjs` | 260 | soul | soul-runtime/core | HQ + Soul | fs | 6/2 | - |  |  |
| `skill-learning.mjs` | 280 | soul | soul-runtime/core | HQ + Soul | fs | 6/3 | - |  |  |
| `skill-library-paths.mjs` | 11 | shared | daemon/sdk | HQ + Soul | - | 0/2 | - |  |  |
| `skill-library.mjs` | 644 | soul | soul-runtime/core | HQ + Soul | fs | 9/4 | - |  |  |
| `skill-manifest.mjs` | 132 | soul | soul-runtime/core | HQ + Soul | - | 3/3 | - | C3 |  |
| `skill-references.mjs` | 16 | soul | soul-runtime/core | HQ + Soul | - | 0/4 | - |  |  |
| `skill-remote.mjs` | 243 | soul | soul-runtime/core | HQ + Soul | net | 1/3 | - |  |  |
| `skill-search.mjs` | 77 | soul | soul-runtime/core | HQ + Soul | - | 5/1 | - |  |  |
| `skill-source-check.mjs` | 130 | soul | soul-runtime/core | HQ + Soul | fs | 3/1 | - |  |  |
| `skill-source-provenance.mjs` | 62 | soul | soul-runtime/core | HQ + Soul | - | 2/2 | - |  |  |
| `skill-status.mjs` | 50 | soul | soul-runtime/core | HQ + Soul | - | 5/1 | - |  |  |
| `skill-update-merge.mjs` | 44 | soul | soul-runtime/core | HQ + Soul | - | 0/1 | - |  |  |
| `skill-workspace.mjs` | 416 | soul | soul-runtime/hq | HQ | fs, exec, worktree | 5/1 | - |  |  |
| `skill.mjs` | 322 | cli | daemon | Soul | fs, exec | 2/0 | - |  |  |
| `sop-policy.mjs` | 80 | org | daemon | HQ | - | 0/1 | - |  |  |
| `sop.mjs` | 1522 | soul | daemon (org resolver) + soul-runtime/core (selection) | HQ | fs, exec, keyd | 10/6 | `agent-population` `identity/identity-soul` `owner-action` `acp-registry` `sandbox` | C3 | In cycle C3. |
| `soul-app-declarations.mjs` | 45 | soul | soul-runtime/core | HQ + Soul | - | 2/1 | - | C1 |  |
| `soul-asides.mjs` | 322 | soul | soul-runtime/core | HQ + Soul | fs, comms | 7/4 | `identity/identity-soul` |  |  |
| `soul-build.mjs` | 234 | soul | soul-runtime/hq | HQ | fs | 7/3 | `reach-contract` |  |  |
| `soul-builder.mjs` | 1292 | soul | soul-runtime/core | HQ + Soul | exec, comms | 4/6 | `reach-contract` |  |  |
| `soul-coauthor.mjs` | 111 | soul | soul-runtime/core | HQ + Soul | fs, exec, worktree | 4/0 | `identity/identity-soul` |  |  |
| `soul-comms.mjs` | 126 | soul | soul-runtime/core | HQ + Soul | fs, comms | 7/4 | `daemon-status` | C3 |  |
| `soul-computer-use-effect.mjs` | 45 | soul | soul-runtime/core | HQ + Soul | comms | 2/0 | - |  |  |
| `soul-computer-use.mjs` | 69 | soul | soul-runtime/hq | HQ | fs | 5/0 | `identity/identity-soul` |  |  |
| `soul-credential-migration.mjs` | 486 | soul | deprecated | removed | fs, keyd, os-secret, key-material | 10/1 | `agent-population` `organization-profile` `identity/identity-soul` `soul-providers` `soul-runtimes` `soul-package` `soul-revisions` |  | Obsolete once keys are at the identity service. |
| `soul-dir.mjs` | 61 | soul | soul-runtime/hq | HQ | fs | 3/1 | - |  |  |
| `soul-env-clean.mjs` | 294 | soul | soul-runtime/hq | HQ | fs | 7/0 | - |  |  |
| `soul-env-contract.mjs` | 117 | soul | soul-runtime/core | HQ + Soul | worktree | 1/4 | - |  |  |
| `soul-env-export.mjs` | 1177 | soul | soul-runtime/hq | HQ | fs, exec, worktree | 15/2 | - | C3 |  |
| `soul-env-history.mjs` | 95 | soul | soul-runtime/hq | HQ | fs | 2/0 | - |  |  |
| `soul-env-migrate.mjs` | 575 | soul | soul-runtime/hq | HQ | fs, os-secret | 16/3 | - | C4 |  |
| `soul-env.mjs` | 594 | soul | soul-runtime/hq | HQ | fs, worktree, comms | 18/3 | `identity/identity-soul` | C4 |  |
| `soul-fork.mjs` | 252 | soul | soul-runtime/core | HQ + Soul | fs, worktree, comms | 14/1 | `comms-membership` |  |  |
| `soul-harness-contract.mjs` | 141 | soul | soul-runtime/core | HQ + Soul | worktree | 0/5 | - |  |  |
| `soul-history.mjs` | 192 | soul | soul-runtime/core | HQ + Soul | fs | 1/4 | - |  |  |
| `soul-home.mjs` | 490 | soul | soul-runtime/hq | HQ | fs, exec, worktree | 11/6 | - |  |  |
| `soul-join.mjs` | 441 | soul | soul-runtime/hq | HQ | fs, exec, worktree, comms | 17/2 | `identity/identity-soul` `comms-membership` |  |  |
| `soul-memory.mjs` | 296 | soul | soul-runtime/core | HQ + Soul | fs, worktree | 5/10 | - | C2 |  |
| `soul-migration-journal.mjs` | 66 | soul | soul-runtime/core | HQ + Soul | fs | 0/5 | - |  |  |
| `soul-mode.mjs` | 256 | soul | soul-runtime/core | HQ + Soul | fs | 5/4 | - | C1 |  |
| `soul-model.mjs` | 263 | soul | soul-runtime/core | HQ + Soul | fs | 6/4 | - | C1 |  |
| `soul-package.mjs` | 570 | soul | soul-runtime/core | HQ + Soul | fs, keyd, comms, os-secret | 7/29 | - |  |  |
| `soul-pause.mjs` | 23 | soul | soul-runtime/hq | HQ | - | 1/0 | - |  |  |
| `soul-profile.mjs` | 315 | soul | soul-runtime/core | HQ + Soul | fs, worktree, os-secret | 5/4 | `sop` | C3 |  |
| `soul-providers.mjs` | 213 | soul | soul-runtime/core | HQ + Soul | keyd, os-secret | 1/6 | - |  |  |
| `soul-remove.mjs` | 268 | soul | soul-runtime/hq | HQ | fs, comms | 9/0 | `comms-membership` `daemon-status` |  |  |
| `soul-revisions.mjs` | 736 | soul | soul-runtime/core | HQ + Soul | fs, worktree, keyd, comms | 12/14 | - | C3 |  |
| `soul-routes.mjs` | 50 | soul | soul-runtime/core | HQ + Soul | worktree | 2/1 | - |  |  |
| `soul-runtimes.mjs` | 1473 | soul | soul-runtime/hq | HQ | fs, exec | 8/7 | - |  |  |
| `soul-secrets.mjs` | 256 | soul | soul-runtime/hq | HQ | fs, keyd, os-secret | 6/2 | `identity/identity-soul` |  | Becomes credential references; no plaintext to members. |
| `soul-stop.mjs` | 45 | soul | soul-runtime/hq | HQ | - | 4/1 | `identity/identity-soul` |  |  |
| `soul-template-refresh.mjs` | 195 | soul | soul-runtime/core | HQ + Soul | fs | 7/0 | - |  |  |
| `soul-templates.mjs` | 359 | soul | soul-runtime/core | HQ + Soul | fs | 10/5 | - |  |  |
| `soul-threads.mjs` | 395 | soul | soul-runtime/core | HQ + Soul | fs, worktree, comms | 4/5 | - |  |  |
| `soul-tool-home-record.mjs` | 131 | soul | soul-runtime/core | HQ + Soul | fs | 1/5 | - |  |  |
| `soul-tool-home.mjs` | 214 | soul | soul-runtime/hq | HQ | fs | 9/0 | `identity/identity-soul` |  |  |
| `soul-tool-homes.mjs` | 257 | soul | soul-runtime/core | HQ + Soul | os-secret | 0/8 | - |  |  |
| `soul-worktrees.mjs` | 87 | soul | soul-runtime/hq | HQ | fs, worktree | 2/3 | - |  |  |
| `souls-root.mjs` | 12 | soul | soul-runtime/hq | HQ | - | 1/6 | - |  |  |
| `spaces-cutover.mjs` | 300 | soul | soul-runtime/hq | HQ | fs | 3/2 | - |  |  |
| `state-paths.mjs` | 27 | shared | daemon/sdk | HQ + Soul | - | 0/39 | - |  |  |
| `sync-hooks.mjs` | 271 | cli | daemon | owner client | fs, worktree | 4/2 | `identity/identity-cli` |  |  |
| `task-turns.mjs` | 50 | comms | comms | HQ | fs, comms | 0/1 | - |  |  |
| `team-start.mjs` | 284 | soul | soul-runtime/core | HQ + Soul | fs | 6/1 | - |  |  |
| `telegram-adapter.mjs` | 817 | host | comms | HQ | fs | 6/0 | `agent-daemon` `agent-interaction` `identity/identity-host` |  | Channel adapter; external-untrusted provenance. |
| `traceparent.mjs` | 74 | shared | daemon/sdk | HQ + Soul | comms | 0/3 | - |  |  |
| `turn-env.mjs` | 53 | soul | soul-runtime/hq | HQ | keyd | 2/3 | - |  | Sets member HOME/XDG/PATH inside private state. |
| `turn-registry.mjs` | 86 | soul | soul-runtime/core | HQ + Soul | - | 2/2 | `identity/identity-soul` |  |  |
| `update.mjs` | 17 | cli | daemon | owner client | - | 1/0 | - |  |  |
| `wake-dispatch.mjs` | 307 | comms | comms | HQ | comms | 2/1 | - |  |  |
| `wake-listen.mjs` | 783 | comms | comms | Soul | fs, exec, worktree, comms, net | 1/0 | `identity/identity-soul` |  |  |
| `wake-plane.mjs` | 339 | host | soul-runtime/hq | HQ | worktree, keyd, comms | 10/2 | `agent-jobs` `daemon-mcp` `identity/identity-host` `wake-dispatch` |  | Wake decisions by the local broker (0.4 §6). |
| `wake-resume.mjs` | 379 | soul | soul-runtime/entry-point | Soul | fs, exec, worktree, comms | 5/5 | - |  |  |
| `wake-webhook-store.mjs` | 94 | comms | comms | HQ | fs | 3/2 | - |  |  |
| `wake-webhook.mjs` | 70 | comms | comms | HQ | worktree, comms | 2/1 | - |  |  |
| `windows-account-custody.mjs` | 292 | shared | daemon/sdk | HQ + Soul | exec, comms | 0/3 | - |  |  |
| `windows-cli-launcher.mjs` | 59 | shared | daemon/sdk | HQ + Soul | fs | 0/3 | - |  |  |
| `windows-git-shell.mjs` | 36 | shared | daemon/sdk | HQ + Soul | fs, exec, comms | 0/3 | - |  |  |
| `windows-install-path.mjs` | 36 | shared | daemon/sdk | HQ + Soul | exec | 0/1 | - |  |  |
| `windows-task-job.mjs` | 75 | host | daemon | HQ | comms | 0/1 | - |  |  |

### A.2 agent-comms modules

Every `bin/` and `lib/` module (105 files, 12683 lines). Broker mode runs inside HQ (draft 0.4 §3); relay mode is new code (§4.8).

| Module | Lines | Target | Domain | Coupling | Out/In | Note |
| --- | ---: | --- | --- | --- | ---: | --- |
| `bin/agent-comms.mjs` | 587 | comms (client) | HQ + Soul | fs, comms | 17/0 | CLI used by members and by HQ. |
| `bin/owner-supervised-broker.mjs` | 47 | comms (client) | HQ + Soul | comms | 3/0 | CLI used by members and by HQ. |
| `lib/asides-report.mjs` | 73 | comms | HQ | comms | 1/2 |  |
| `lib/binding-proof.mjs` | 61 | daemon/sdk | HQ + Soul | comms | 0/1 | Byte-identical copy of identity `binding-proof.mjs`. |
| `lib/broker.mjs` | 272 | comms | HQ | comms | 20/3 |  |
| `lib/broker/a2a-outbound.mjs` | 318 | comms (broker mode) | HQ | fs, comms | 2/1 | A2A gateway at the edge (0.4 §12). |
| `lib/broker/a2a.mjs` | 219 | comms (broker mode) | HQ | fs, comms, net | 2/2 | A2A gateway at the edge (0.4 §12). |
| `lib/broker/census.mjs` | 96 | comms (broker mode) | HQ | fs, comms | 3/1 |  |
| `lib/broker/channel-census.mjs` | 73 | comms (broker mode) | HQ | comms | 5/1 |  |
| `lib/broker/channels.mjs` | 258 | comms (broker mode) | HQ | comms | 4/1 |  |
| `lib/broker/launch.mjs` | 208 | comms (broker mode) | HQ | comms | 4/2 | Launch requests go to HQ lifecycle (0.4 R2). |
| `lib/broker/launchagent.mjs` | 4 | comms (broker mode) | HQ | - | 2/1 | Launch requests go to HQ lifecycle (0.4 R2). |
| `lib/broker/mailbox.mjs` | 229 | comms (broker mode) | HQ | comms | 6/1 |  |
| `lib/broker/message-admission.mjs` | 67 | comms (broker mode) | HQ | comms | 4/3 |  |
| `lib/broker/owner-admission.mjs` | 33 | comms (broker mode) | HQ | - | 2/1 |  |
| `lib/broker/owner-decisions.mjs` | 521 | comms (broker mode) | HQ | comms | 18/1 |  |
| `lib/broker/owner-enrollment-store.mjs` | 308 | comms (broker mode) | HQ | fs, comms | 5/0 |  |
| `lib/broker/owner-enrollment.mjs` | 43 | comms (broker mode) | HQ | comms | 1/2 |  |
| `lib/broker/owner-grants.mjs` | 23 | comms (broker mode) | HQ | - | 4/1 |  |
| `lib/broker/owner-ingress.mjs` | 45 | comms (broker mode) | HQ | comms | 5/1 |  |
| `lib/broker/owner-receipt-fixture.mjs` | 52 | comms (broker mode) | HQ | comms | 3/1 |  |
| `lib/broker/pairing.mjs` | 372 | comms (broker mode) | HQ | comms | 6/1 |  |
| `lib/broker/principal-target.mjs` | 32 | comms (broker mode) | HQ | comms | 2/1 |  |
| `lib/broker/server.mjs` | 3 | comms (broker mode) | HQ | - | 1/2 |  |
| `lib/broker/shared.mjs` | 44 | comms (broker mode) | HQ | comms | 1/14 |  |
| `lib/broker/tasks.mjs` | 136 | comms (broker mode) | HQ | comms | 2/2 |  |
| `lib/broker/watch.mjs` | 387 | comms (broker mode) | HQ | comms | 5/1 |  |
| `lib/build-metadata.mjs` | 13 | comms | HQ | fs, comms | 1/3 |  |
| `lib/channel-state.mjs` | 105 | comms | HQ | comms | 1/7 |  |
| `lib/client.mjs` | 351 | comms (client) | HQ + Soul | fs, exec, worktree, comms, net | 10/4 | CLI used by members and by HQ. |
| `lib/custody.mjs` | 4 | comms | owner client | comms | 2/5 | Principal secret in the owner account, never readable by members. |
| `lib/diagnostic-export-supervisor.mjs` | 41 | comms | HQ | - | 2/0 |  |
| `lib/diagnostic-export-writer.mjs` | 18 | comms | HQ | comms | 1/0 |  |
| `lib/diagnostic-export.mjs` | 276 | comms | HQ | fs, comms | 4/3 |  |
| `lib/diagnostic-fd.mjs` | 20 | comms | HQ | - | 0/1 |  |
| `lib/diagnostic-profile.mjs` | 108 | comms | HQ | comms | 0/4 |  |
| `lib/diagnostic-writer.mjs` | 20 | comms | HQ | fs, comms | 1/0 |  |
| `lib/diagnostics.mjs` | 193 | comms | HQ | comms | 3/2 |  |
| `lib/errors.mjs` | 39 | comms | HQ | - | 0/29 |  |
| `lib/host-config.mjs` | 56 | comms | HQ | fs, comms | 1/8 |  |
| `lib/owner-decision-admission.mjs` | 28 | comms (broker mode) | HQ | - | 2/3 | Owner decisions become HQ approval records. |
| `lib/owner-decision-canonical.mjs` | 81 | comms (broker mode) | HQ | - | 0/16 | Owner decisions become HQ approval records. |
| `lib/owner-decision-challenge.mjs` | 61 | comms (broker mode) | HQ | - | 2/2 | Owner decisions become HQ approval records. |
| `lib/owner-decision-codec.mjs` | 129 | comms (broker mode) | HQ | comms | 2/8 | Owner decisions become HQ approval records. |
| `lib/owner-decision-daemon-evidence.mjs` | 228 | comms (broker mode) | HQ | comms | 4/0 | Owner decisions become HQ approval records. |
| `lib/owner-decision-frame-classifier.mjs` | 71 | comms (broker mode) | HQ | - | 1/1 | Owner decisions become HQ approval records. |
| `lib/owner-decision-identities.mjs` | 9 | comms (broker mode) | HQ | - | 0/5 | Owner decisions become HQ approval records. |
| `lib/owner-decision-issuer.mjs` | 98 | comms (broker mode) | HQ | comms | 4/2 | Owner decisions become HQ approval records. |
| `lib/owner-decision-journal-errors.mjs` | 20 | comms (broker mode) | HQ | - | 0/1 | Owner decisions become HQ approval records. |
| `lib/owner-decision-journal-frame.mjs` | 97 | comms (broker mode) | HQ | comms | 0/2 | Owner decisions become HQ approval records. |
| `lib/owner-decision-journal.mjs` | 712 | comms (broker mode) | HQ | fs, comms | 10/1 | Owner decisions become HQ approval records. |
| `lib/owner-decision-lifecycle-records.mjs` | 176 | comms (broker mode) | HQ | comms | 7/1 | Owner decisions become HQ approval records. |
| `lib/owner-decision-namespace.mjs` | 12 | comms (broker mode) | HQ | comms | 1/0 | Owner decisions become HQ approval records. |
| `lib/owner-decision-prepared.mjs` | 45 | comms (broker mode) | HQ | comms | 3/5 | Owner decisions become HQ approval records. |
| `lib/owner-decision-proof.mjs` | 44 | comms (broker mode) | HQ | comms | 3/4 | Owner decisions become HQ approval records. |
| `lib/owner-decision-wire-operations.mjs` | 19 | comms (broker mode) | HQ | - | 0/2 | Owner decisions become HQ approval records. |
| `lib/owner-enrollment-codec.mjs` | 116 | comms (broker mode) | HQ | comms | 1/2 | Owner decisions become HQ approval records. |
| `lib/owner-enrollment-frame.mjs` | 71 | comms (broker mode) | HQ | comms | 2/1 | Owner decisions become HQ approval records. |
| `lib/owner-operation-grants.mjs` | 21 | comms (broker mode) | HQ | - | 0/4 | Owner decisions become HQ approval records. |
| `lib/owner-scoped-grants.mjs` | 43 | comms (broker mode) | HQ | - | 2/5 | Owner decisions become HQ approval records. |
| `lib/paths.mjs` | 26 | comms | HQ | comms | 1/5 |  |
| `lib/platform/account-isolation.mjs` | 401 | comms | HQ | fs, exec, comms | 4/10 |  |
| `lib/platform/daemon-requests.mjs` | 6 | comms | HQ | comms | 0/1 |  |
| `lib/platform/diagnostic-export-process.mjs` | 11 | comms | HQ | exec | 0/2 |  |
| `lib/platform/diagnostic-stderr.mjs` | 70 | comms | HQ | exec, comms | 0/1 |  |
| `lib/platform/durable-file.mjs` | 72 | comms | HQ | fs, exec | 2/1 |  |
| `lib/platform/identity-validators.mjs` | 18 | comms | HQ | - | 0/2 |  |
| `lib/platform/local-channel.mjs` | 597 | comms | HQ | fs, exec, comms, net, key-material | 6/4 |  |
| `lib/platform/owner-decision-readiness.mjs` | 26 | comms (broker mode) | HQ | fs, comms | 1/1 | Owner decisions become HQ approval records. |
| `lib/platform/owner-enrollment-guard.mjs` | 31 | comms (broker mode) | HQ | fs | 2/1 | Owner decisions become HQ approval records. |
| `lib/platform/owner-enrollment-source.mjs` | 8 | comms (broker mode) | HQ | comms | 0/0 | Owner decisions become HQ approval records. |
| `lib/platform/owner-journal-lock.mjs` | 39 | comms (broker mode) | HQ | fs | 1/4 | Owner decisions become HQ approval records. |
| `lib/platform/owner-journal-native.mjs` | 100 | comms (broker mode) | HQ | fs, exec | 1/2 | Owner decisions become HQ approval records. |
| `lib/platform/owner-observer-native.mjs` | 73 | comms (broker mode) | HQ | fs, exec | 3/1 | Owner decisions become HQ approval records. |
| `lib/platform/owner-observer-wire.mjs` | 69 | comms (broker mode) | HQ | comms | 0/2 | Owner decisions become HQ approval records. |
| `lib/platform/owner-receipt-capability.mjs` | 6 | comms (broker mode) | HQ | - | 0/0 | Owner decisions become HQ approval records. |
| `lib/platform/owner-receipt-native.mjs` | 145 | comms (broker mode) | HQ | fs, exec, comms | 3/0 | Owner decisions become HQ approval records. |
| `lib/platform/owner-receipt-wire.mjs` | 70 | comms (broker mode) | HQ | comms | 1/1 | Owner decisions become HQ approval records. |
| `lib/platform/owner-supervised-session.mjs` | 171 | comms (broker mode) | HQ | fs, comms | 1/2 | Owner decisions become HQ approval records. |
| `lib/platform/secret-store.mjs` | 130 | comms | owner client | fs, exec, os-secret | 5/2 | Principal secret in the owner account, never readable by members. |
| `lib/platform/service-startup.mjs` | 752 | comms | HQ | fs, exec, comms | 6/1 |  |
| `lib/platform/windows-environment.mjs` | 7 | comms | HQ | - | 0/5 |  |
| `lib/platform/windows-pipe-client.mjs` | 125 | comms | HQ | exec | 3/1 |  |
| `lib/platform/windows-pipe-stage.mjs` | 23 | comms | HQ | - | 0/2 |  |
| `lib/platform/windows-relay-artifact.mjs` | 36 | comms | HQ | fs, comms | 0/3 |  |
| `lib/platform/windows-task-job.mjs` | 65 | comms | HQ | - | 0/1 |  |
| `lib/platform/windows-task-stop.mjs` | 98 | comms | HQ | fs, exec, comms | 3/1 |  |
| `lib/principal-client.mjs` | 89 | comms (owner client) | owner client | comms | 6/1 | GeniusBar census and chat. |
| `lib/retention.mjs` | 94 | comms | HQ | - | 0/8 |  |
| `lib/skill.mjs` | 50 | comms | HQ | fs, exec, comms | 1/1 |  |
| `lib/state.mjs` | 552 | comms | HQ | fs, comms | 5/2 |  |
| `lib/trace-context.mjs` | 6 | comms | HQ | - | 0/2 |  |
| `lib/vendor/agent-bot-presence/identity-presence.mjs` | 4 | daemon/sdk | HQ + Soul | - | 1/4 | Vendored identity presence verifier snapshot. |
| `lib/vendor/agent-bot-presence/identity/presence-verifier.mjs` | 38 | daemon/sdk | HQ + Soul | keyd | 0/1 | Vendored identity presence verifier snapshot. |
| `lib/wire.mjs` | 75 | comms | HQ | comms | 1/8 |  |
| `lib/worker/adapters.mjs` | 72 | comms (client) → soul-runtime/entry-point | Soul | - | 1/1 | Converges with the entry point and member supervision. |
| `lib/worker/index.mjs` | 304 | comms (client) → soul-runtime/entry-point | Soul | comms | 11/1 | Converges with the entry point and member supervision. |
| `lib/worker/jail.mjs` | 71 | comms (client) → soul-runtime/entry-point | Soul | fs, worktree | 0/1 | Converges with the entry point and member supervision. |
| `lib/worker/metrics.mjs` | 11 | comms (client) → soul-runtime/entry-point | Soul | fs | 0/1 | Converges with the entry point and member supervision. |
| `lib/worker/options.mjs` | 66 | comms (client) → soul-runtime/entry-point | Soul | fs, worktree | 3/1 | Converges with the entry point and member supervision. |
| `lib/worker/prompt.mjs` | 64 | comms (client) → soul-runtime/entry-point | Soul | comms | 1/2 | Converges with the entry point and member supervision. |
| `lib/worker/task-turn.mjs` | 16 | comms (client) → soul-runtime/entry-point | Soul | - | 0/2 | Converges with the entry point and member supervision. |
| `lib/worker/tiers.mjs` | 43 | comms (client) → soul-runtime/entry-point | Soul | fs, comms | 1/1 | Converges with the entry point and member supervision. |
| `lib/worker/turn.mjs` | 94 | comms (client) → soul-runtime/entry-point | Soul | fs, exec | 0/1 | Converges with the entry point and member supervision. |
| `lib/worker/watch.mjs` | 23 | comms (client) → soul-runtime/entry-point | Soul | exec, comms | 1/1 | Converges with the entry point and member supervision. |
