# BreadBoard TUI

BreadBoard's primary terminal interface, maintained as a productized downstream of [Oh My Pi](https://github.com/can1357/oh-my-pi).

This repository is the canonical source and release authority for the BreadBoard TUI. It retains OMP's Git ancestry so stable upstream releases can be merged normally. The separate [`kmccleary3301/oh-my-pi`](https://github.com/kmccleary3301/oh-my-pi) fork is contribution staging only; it is not a BreadBoard release source.

## Product contract

| Surface | Authority |
|---|---|
| TUI source and `bb` binary | This repository |
| Engine and canonical SDK source | [`kmccleary3301/breadboard`](https://github.com/kmccleary3301/breadboard) |
| Upstream TUI spine | [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) |
The product runs directly on the native TypeScript turn loop and native harness package (`@breadboard/harness`). The Python engine bridge, SDK client, and attach modes have been retired.

Current product identity:

- BreadBoard: `0.1.0-rc.7`
- OMP: `18.3.0`

## Daily-driver engine

The product defaults to the native `bb-omp.native` harness. An explicit harness spec can be selected via `--harness <path.yaml>`, `breadboard.sessionConfigPath`, or `breadboard.harness.default`.

Legacy engine bridge modes (`local-owned`, `local-external`, `remote`) and flags (`--engine-mode`, `--engine-url`) have been removed. Any attempt to request an engine bridge via CLI, environment (`BREADBOARD_ENGINE_MODE`, `BREADBOARD_API_URL`, `BREADBOARD_ENGINE_ARTIFACT`), or profile settings will refuse to launch with an explicit error naming the native default (`native`). The only supported engine modes are `native` and `off`.
Generate the candidate launcher with a per-workspace native profile root. The launcher copies the
matching R39 profile into that root, runs the one-shot product migration, and records a source
checksum marker; it never mutates the R39 root:

```sh
bun packages/breadboard-harness/scripts/native-daily-driver-launcher.ts \
  /path/to/installed/bb \
  /path/to/native-profile-root \
  /path/to/r39/user/projects \
  ~/.omp/agent \
  /tmp/bb-omp.candidate \
  /path/to/r39/launch
```

Rollback by installing the retained R39 launcher byte-for-byte:

```sh
install -m 755 /path/to/r39/launch ~/.local/bin/bb-omp
```

## Build

Prerequisites: Bun `1.4.0` (the repository package manager and primary CI lane use Bun 1.4), the platform's OMP native addon, and a checkout of the exact backend commit recorded in `packages/coding-agent/breadboard-sdk-provenance.json`.

```sh
bun install --frozen-lockfile
bun packages/coding-agent/scripts/build-engine-distribution.ts \
  --backend-root /path/to/pinned/breadboard \
  --output-root /path/to/private/engine-distribution \
  --product-version 0.1.0-rc.7
BREADBOARD_P30_BACKEND_ROOT=/path/to/pinned/breadboard \
  BREADBOARD_ENGINE_DISTRIBUTION_ROOT=/path/to/private/engine-distribution \
  bun run --cwd packages/coding-agent build:bb
./packages/coding-agent/dist/bb --version
./packages/coding-agent/dist/bb --smoke-test
```

The SDK provenance gate fails closed when the backend checkout, generated contract, or vendored artifact differs from the recorded identity.

The engine distribution builder requires its pinned Bun `1.3.14`, Python and uv toolchain. It builds the engine from the clean backend commit rather than importing that checkout at runtime.

## Supported product target

| Archive tuple | Baseline | Status |
|---|---|---|
| `darwin-arm64` | macOS 14+ | Supported |

Windows x64 ([#94](https://github.com/kmccleary3301/breadboard/issues/94)), Intel macOS ([#95](https://github.com/kmccleary3301/breadboard/issues/95)), Linux arm64 ([#96](https://github.com/kmccleary3301/breadboard/issues/96)), and Linux musl ([#97](https://github.com/kmccleary3301/breadboard/issues/97)) are deferred. No release claim covers those targets.

For local human QC, build a clearly classified unsigned development artifact:

```sh
BB_DEVELOPMENT_EVIDENCE=1 \
  BB_BINARY_PATH="$PWD/packages/coding-agent/dist/bb" \
  BB_NATIVE_ADDON_PATH="$PWD/packages/natives/native/pi_natives.darwin-arm64.node" \
  BB_LICENSE_PATH="$PWD/LICENSE" \
  BB_NOTICES_PATH="$PWD/packages/coding-agent/THIRD_PARTY_NOTICES.txt" \
  BB_ENGINE_DISTRIBUTION_ROOT=/path/to/private/engine-distribution \
  BB_PRODUCT_VERSION=0.1.0-rc.7 \
  BB_RELEASE_OUTPUT_ROOT=/private/release-output \
  bun run bb:release
bun run bb:install install /private/release-output/bb-darwin-arm64-0.1.0-rc.7.tar.gz /private/bb-install --allow-unsigned-development
```

Unsigned development evidence is rejected unless `--allow-unsigned-development` is explicit. A release-candidate archive instead requires an independently distributed archive digest via `--expected-archive-sha256 sha256:<digest>` until publisher-signature verification is available. The same trust flags apply to `update`.

Managed `install`, `update`, `rollback`, `uninstall`, and `status` actions verify the archive before changing a private destination and retain authenticated predecessor revisions for rollback. Release-candidate installation also requires legal inputs, an engine release-envelope declaration, and the independently supplied whole-archive digest.

## Persistent code evaluation

Harnesses that expose `eval` provide separate, engine-owned IPython and JavaScript kernels in process-backed coding sessions. `eval(language="py"|"js", code=...)` supports top-level `await` and retains variables across calls and turns. The installed engine bundles both runtimes; host Python and Bun installations are not required.

`reset=true` resets only the selected language. Ordinary code exceptions retain its namespace; timeout, cancellation, or worker failure discards it and reports the state loss. The default timeout is 30 seconds; `timeout=0` disables the deadline, not cancellation. Kernels end with the live session; reopening a transcript does not restore in-memory objects.

Evaluation uses the shell approval policy and the same workspace and process-sandbox restrictions as shell commands. Saved approvals distinguish language, code, timeout, and reset. Docker-backed sandboxes explicitly reject eval rather than executing it on the host. Native OMP's `tool`, `agent`, and `workpool` prelude is not available.

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

The current baseline is the upstream release `v18.2.11` (`e4151593ace2781d1dc2f06d760301f88af3e9dc`).

Each stable OMP train follows one reviewable sequence:

1. Fetch the exact upstream tag from `can1357/oh-my-pi`.
2. Verify tag commit and tree against `scripts/p31/upstream-sync-policy.json`.
3. Merge upstream into an `upstream-sync/<version>` branch without rewriting pinned history.
4. Reconcile BreadBoard-owned adapters and regenerate governed manifests.
5. Run the delta audit, BBOMP-CORE-52, full build, and compiled-binary smoke.
6. Promote through a pull request to protected `main`.

`bun scripts/verify-upstream-sync.ts` verifies the exact candidate in a disposable worktree when the pinned upstream is already an ancestor. Otherwise it attempts a disposable rebase. Both routes run the same classification and proof commands; neither rewrites the source branch. Its receipt distinguishes existing ancestry from an attempted rebase.

BreadBoard changes should remain concentrated in owned adapters, product entrypoints, packaging, tests, and governance controls. Changes generally useful to OMP should be replayed onto the clean contribution fork and proposed upstream.

## Upstream documentation and attribution

OMP's original README is preserved at [`README.omp-upstream.md`](README.omp-upstream.md). Upstream package names, source links, license, and attribution remain intact so upstream lineage stays reviewable and mergeable.
