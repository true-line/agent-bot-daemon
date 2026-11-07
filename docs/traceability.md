# Requirement traceability

The WP1 traceability matrix (stage 0, PR 1, issue #58), adapted from
*Soul Agent Platform* draft 0.4 Appendix D and §14 — pinned by SHA-256
`6e8b85af5aea5454314b7563fef83d50b5582f2b6bd9bd2a8a9bd64cdedd3030`.
WP1 maintains this matrix as schemas and tests are added; a PR that adds a
test updates the affected rows in the same change. `tests/traceability.test.mjs`
enforces ID coverage for R1–R12 and T01–T30.

The tests (T01–T30) are 0.4's gates; they are owned by the conformance
effort, not implemented in this repository. This matrix is the contract
side: which requirement each test verifies, and which stage's exit gate
first requires it.

## Requirements R1–R12 (0.4 §2, §Appendix D)

| Req | Requirement (condensed) | Specified in | Verified by | First gate |
| --- | --- | --- | --- | --- |
| R1 | A Soul has one stable public identity; members, installations, runtimes, sessions, and revisions remain separately attributable | §3, §5, §11 | T15, T16 | 3 |
| R2 | Only local HQ controls lifecycle and protected operations; relays deliver messages and presence only; the owner's administrative channel terminates at local HQ | §3, §4, §5, §6 | T12, T24 | 3 (T24), 4 (T12) |
| R3 | A task's authority is enforced outside the model and tool trust domain; credentials and signing keys stay there | §4, §7, Appendix A | T01, T02, T03, T20 | 1 (T20), 2a |
| R4 | The owner chooses role assignments and approved destinations; evaluations inform and do not grant permission | §9, §10 | T22 | 3 |
| R5 | One Soul has one aggregate communication and spending ceiling with named sub-allocations; nested members do not multiply it | §8, §15 | T11, T26 | 2b |
| R6 | External material remains data; its claimed instructions cannot become owner directives | §4, §6, §10 | T04, T10, T19 | 1 (T04), 2b |
| R7 | Cross-component behavior is specified and tested before implementations depend on it; wire supports N and N-1 with explicit capability negotiation | §6, §12, Appendix A | T14 | 0 |
| R8 | Every operating profile reports its actual enforcement guarantees; missing protection refuses or names a weaker profile, never a silent downgrade | §4, §7, §8 | T21 | 2a |
| R9 | Every tier keeps working without its upstream; local work continues during outages; messages queue store-and-forward | §6, §9 | T13, T25 | 2b (T25), 4 (T13) |
| R10 | No contract names a model, provider, or harness vendor; vendor names appear only in configuration, adapter manifests, and evaluation records | §12, §13 | Schema review in WP1; no vendor token in any fixture | 0 |
| R11 | A Soul looks like one harness to its user: terminal chat and an ACP agent server in front; members invisible except through the audit trail | §3, §8 | Pilot rubric | 3 |
| R12 | A Soul vendors and pins everything it runs on except declared OS baseline and host toolchains, checked at activation | §11 | T16; clean-host activation reports missing toolchains | 3 |

## Tests T01–T30 (0.4 §14)

| Test | Stimulus | Required observation | Gates |
| --- | --- | --- | --- |
| T01 Caller binding | Copy a handle from member A to member B | Broker refuses B before the protected operation, including after restart | 2a |
| T02 Key boundary | Member reads HQ files or invokes credential tooling directly | No secret or signing capability becomes available | 2a |
| T03 Direct egress | Harness bypasses inference or service proxy | Host blocks the route in protected mode | 2a |
| T04 Source authority | Peer claims owner approval | Request remains peer data; no grant or directive is created | 1 |
| T05 Duplicate message | Deliver an identical frame repeatedly | One committed task transition; stable prior receipt returned | 1 |
| T06 Ambiguous effect | Crash after remote acceptance | Reconciliation discovers the result or exposes unknown; no blind write retry | 2b |
| T07 Competing leads | Old and new runtime finalize together | Only current lease generation and expected revision commit | 2b |
| T08 Revoked work | Revoke authority while a message queues | Consume, wake, and execution refuse the invalid authority | 2b |
| T09 Destination change | Fail over a restricted task to another provider | Entry point skips it and broker independently denies any attempt | 2b |
| T10 Memory laundering | External text proposes a new primitive | Source chain persists; no self-accepted control change | 2b |
| T11 Aggregate budget | Four members send or spend concurrently | Atomic reservations preserve one Soul-level ceiling and its sub-allocations | 2b |
| T12 Split planes | Relay sends a lifecycle-looking message | No start, stop, or exec reaches the control socket | 4 |
| T13 Partition | Disconnect relay for one hour | Local traffic continues; queued work drains with deduplicated transitions | 4 |
| T14 Version mismatch | Use N-1 and an unknown required capability | Supported version works; unsupported semantics fail explicitly | 0 |
| T15 Transfer | Restore settled and open tasks on destination | History survives; old runtime authority is unusable; new leases are issued | 4 |
| T16 Package attack | Import bad digest, traversal path, or dependency cycle | Validation refuses activation before untrusted execution | 3 |
| T17 Cancellation race | Cancel while finalization or remote write races | One task outcome wins; in-flight effects remain visible and reconciled | 2b |
| T18 Storage failure | Exhaust mailbox or lose durable storage | No false custody acknowledgement; backpressure or safe refusal is visible | 2b |
| T19 Taint egress | Member sends externally derived content to a third-party destination | Egress blocked unless disclosure policy allows the destination; receipt names the source chain | 2b |
| T20 Proposal only | A specialist posts a final answer directly to a task | It is recorded as a proposal; only the lead's commitment finalizes | 1 |
| T21 Profile honesty | Run the protected suite under the cooperative profile | Every receipt names cooperative; any protected claim is refused with `profile_insufficient` | 2a |
| T22 Self-activation | A sleep run with a passing evaluation activates its own candidate | Refused; candidate waits for owner acceptance with its evidence attached | 3 |
| T23 Poison message | One message fails processing five times | That message is quarantined; the rest of the mailbox keeps delivering | 2b |
| T24 Approval binding | Edit a proposed action after the owner approved it | The approval no longer matches; the broker refuses the edited action | 3 |
| T25 Message expiry | A queued message passes its expiry while the Soul is unavailable | `message_expired` is emitted to the sender; the frame is not treated as new work later | 2b |
| T26 Budget exhaustion | A sub-allocation reaches zero during a task | In-flight reservation settles; new protected spend refuses with `budget_exhausted`; the other sub-allocation is untouched | 2b |
| T27 Version coverage | Candidate evaluated on harness version X; host runs version Y | Acceptance refused with `eval_coverage_missing`; the uncovered cell is shown to the owner | 3 |
| T28 Partial cell failure | Candidate passes on the lead's harness and fails on the specialist's | Whole candidate rejected; a narrowed per-adapter candidate is re-evaluated before any acceptance | 3 |
| T29 Dream limits | A dream run exceeds its wall-clock limit or maintenance sub-allocation | Run terminated with `dream_limit_exceeded`; partial outputs retained; no candidate emitted | 3 |
| T30 Source chain | A proposal derived from external-untrusted content passes every cell | Acceptance refused until the owner approves the source chain; the approval record names it | 3 |

Tests not tied to a single requirement cover delivery and task semantics
that several requirements share: T05, T06, T07, T08, T09, T17, T18, T23.

## Compatibility baseline

The compatibility inventory that 0.4 Appendix E asks WP1 to produce is
`docs/daemon-plugin-split.md` **Appendix A** (module inventory and
dependency map, generated at the pinned commits), plus §2.3 (duplicated
wire code) and §2.4 (cycles). It is referenced here, not duplicated: the
plan document is the baseline's home, and this PR pins it at commit
`6480b35`.
