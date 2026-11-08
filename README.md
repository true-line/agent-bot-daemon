# agent-bot-daemon

HQ for the Soul Agent Platform: the one local authority that admits Souls,
enforces grants and hosts the broker. Its charter is the
[repository catalog entry](https://github.com/true-line/agent-bot-platform/blob/main/docs/03-architecture/repository-catalog.md#agent-bot-daemon)
in true-line/agent-bot-platform, the product source of truth. Agents start at
[AGENTS.md](AGENTS.md).

Status: stage 1 under the planning umbrella
([#1](https://github.com/true-line/agent-bot-daemon/issues/1)). Start at
[docs/daemon-plugin-split.md](docs/daemon-plugin-split.md) §9. The plugin
SDK is in [sdk/](sdk/README.md); the HQ skeleton, which runs beside the
existing daemon, is in [hq/](hq/README.md).

## Contracts

The WP1 contracts live in
[true-line/soul-contracts](https://github.com/true-line/soul-contracts)
(decision D5). This repository keeps no copy: `governance/soul-contracts.json`
pins one release by tag, commit and content digest, and
`node scripts/soul-contracts.mjs` fetches it into `.cache/` and refuses a
moved tag or a changed digest. `npm test` runs that check (Node 20 or later,
no dependencies). To move to a newer release, run
`node scripts/soul-contracts.mjs pin vX.Y.Z`; pins never move backwards.
