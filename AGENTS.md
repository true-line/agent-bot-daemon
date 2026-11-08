# AGENTS.md

agent-bot-daemon is HQ for the Soul Agent Platform: the one local authority
that admits Souls, enforces grants and hosts the broker. This file is the map
for agents working here; harness instruction files live in the user directory,
not in this repository (ENG-0384).

<!-- platform:agent-bot-platform:start -->
Platform: true-line/agent-bot-platform, read at main.
This repository's charter, seams and requirements are in the platform's
registry/repos.yaml entry for agent-bot-daemon. Read the platform's AGENTS.md
at the start of every task, and before changing a seam or anything a
requirement covers.
<!-- platform:agent-bot-platform:end -->

<!-- governed:shared-agent-discovery:start -->
Shared agent conventions, skills, SOPs and org-wide decisions are discovered from [qwts/qwts-agent-sop](https://github.com/qwts/qwts-agent-sop): start at the [agent conventions](https://github.com/qwts/qwts-agent-sop/blob/main/docs/reference/agent-conventions.md), then the [SOP index](https://github.com/qwts/qwts-agent-sop/blob/main/docs/sop/README.md) and the [ENG decisions index](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/README.md). Inherit by default and vary by explicit delta (ENG-0008). Resolve the current approved SOP head once per operation and record the commit you read.
<!-- governed:shared-agent-discovery:end -->

## Where things live

| What | Where |
| --- | --- |
| Requirements, tests, architecture, trust domains, repository charters, seams, cross-repository decisions, glossary | The platform, read at `main`. Link to it; never copy it here. |
| Schemas, fixtures and error codes | true-line/soul-contracts, pinned by digest in `governance/soul-contracts.json` (D5). No copies here. |
| HQ's implementation plan: the plugin contract (the `hq-plugin-contract` seam), the owner interface, the migration stages, the module inventory | [docs/daemon-plugin-split.md](docs/daemon-plugin-split.md) |
| This repository's decisions (D1–D7) | §10.1 of the plan, and this repository's [Decisions discussions](https://github.com/true-line/agent-bot-daemon/discussions/categories/decisions) |
| Test coverage this repository owes | [docs/test-matrix.md](docs/test-matrix.md) |

## Rules

- **The platform wins.** Where this repository's docs disagree with the platform, follow the platform and record the conflict in its [drift register](https://github.com/true-line/agent-bot-platform/blob/main/docs/00-governance/drift-register.md). Proposed platform pages guide work; only Accepted ones bind it.
- **Cross-repository decisions go to the platform.** A decision that binds another repository, changes a seam, or changes a requirement or the trust model is raised in the platform's [Decisions](https://github.com/true-line/agent-bot-platform/discussions/categories/decisions) category, not here.
- **Track work where it happens.** An issue here covers work in this repository. Work in another repository is tracked in that repository.
- **No schema edits to make code pass.** A contract change goes through soul-contracts first.
- **Labels.** Cite platform IDs as the platform declares them. This repository's own decisions are D1–D7 (the platform cites them as "agent-bot-daemon D4"); its risks are `HQ-RISK-NN`.
- **No personal names.** Write "the owner" or "True Line AI LLC".

## Validate before push

```sh
npm test
```

Node 20 or later, no dependencies. It verifies the soul-contracts pin, which fetches the pinned release from GitHub into `.cache/`.
