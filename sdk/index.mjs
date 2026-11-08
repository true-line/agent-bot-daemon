// @agent-bot/sdk: the HQ plugin contract (plan §4) and the wire helpers
// every implementation shares. Zero dependencies outside node: built-ins.
export { HostError, REGISTRY_CODES, HOST_CODES } from './errors.mjs';
export { HOST_API, HOST_SERVICES, PLUGIN_NAME, definePlugin, validateManifest, staticManifest, supportedHostApis } from './plugin.mjs';
export { HQ_OPERATIONS, AUTH_CLASSES, SAFE_MODE_OPERATIONS, ADMISSION_OPERATIONS } from './operations.mjs';
export { parseVersion, isVersion, compareVersions, validRange, satisfies } from './semver.mjs';
export { createHost } from './host.mjs';
export { TOOL_FIELDS, COMMAND_FIELDS, SUBCOMMAND_FIELDS, TOOL_CLASSES, COMMAND_VISIBILITY, validateTool, validateCommand } from './declarations.mjs';
export { PROFILES, DEVICE_STATES, createCore, testClock, testRandom, fakeIdentityService, fakeSigner } from './services.mjs';
export { createTestHost } from './test-host.mjs';
export { checkPlugin } from './conformance.mjs';
export { canonicalize, canonicalBytes, canonicalDigest } from './wire/canonical-json.mjs';
export { parseStrict } from './wire/strict-json.mjs';
export { validate, checkSchemaSupported } from './wire/schema.mjs';
export { supportWindow, negotiateVersions, negotiateCapabilities, checkRequiredCapabilities } from './wire/versions.mjs';
