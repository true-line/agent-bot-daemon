# agent-bot-daemon

The host process for agent-bot. It owns the link to the agent-bot server and
runs the identity, comms and soul-runtime plugins.

Status: stage 0 under the planning umbrella
([#1](https://github.com/true-line/agent-bot-daemon/issues/1)). Start at
[docs/daemon-plugin-split.md](docs/daemon-plugin-split.md) §9.

## Contracts

The WP1 contracts live in
[true-line/soul-contracts](https://github.com/true-line/soul-contracts)
(decision D5). This repository keeps no copy: `governance/soul-contracts.json`
pins one release by tag, commit and content digest, and
`node scripts/soul-contracts.mjs` fetches it into `.cache/` and refuses a
moved tag or a changed digest. `npm test` runs that check (Node 20 or later,
no dependencies). To move to a newer release, run
`node scripts/soul-contracts.mjs pin vX.Y.Z`; pins never move backwards.
