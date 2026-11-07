# Contracts

The WP1 contract baseline (stage 0, PR 1): versioned schemas, fixtures, and
the canonicalization and vendor-neutrality rules that later components pin
against. Charter: `docs/daemon-plugin-split.md` §9 row 1 (issue #58).

## Normative sources (pinned)

| Source | Pin |
| --- | --- |
| *Soul Agent Platform*, whitepaper draft 0.4, Chris Kane, 2026-10-27 — Appendix A (records), §2 (R1–R12), §14 (T01–T30), Appendix D (traceability), "Minimum error codes" | DOCX SHA-256 `6e8b85af5aea5454314b7563fef83d50b5582f2b6bd9bd2a8a9bd64cdedd3030` |
| *Native Shareable Soul Packages*, draft 0.3 ([S4]) | Zenodo DOI 10.5281/zenodo.23547566 |
| Module inventory used as the compatibility baseline | `docs/daemon-plugin-split.md` Appendix A at commit `6480b35` |

The whitepaper itself is **not** committed to this repository; the hash above
is the pin. Where this baseline curates the whitepaper (see "Curation
notes"), the curation is recorded here and the whitepaper wins on conflict
until a decision record says otherwise.

## Layout

```
contracts/
  schemas/
    hq-v1/      control-socket records (Hello, admission result, Equip,
                ready/lease, lifecycle request, approval record)
    broker/     wire frame, directive/query, grant, task record,
                task commitment request
    records/    typed note, action record, credential issuance record,
                transfer record, dream grant record, eval plan record,
                candidate revision record
  fixtures/     one positive vector file per record (<record>-v1.json), a
                companion negatives file (<record>-v1-negatives.json)
                cross-pinned by SHA-256, and canonicalization-v1.json
governance/
  error-codes.json   the 0.4 minimum error codes (add-only; enforced by test)
docs/
  glossary.md        the 0.4 §3 vocabulary
  traceability.md    R1–R12 → tests (0.4 Appendix D) and T01–T30 (§14)
```

All schemas are JSON Schema **draft 2020-12**. The test suite validates the
fixtures against them with a dependency-free validator that supports the
subset listed below; nothing outside the subset may be used without
extending `tests/support/validator.mjs` and this list:

`type`, `properties`, `required`, `additionalProperties: false`,
`minProperties`, `enum`, `const`, `items`, `uniqueItems`,
`minItems`/`maxItems`, `minLength`/`maxLength`, `pattern`, `minimum`/
`maximum`, `format: date-time`, and conditionals (`if`/`then`) in
`directive-query.schema.json` (T04) and `task-record.schema.json`
(waiting implies a reason).

Negative fixtures carry the refusal class (`schema`, `parse`, `semantic`);
`semantic` vectors name their `rule` (`expiry-before-now`,
`capability-not-negotiated`), evaluated against the file's `semantic_now`
and, for capabilities, its `negotiated_capabilities`. `parse` vectors carry
the raw text as `data_raw` (duplicate JSON keys).

## Identifier and field conventions

- Opaque identifiers: `^[a-z0-9][a-z0-9_.:-]{0,127}$` (Appendix A's
  illustrative IDs all fit). Grant handles are broker-generated and opaque:
  `^[A-Za-z0-9_-]{16,128}$` — never user-chosen (0.4 Appendix A).
- SHA-256 digests are lowercase hex: `^[0-9a-f]{64}$`.
- Timestamps are RFC 3339 date-time strings.
- Installation epochs and task revisions are non-negative integers.
- Enforcement profiles are enumerated `managed-protected`,
  `managed-cooperative`, `standalone-unenforced` (0.4 §4).
- Provenance values are enumerated `owner`, `hq`, `member`, `peer`,
  `external-untrusted` (0.4 §4).
- Error codes are snake_case, exactly as 0.4 lists them; the registry is
  `governance/error-codes.json`.

## Fixtures

- A positive vector carries `id`, `expected: "valid"`, the `data`, and
  `canonical_sha256` — the SHA-256 of the vector's data in canonical form
  (JCS, RFC 8785; see below).
- The companion negatives file pins the exact bytes of its positives file
  (`base.sha256`), so a positives edit cannot land without revisiting the
  negatives (the `qwts/agent-bot-identity` convention).
- A negative vector carries `id`, `expected` (the contract error code the
  refusing layer must emit), `refusal` naming the layer that must refuse —
  `schema` (the JSON Schema rejects the shape), `parse` (the input is not
  acceptable JSON, e.g. duplicate keys), or `semantic` (schema-valid but
  contract-forbidden, e.g. a stale expiry) — a `note`, and the `data`.
- The test suite asserts: every positive validates; every
  `refusal: "schema"` negative is rejected; every `refusal: "parse"`
  negative fails strict JSON parsing; every `refusal: "semantic"` negative
  passes the schema and is refused by the named rule implemented in the
  test; and every pinned digest matches a recomputation.

## Canonicalization

Signed structures use JCS (RFC 8785) as 0.4 §6 proposes. This baseline
canonicalizes by recursively sorting object keys and emitting compact UTF-8
JSON with ECMAScript number serialization — which is JCS for the values
these records carry (no `-0`, no non-finite numbers, no lone surrogates;
`tests/canonicalization.test.mjs` anchors the transform against vectors
derived from RFC 8785). Full JCS conformance (big-number edges, literal
control-character edge cases) is a follow-up before anything is signed on
the wire.

## Curation notes (deviations from the whitepaper's illustrative text)

- The illustrative task commitment request uses `"transition": "complete"`;
  the schema enumerates the §7 state-machine target states instead
  (`completed`, `failed`, `canceled`, …), so fixtures use `"completed"`.
- Enforcement-profile and provenance names are kebab/snake encoded here;
  the whitepaper uses prose ("Managed protected", "external-untrusted").
- Error-code `retryable` and `raised_by` values in
  `governance/error-codes.json` are WP1 proposals: 0.4 names the codes but
  not these attributes (except where §6/§9 state behavior, e.g.
  `credential_unavailable` is retried when the service returns).

## Handoff

The repository implementation plan in the supplied soul-docs names
`true-line/soul-contracts` as a future dedicated home for WP1 contracts.
These artifacts are laid out (schemas / fixtures / registry / glossary /
traceability) so they can be extracted there without rewriting; until then
this repository owns them, and `governance/plugins.json` pinning (PR 7)
will digest-pin this tree.

## Running the tests

```sh
npm test        # node --test tests/*.mjs; zero npm dependencies
```
