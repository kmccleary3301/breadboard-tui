# BreadBoard TUI

BreadBoard's primary terminal interface, maintained as a productized downstream of [Oh My Pi](https://github.com/can1357/oh-my-pi).

This repository is the canonical source and release authority for the BreadBoard TUI. It retains OMP's Git ancestry so stable upstream releases can be merged normally. The separate [`kmccleary3301/oh-my-pi`](https://github.com/kmccleary3301/oh-my-pi) fork is contribution staging only; it is not a BreadBoard release source.

## Product contract

| Surface | Authority |
|---|---|
| TUI source and `bb` binary | This repository |
| Engine and canonical SDK source | [`kmccleary3301/breadboard`](https://github.com/kmccleary3301/breadboard) |
| Upstream TUI spine | [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) |

The engine seam is the pinned `@breadboard/sdk` package. Direct imports from the BreadBoard engine repository and runtime filesystem coupling are prohibited. `packages/coding-agent/breadboard-sdk-provenance.json` records the SDK artifact hash, backend commit and tree, and compatible contract identity.

Current product identity:

- BreadBoard: `0.1.0-rc.1`
- OMP: `18.0.0`
- `@breadboard/sdk`: `0.3.0`
- engine interface: `>=0.1.0 <0.4.0`

## Build

Prerequisites: Bun `1.3.14`, the platform's OMP native addon, and a checkout of the exact backend commit recorded in `packages/coding-agent/breadboard-sdk-provenance.json`.

```sh
bun install --frozen-lockfile
BREADBOARD_P30_BACKEND_ROOT=/path/to/pinned/breadboard \
  bun run --cwd packages/coding-agent build:bb
./packages/coding-agent/dist/bb --version
./packages/coding-agent/dist/bb --smoke-test
```

The SDK provenance gate fails closed when the backend checkout, generated contract, or vendored artifact differs from the recorded identity.

## Verification

```sh
bun run --cwd packages/coding-agent check:types
bun test packages/coding-agent/test/bbomp-core-52/bbomp-core-52.test.ts
BREADBOARD_P30_BACKEND_ROOT=/path/to/pinned/breadboard \
  bun scripts/audit-fork-delta.ts
```

The fork audit compares the product tree with the exact upstream tag and rejects undeclared paths, inline product logic in upstream-owned entrypoints, dependency drift, provenance drift, and delta-budget overruns.

## Upstream convergence

Each stable OMP train follows one reviewable sequence:

1. Fetch the exact upstream tag from `can1357/oh-my-pi`.
2. Verify tag commit and tree against `scripts/p31/upstream-sync-policy.json`.
3. Merge upstream into an `upstream-sync/<version>` branch without rewriting pinned history.
4. Reconcile BreadBoard-owned adapters and regenerate governed manifests.
5. Run the delta audit, BBOMP-CORE-52, full build, and compiled-binary smoke.
6. Promote through a pull request to protected `main`.

BreadBoard changes should remain concentrated in owned adapters, product entrypoints, packaging, tests, and governance controls. Changes generally useful to OMP should be replayed onto the clean contribution fork and proposed upstream.

## Upstream documentation and attribution

OMP's original README is preserved at [`docs/README.omp-upstream.md`](docs/README.omp-upstream.md). Upstream package names, source links, license, and attribution remain intact so upstream lineage stays reviewable and mergeable.
