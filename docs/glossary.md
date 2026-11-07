# Contract glossary

The WP1 contract vocabulary (stage 0, PR 1, issue #58).

**Normative source:** *Soul Agent Platform*, whitepaper draft 0.4
(Chris Kane, 2026-10-27), §3 "Vocabulary and component boundaries" —
pinned by SHA-256
`6e8b85af5aea5454314b7563fef83d50b5582f2b6bd9bd2a8a9bd64cdedd3030`.
This page adapts that vocabulary for the contract baseline; the whitepaper
wins on conflict. Definitions below are quoted or condensed from §3 unless
noted. Where a term has a schema encoding, `contracts/` owns it.

## Identity

| Term | Definition | Identity lifetime |
| --- | --- | --- |
| Principal | A human or organization that can own or delegate authority | Independent of an agent |
| Owner | The principal whose host account installed HQ and who configures a Soul's authority | Per HQ installation |
| Soul | Persistent agent with one address and inbox; one stable public identity (R1) | Across moves and revisions |
| Definition revision | Immutable accepted configuration and content digest | One configuration version |
| Life | A Soul's selected durable state: knowledge, dream inputs, comms mirror, member homes, workspaces | Across moves; distinct from the definition |
| Member | A role-bearing participant inside a Soul; the lead or a specialist | Across replacement runtimes |
| Lead | The one member that plans, routes work, and may finalize task decisions | Per role assignment |
| Specialist | A member that returns proposals and evidence to the lead | Per role assignment |
| Installation | A Soul deployed on a particular host | One deployment |
| Installation epoch | Monotonic fencing value for an installation authority | Advances on authorized replacement |
| Runtime | One admitted execution instance of a member | Until exit or revocation |
| Session | A bounded interaction context within a runtime | Per context or conversation |

## Authority and enforcement

| Term | Definition | Schema encoding |
| --- | --- | --- |
| HQ | The local headquarters service: a trusted host service outside every Soul; admits runtimes, obtains short-lived credentials, hosts the broker, enforces limits | — |
| Task | A durable objective with an owner, state, budget, and completion criteria | `broker/task-record.schema.json` |
| Grant | HQ's record that a principal authorized a class of action for a Soul, member, or runtime | `broker/grant-record.schema.json` |
| Grant handle | A broker-generated opaque reference to a grant, bound to the admitted caller; never user-chosen | `hq-v1/equip.schema.json` |
| Credential reference | An opaque pointer to a short-lived credential HQ obtains from the identity service; never the secret itself | `hq-v1/equip.schema.json` |
| Directive | A task offer from HQ backed by authenticated local authority; peer text cannot acquire the kind (T04) | `broker/directive-query.schema.json` |
| Query | A member's question to HQ, answered with a decision record | `broker/directive-query.schema.json` |
| Approval | HQ-signed record bound to the digest of the proposed action, from the authenticated owner session | `hq-v1/approval-record.schema.json` |
| Receipt | An enforcing service's record of a decision or action; notes are self-reported and are not receipts | — |
| Enrollment | One-time registration of a Soul, node, or relay with an owner-confirmed challenge | — |
| Admission (clock-in) | Per-start verification of a Soul and its runtimes by local HQ | `hq-v1/hello.schema.json` |
| Dream run | One admitted sleep workflow under a dream grant | `records/dream-grant-record.schema.json` |
| Candidate revision | A staged definition revision awaiting evaluation and owner acceptance | `records/candidate-revision-record.schema.json` |
| Eval cell | One role on one harness version and one provider within an evaluation plan | `records/eval-plan-record.schema.json` |
| Primitive | An accepted skill, helper script, tool guidance, or hook in harness-neutral canonical form | — |
| Render | The deterministic build step that turns primitives into each adapter's native configuration | — |

## Enforcement profiles (0.4 §4)

Every receipt names the profile in force; a protected claim under a weaker
profile is refused with `profile_insufficient` (R8, T21).

| Value | Meaning |
| --- | --- |
| `managed-protected` | Host-enforced member boundaries, broker-only protected egress, caller-bound grants, durable receipts |
| `managed-cooperative` | HQ protects keys, but members share a trust domain or have bypass routes |
| `standalone-unenforced` | Local stub and local credentials within the agent's trust domain |

## Wake classes (0.4 §6)

| Value | May cold-start an idle Soul |
| --- | --- |
| `none` | No — mailbox only |
| `notify` | No — warm session only |
| `task` | Yes, when the local broker confirms wake grant and budget |
| `owner` | Yes — originated by the authenticated owner through HQ |

A frame whose provenance is `external-untrusted` never cold-starts a Soul
regardless of its declared wake class.

## Task and action states (0.4 §7)

- Task states: `offered`, `accepted`, `running`, `waiting`,
  `reconciling`, `completed`, `failed`, `canceled`, `expired`. The active
  states are `accepted`, `running`, `waiting`, `reconciling`. A `waiting`
  task records one of: `owner_input`, `owner_pause`, `dependency`,
  `provider_availability`, `credential_unavailable`,
  `reconciliation_decision`.
- Action states: `prepared`, `submitted`, `succeeded`, `rejected`,
  `unknown`. An `unknown` outcome is reconciled by lookup, never blind
  replay (T06).

## Provenance values (0.4 §4)

`owner`, `hq`, `member`, `peer`, `external-untrusted`. Record source
provenance separately from data sensitivity; derived outputs inherit the
union of relevant source restrictions, and a model cannot clear its own
taint.

## Error codes

The 27 minimum error codes live in [`governance/error-codes.json`](../governance/error-codes.json)
(add-only). They are snake_case, exactly as 0.4 lists them.
