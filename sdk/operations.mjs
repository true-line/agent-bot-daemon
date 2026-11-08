// The hq/v1 operations a plugin may implement, and the auth class each one
// needs (plan §4.2, §7.3). HQ core owns dispatch and auth; plugins register
// handlers for parts of this table and nothing outside it. There is no remote
// RPC registration: no component outside the host can invoke a plugin (R2).

const ENTRY_POINT = ['Hello', 'Admit', 'Equip', 'Ready', 'Lease'];

const LIFECYCLE = ['start', 'stop', 'pause', 'resume', 'drain', 'sleep', 'move', 'fork', 'accept-revision', 'rollback-revision', 'retire'];

const OWNER_VIEWS = [
  'status',
  'grants.list', 'grants.create', 'grants.revoke',
  'approvals.list', 'approvals.decide',
  'destinations.list', 'destinations.approve',
  'budgets.get', 'budgets.set',
  'tasks.list', 'tasks.get', 'receipts.query', 'actions.unknown', 'actions.resolve',
  'souls.list', 'souls.get', 'candidates.list', 'candidates.get', 'evaluations.get',
  'device.status', 'device.enroll',
  'events.subscribe',
];

export const HQ_OPERATIONS = Object.freeze(Object.fromEntries([
  ...ENTRY_POINT.map((op) => [op, 'entry-point']),
  ...LIFECYCLE.map((op) => [op, 'owner']),
  ...OWNER_VIEWS.map((op) => [op, 'owner']),
]));

export const AUTH_CLASSES = Object.freeze(['owner', 'entry-point']);

// What still works in safe mode (unenrolled device, or the identity plugin
// failed): status, enrollment and the doctor checks, and no admission (§4.4).
export const SAFE_MODE_OPERATIONS = Object.freeze(['status', 'device.status', 'device.enroll']);

// Operations that admit or equip a Soul; refused until admissions open.
export const ADMISSION_OPERATIONS = Object.freeze(ENTRY_POINT);
