# Epic and issue plan — agent-bot HQ + plugins

**Source plan:** [docs/daemon-plugin-split.md](daemon-plugin-split.md) §9
(30 PRs, stages 0–4, WP1–WP7) · **Governing issue:**
[`true-line/agent-bot-daemon#1`](https://github.com/true-line/agent-bot-daemon/issues/1)
· **Decisions:** ADR-1183 (`qwts/agent-bot-identity`), ENG-0111
(`qwts/qwts-agent-sop`)

**Status:** Draft, not yet filed. `gh` is not authenticated in this
session, so issues cannot be created until `gh auth login` or a
`GH_TOKEN` is available.

## 0. Repo map (after org consolidation)

Canonical org is **`true-line`**. Everything moves there; `qwts` stays
as a read-only mirror/redirect during the transition.

| Repo | Role | State today |
| --- | --- | --- |
| `true-line/agent-bot` (Go, private) | **Global server** at `agents.true-line.ai` — identity service: keys, grant-bound minting, issuance records, owner vault, notices | Exists; 6 issues, 1 PR |
| `true-line/agent-bot-daemon` (public) | **HQ host** — `hq/v1` control socket, authoritative store, plugin host, `agent-bot` CLI | Exists; this repo's docs only, 13 issues |
| `true-line/agent-bot-identity` | **Identity plugin** — device enrollment, HQ signer, credential refs, grants/approvals; local identity provider + client of `agents.true-line.ai` | **To transfer** from `qwts/agent-bot-identity` |
| `true-line/agent-bot-comms` *(assumed name)* | **Comms plugin** — broker in HQ, client in Soul, site/cloud relay | **To transfer + rename** from `qwts/agent-comms` |
| `true-line/agent-bot-soul-runtime` *(assumed name)* | **Soul runtime** — `contents-1` package, validator, render, HQ side + entry point | **Does not exist yet** — create in Stage 0 |
| `true-line/agent-bot-souls` (public) | Soul **packages/instances** (content, not code) | Exists; empty, 0 issues |
| `true-line/agent-bot-machine` (Go, public) | Provisioner — creates HQ account + member accounts (per D1) | Exists; 19 issues, 3 PRs |
| `true-line/agent-bot-platform` (private) | **Unknown** — empty; confirm role (umbrella/product vs. hosted runtime) | Exists; empty |
| `qwts/*` | Legacy — mirror + GitHub redirects after transfer | Source for identity/comms today |

> **Naming assumptions to confirm:** (a) comms transfers as
> `true-line/agent-bot-comms` (matches the plan's PR 24 rename) rather
> than keeping `true-line/agent-comms`; (b) soul runtime is a new repo
> `true-line/agent-bot-soul-runtime`, distinct from
> `true-line/agent-bot-souls`; (c) identity keeps its name
> `true-line/agent-bot-identity`.

## 1. Tracking mechanics (both, per request)

- **Milestone issues:** one epic issue per epic below, filed in this
  repo (`true-line/agent-bot-daemon`), with the 30 PR-issues linked
  via `Refs` in each PR body and sub-issue links in the epic.
- **GitHub Project:** one org Project ("agent-bot HQ split") in
  `true-line`, columns by stage (0–4), fields: **Repo**, **WP**,
  **Done-gate** (test from [test-matrix.md](test-matrix.md)),
  **Status**, **Blocked-by**.
- **Labels:** `stage-0..4`, `wp1..wp7`, `p0`/`p1`, `epic:E0..E7`.
- **Rule (from the plan §9):** one issue = one PR, mergeable alone,
  reversible, SOP-compliant (issue first, PR-first, bot-signed).
  Golden surface tests stay green at every step; `legacy-local-custody`
  removal date (2027-01-31) is enforced in code.

## 2. Epics

### E0 — Org consolidation (prerequisite, unblocks everything)
Transfer identity + comms `qwts` → `true-line`, update every
reference, decide `agent-bot-platform`'s role. **Must land before
Stage 0 PRs so issues are filed in the right repo.**

### E1 — Contract baseline, Stage 0 (WP1, PRs 1–11)
In place in `true-line/agent-bot-identity` behind golden tests:
contracts/schemas/fixtures, break import cycles C1–C5, route/MCP/CLI
registries, identity-service link hardening, notices.

### E2 — Local vertical slice, Stage 1 (WP2–WP4, PRs 12–14)
HQ strangler (store, `hq/v1`, Hello/Admit/Equip/Ready/Lease), task
service in HQ store, entry point `agent-bot soul run`.

### E3 — Member isolation + brokered adapters, Stage 2 (WP2/WP4, PRs 15–20)
HQ signer (hardware key, soul-token v2), Linux protected profile,
`true-line/agent-bot` grant-bound minting, credential refs,
brokered GitHub adapter + budgets/ledger, retire `gh-app-hook`.

### E4 — Operator pilot, Stage 3 (WP5/WP6, PRs 21–27)
Owner `hq/v1` + approvals, `contents-1` package + `soul migrate`,
Dream workflow, comms rename, shed + carry repo splits, first
bundled HQ release.

### E5 — Portability + relay, Stage 4 (WP4/WP5, PRs 28–30)
Move/fork transfer records, macOS protected profile, site → cloud
relay.

### E6 — True-line identity provider (cross-cutting, from your ask)
`agent-bot-identity` serves agents locally *and* connected to
`agents.true-line.ai`: enrollment, owner-unlock vault, issuance
records, revocation. Built across PRs 10, 15, 17–18; the epic owns
the end-to-end contract (DPoP, signed responses, `device_revoked`).

### E7 — SDK `@agent-bot/sdk` (cross-cutting)
Ships at PR 7 (`definePlugin`, host services, `createTestHost`,
conformance suite, `wire/`); versioned with every wire contract
(`hq/v1`, broker wire, `task/v1`, package format, `agent-bot-sig-v1`).

## 3. Issues — PR sequence (§9) mapped to target repos

| # | Title (issue) | Repo | WP | Done-gate |
|---|---|---|---|---|
| 1 | Contracts: glossary, JSON Schemas (0.4 App. A), error registry, fixtures, R1–R12 traceability, inventory baseline | daemon | WP1 | Fixtures validate; no vendor token (R10) |
| 2 | Golden surface tests: every `agent-bot` command, MCP tool, route-auth row | identity | WP7 | Green on `main` unchanged |
| 3 | Break cycle C1 (identity ↔ soul inversion; `ownerGate` → approvals) | identity | WP2 | `identity → soul` edge gone |
| 4 | Break cycles C2, C4, C5 | identity | WP3 | SCC count 2 |
| 5 | Break cycle C3 (`sop.mjs` split, `RevisionStore`) | identity | WP3 | No cycles |
| 6 | Target/domain columns in `runtime-modules.json`; ban new plugin→plugin edges | identity | WP1 | Merged, no runtime change |
| 7 | SDK v0: `definePlugin`, host services, `createTestHost`, conformance suite, `wire/` | daemon | WP1 | Pinned, digested copy |
| 8 | Route registry (generalises `createIdentityRoutes`/`createSoulRoutes`) | identity | WP2 | `daemon-route-auth.test.mjs` unchanged |
| 9 | MCP and CLI registries | identity | WP3 | Golden tests green |
| 10 | Identity-service link split + hardening (no redirects, DPoP, key-set check) | identity | WP2 | Each refusal tested |
| 11 | Notices pulled with custody-then-ack; `take_inbox` becomes alias | identity | WP4 | T05-style dedup passes |
| 12 | HQ skeleton in own account: store, control socket, profile reporting, `hq/v1` Hello/Admit/Equip/Ready/Lease; supervises existing daemon (strangler) | daemon | WP2 | Reports `managed cooperative` honestly; T14 |
| 13 | Task service in HQ store (`task/v1`, CAS, op keys, proposals vs commitments); directives/queries as broker kinds | comms | WP4 | T04, T05, T20 |
| 14 | Entry point `agent-bot soul run`: ACP front door, terminal chat, lead+specialist on fake adapters, role routing, handoff, recovery | soul-runtime | WP3 | One task, scoped proposals, one commitment |
| 15 | HQ signer: device key in TPM/Secure Enclave under HQ account; soul-token v2 (ES256); remove `vouch-key.pem`; re-enrollment | identity | WP2 | `key_storage=hardware`; no key file; T02 |
| 16 | Linux protected profile: per-member identities, namespaces, broker socket + workspace views as only exits, caller-bound grants | daemon | WP2 | T01–T03, T21 |
| 17 | **Global server:** grant-bound minting per task+op, issuance records (`task_id`, `operation_id`), revocation, attestation, software-key policy, owner vault | agent-bot (Go) | WP2 | Cached tokens dropped + `device_revoked` on revoke |
| 18 | Credential refs resolved by HQ; `legacy-local-custody` off by default (dated removal 2027-01-31) | identity | WP2 | No long-lived secret on fresh host |
| 19 | Brokered inference + GitHub service adapter, action ledger + reconciliation, budgets/sub-allocations | comms | WP4 | T06–T11, T17–T19, T23, T25, T26 |
| 20 | Retire `gh-app-hook` | identity | WP4 | `doctor` has no `inbox.*` checks |
| 21 | Owner interface: `hq/v1` owner ops, approval records, enrollment/receipts in HQ CLI; GeniusBar moves to `hq/v1` | daemon | WP6 | T24 |
| 22 | `contents-1` package, validator, `soul migrate`, render per adapter, digests in `SoulLock.json` | soul-runtime | WP5 | T16; conformance P1–P4 |
| 23 | Dream workflow (0.4 §10): dream member/grant, staged candidate tree, per-cell eval, owner digest acceptance | soul-runtime | WP5 | T22, T27–T30 |
| 24 | Rename `agent-comms` → `agent-bot-comms`; broker/client/relay as one plugin package; carry comms modules | comms | — | Plugin conformance green |
| 25 | Shed host/soul/comms from identity; identity plugin + signer only | identity | — | Plugin conformance green |
| 26 | Carry core/`hq/`/entry-point into `agent-bot-soul-runtime` (path-filtered, re-signed) | soul-runtime | — | P1–P8 green |
| 27 | First bundled HQ release (`governance/plugins.json`); Homebrew/GeniusBar/Linux bundle switch; retire old daemon | daemon | WP7 | Golden tests green vs. release |
| 28 | Coordinated move + fork with transfer records | soul-runtime | WP5 | T15; P5, P6 |
| 29 | macOS protected profile (per-member accounts + sandbox) | daemon | WP2 | Same hostile-member suite as Linux |
| 30 | Relay mode: site relay, then cloud relay; reviewed crypto profile | comms | WP4 | T12, T13 |

## 4. Issues — org consolidation (E0, new)

| ID | Title | Repo(s) |
|---|---|---|
| M1 | Transfer `qwts/agent-bot-identity` → `true-line/agent-bot-identity` (GitHub transfer; keep `qwts` mirror + redirect; update remotes, `Formula`, docs links, ADR-1183 pointers, server config) | agent-bot-identity |
| M2 | Transfer `qwts/agent-comms` → `true-line/agent-bot-comms` (decide name, PR 24 pre-landing; broker protocol version bump noted) | comms |
| M3 | Create `true-line/agent-bot-soul-runtime` (seed from plan §3.1; block PRs 14, 22, 23, 26 until seeded) | soul-runtime |
| M4 | Decide `true-line/agent-bot-platform` role: product umbrella, hosted-runtime candidate, or archive | platform |
| M5 | Confirm `true-line/agent-bot` (Go) owns PR 17 scope + E6 server contract; sync its API docs with daemon §4.7 | agent-bot |
| M6 | Org-wide link/infra sweep: `agents.true-line.ai` as default server, `qwts` → `true-line` in ADRs/ENG records, signed-commit identity pins | all |

## 5. Open questions (from plan §10.2 — keep as issues, owner: Chris)

Q1 member accounts on macOS · Q2 HQ account name/creator · Q3
`SOUL.md` filename · Q4 brokered signed-commits · Q5 agent-watcher
model supplier · Q6 browser PWA · Q7 notices hint via relay · Q8
federation crypto reviewer.
