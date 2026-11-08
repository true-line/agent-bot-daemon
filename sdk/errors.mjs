// Errors the SDK raises.
//
// Two kinds of code, never mixed:
// - Registry codes (snake_case, e.g. `credential_unavailable`) come from the
//   pinned soul-contracts errors/registry.json and may cross the wire. A test
//   checks every one used here exists in the pinned registry.
// - Host codes (`host.<name>`) are refusals inside HQ that have no registry
//   code. They never appear in a contract record or a common/v1 error
//   response; a contract that needs one adds a registry code in
//   soul-contracts first. HQ's local sockets carry them in a separate
//   `host_refusal` field (hq/socket.mjs) until soul-contracts specifies the
//   hq/v1 request envelope.

export class HostError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  get retryable() {
    return RETRYABLE.has(this.code);
  }
}

// Registry codes the SDK and HQ raise, with the registry's `retryable` flag.
export const REGISTRY_CODES = Object.freeze({
  unsupported_version: false,
  required_capability_missing: false,
  caller_mismatch: false,
  stale_epoch: false,
  lease_expired: true,
  definition_not_accepted: false,
  approval_mismatch: false,
  budget_exhausted: false,
  credential_unavailable: true,
  device_revoked: false,
  profile_insufficient: false,
  revision_conflict: true,
  write_scope_conflict: false,
});

const RETRYABLE = new Set(Object.entries(REGISTRY_CODES).filter(([, r]) => r).map(([c]) => c));

// Host codes: refusals inside HQ with no registry code.
export const HOST_CODES = Object.freeze([
  'host.invalid_manifest',
  'host.duplicate_plugin',
  'host.duplicate_registration',
  'host.registration_closed',
  'host.unknown_operation',
  'host.unknown_kind',
  'host.no_broker',
  'host.auth_mismatch',
  'host.undeclared_service',
  'host.route_not_allowed',
  'host.init_write_forbidden',
  'host.init_network_forbidden',
  'host.not_running',
  'host.safe_mode',
  'host.admissions_closed',
  'host.plugin_degraded',
  'host.timeout',
  'host.invalid_json',
  'host.invalid_request',
  'host.secret_in_env',
  'host.context_revoked',
  'host.internal',
]);

export const fail = (code, message, details) => {
  if (!(code in REGISTRY_CODES) && !HOST_CODES.includes(code)) throw new Error(`unregistered error code ${code}`);
  throw new HostError(code, message, details);
};
