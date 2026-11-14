# Interim HQ source artifact (proposal)

This is a limited, Linux-only operator-managed HQ source artifact. It is supported only on Linux for both building and running. It does not create the
Stage 3 bundled release, an updater, a service unit, or an automatic rollout.
Do not publish or deploy until the owner approves the exact artifact and target
inventory. The release operator owns the build and publication record; the
deployment operator owns client inventory, installation, monitoring and rollback.

## Build and verify

1. Merge and review the packaging implementation. Select its exact full HQ
   commit; the key-only base is e1c6fcae513f3b1220f5c6b013df5ba89272f958,
   which does not contain this builder. Verify the source commit and clean tree.
2. Obtain the public soul-contracts tree at the release pin's exact commit and
   verify its tag and `sha256-manifest-v1` digest through the approved source
   channel. Record independent tag-to-commit provenance evidence as a mandatory
   release input; the builder verifies directory contents but cannot infer which
   Git commit or tag they came from. Provide its directory to the builder. Do
   not supply private keys.
3. On two independent Linux build environments with Node 20+, Git and GNU tar,
   run `node scripts/build-interim-release.mjs <full-hq-commit> <contracts-dir> <new-output.tar>`,
   with the contracts directory and new output path outside the clean checkout.
   Compare SHA-256 of the two archives. Record source commit, contracts commit,
   contracts digest, artifact SHA-256, builder/tool versions and both results.
   A mismatch blocks publication. Obtain the owner's approval of those bytes.
4. Verify the artifact digest against the approved record before extracting on
   each host. Reject paths escaping the target and unexpected symlinks. Extract
   under a new versioned directory writable only by the deployment operator;
   use a path whose ancestors contain no symlinks. The verifier refuses symlinked
   paths. State, signer and enrollment remain outside the artifact. Retain the prior
   release and state backup under their existing access controls.
5. With networking unavailable, start the artifact entrypoint `node hq/main.mjs
   run` using an isolated HQ home and the legacy enrollment setting; verify
   status. Alter, remove and add a contracts file in disposable copies and
   verify each startup refuses. Test the exact archive, not a working tree.

## Distribution and activation

The deployment operator records an inventory of all intended enrolled HQ
clients, current artifact and pin, owner, online status and update confirmation.
Install and verify the approved digest on each target while the existing signer
and legacy path remain in use. Do not switch the service signer until all
targeted clients have the required release or an owner has explicitly resolved
each exception. Offline clients cannot be counted as updated without evidence.

The current accepted window is [2026-11-17T00:00:00Z,
2027-02-15T00:00:00Z). There is no confirmed deployment schedule. If the start
is missed, obtain acceptance of recalculated dates and update both manifests
before activating. Within the accepted window, deploy the matching server public
metadata with the verified signer; wait at least 300 seconds for the endpoint
cache. On a designated enrolled test client, record signed token-grant and
daemon API success, authenticated refusal, client artifact/pin and observed
time without recording token, assertion, private key or response secrets.

If checks fail, disable the HQ opt-in, restore the prior server metadata with
the unchanged uncompromised signer and switch the host back to the retained
verified release. Verify health and record the outcome after cache expiry.
Do not extend expiration silently or re-enable a suspected compromised key;
old offline HQ pins cannot be remotely revoked by publishing retired metadata.
Issue #122 remains open until release, coverage, success, refusal and rollback
evidence is recorded.
