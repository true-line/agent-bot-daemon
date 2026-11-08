// A reference broker plugin for HQ's tests (plan §4.9). agent-comms ships
// the real one (§9 row 13b); this one does only what the host side needs
// exercised: bind a connection to a runtime through hq-admission, refuse
// anything before or after that, and deliver each later frame with the
// bound runtime.
import { fail } from '../sdk/errors.mjs';
import { definePlugin } from '../sdk/plugin.mjs';

// `beforeBind` lets a test hold a bind in flight.
export function referenceBroker({ name = 'test-broker', beforeBind } = {}) {
  return definePlugin({
    name,
    version: '0.1.0',
    hostApi: 1,
    requires: { 'hq-admission': '^0.1.0' },
    async init(ctx) {
      const admission = ctx.deps['hq-admission'];
      const bound = new Map(); // connection → runtime ID
      ctx.broker.serve({
        async accept(kind, message, { connection }) {
          if (kind === 'bind') {
            if (bound.has(connection)) fail('host.invalid_request', 'this connection is already bound');
            if (beforeBind) await beforeBind();
            const b = await admission.verifyBinding(message);
            bound.set(connection, b.runtime_id);
            return { runtime_id: b.runtime_id, member_id: b.member_id, role: b.role };
          }
          const runtimeId = bound.get(connection);
          if (!runtimeId) fail('caller_mismatch', 'a member binds its connection before anything else');
          return ctx.broker.deliver(kind, message, { runtime_id: runtimeId });
        },
        closed(connection) { bound.delete(connection); },
      });
      return { provides: { boundConnections: () => bound.size } };
    },
  });
}
