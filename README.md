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

- BreadBoard: `0.1.0-rc.4`
- OMP: `18.0.1`
- `@breadboard/sdk`: `0.4.0`
- SDK engine API range: `>=0.4.0 <0.5.0`

## Build

Prerequisites: Bun `>=1.3.14` (the repository package manager and primary CI lane use Bun 1.4), the platform's OMP native addon, and a checkout of the exact backend commit recorded in `packages/coding-agent/breadboard-sdk-provenance.json`.

```sh
bun install --frozen-lockfile
bun packages/coding-agent/scripts/build-engine-distribution.ts \
  --backend-root /path/to/pinned/breadboard \
  --output-root /path/to/private/engine-distribution \
  --product-version 18.0.1
BREADBOARD_P30_BACKEND_ROOT=/path/to/pinned/breadboard \
  BREADBOARD_ENGINE_DISTRIBUTION_ROOT=/path/to/private/engine-distribution \
  bun run --cwd packages/coding-agent build:bb
./packages/coding-agent/dist/bb --version
./packages/coding-agent/dist/bb --smoke-test
```

The SDK provenance gate fails closed when the backend checkout, generated contract, or vendored artifact differs from the recorded identity.

The engine distribution builder requires its pinned Bun `1.3.14`, Python and uv toolchain. It builds the engine from the clean backend commit rather than importing that checkout at runtime.

## Recorded-run comparison

The downstream `bb` product compares recorded Sessions through the installed engine:

```sh
bb research compare --definition EXPERIMENT.json --world WORLD.json --generation GENERATION.json --projection PROJECTION.json --compare E.json,E_PRIME.json
```

Run from the workspace containing those inputs. The result envelope returns `data.run_id` and `data.report_id`. Repeating identical inputs resumes the admitted snapshot and returns the same completed identities, even if referenced source recordings later advance. Engine-declared failures preserve their semantic exit and error codes.

Worlds are `local`, `container`, `ray`, and `slurm`. Declare `field_mask` as exactly `["/occurred_at", "/timestamp"]` before running. Container workspace paths must be visible to the container daemon; a remote Docker VM does not necessarily share the host's temporary directory.

The [installed acceptance journey](./packages/coding-agent/test/breadboard/research-compare-journey.py) exercises controller replacement, replay, request bytes, compaction, annotations, and child settlement. The [failure journey](./packages/coding-agent/test/breadboard/research-compare-failure-journey.py) exercises forged reports and lost child results. Both provide `--help` and require a freshly built `bb`; source checkout access is limited to fixture creation and owner inspection.

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

OMP's original README is preserved at [`README.omp-upstream.md`](README.omp-upstream.md). Upstream package names, source links, license, and attribution remain intact so upstream lineage stays reviewable and mergeable.
