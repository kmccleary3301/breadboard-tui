# A-CI / A-B evidence report

Branch: `bb-omp-convergence/v17.4.0-aci`  
Pinned source: `d3dbb216b24b81266dc1442437b4db2eb7679144`  
Pinned upstream audit ref: `72000acfeb` (v17.4.0)

## A-CI1 — BBOMP-CORE-52

Suite: `packages/coding-agent/test/bbomp-core-52/bbomp-core-52.test.ts`

The suite contains exactly **52 passing contracts**, with no skips:

| Area | Contracts | Result |
| --- | ---: | --- |
| SDK event envelope, decoding, ordering, cursor | 12 | 12 pass |
| Session create/resume/reconnect/cancel/replay | 12 | 12 pass |
| Tool result, terminal outcome, exact-once visibility | 8 | 8 pass |
| Process exit, signal, cleanup, terminal restoration | 8 | 8 pass |
| Package identity, SDK provenance, version, compatibility | 6 | 6 pass |
| Credential/redaction invariants | 4 | 4 pass |
| Launcher/config namespace isolation | 2 | 2 pass |
| **Total** | **52** | **52 pass, 0 fail, 0 skip** |

Full command and result:

```text
$ bun test packages/coding-agent/test/bbomp-core-52/bbomp-core-52.test.ts
52 pass
0 fail
Ran 52 tests across 1 file.
```

Fast PR subset is selected by the `[fast]` test-name tag:

```text
$ bun test packages/coding-agent/test/bbomp-core-52/bbomp-core-52.test.ts --test-name-pattern '\\[fast\\]'
28 pass
24 filtered out
0 fail
Ran 28 tests across 1 file.
```

## A-CI2 — fork delta audit

- Script: `scripts/audit-fork-delta.ts`
- Manifest: `scripts/fork-layer-manifest.json`
- Workflow: `.github/workflows/fork-delta-audit.yml`
- The manifest was seeded from the **73** paths returned by `git diff --name-only 72000acfeb HEAD`; seven ACI/evidence control paths are also declared so the audit is green in this worktree.

Green proof after cleanup:

```text
$ bun scripts/audit-fork-delta.ts
{"upstreamRef":"72000acfeb","changedCount":80,"declaredCount":80,"missing":[]}
```

Synthetic unauthorized-path red proof (`unauthorized-fork-delta.ts` was created and removed after the run):

```text
$ touch unauthorized-fork-delta.ts; bun scripts/audit-fork-delta.ts
{"upstreamRef":"72000acfeb","changedCount":80,"declaredCount":79,"missing":["unauthorized-fork-delta.ts"]}
Fork delta audit failed: 1 path(s) are not declared
```

## A-B1 — local unsigned single-file binary

The fork's existing compile entrypoint is `packages/coding-agent/scripts/build-binary.ts`, invoked by the package `build` script (which uses Bun's `compile` build). The local arm64 artifact is `packages/coding-agent/dist/bb`.

Provenance and checksum: `aci_binary_provenance.json`

```text
source commit: d3dbb216b24b81266dc1442437b4db2eb7679144
source tree:   a4af095931e3cb5afee2d8be62c00df7bd976799
artifact sha256: 461235004786018c56307d8b0e31766c26bdc617d059819b54b064827ef9433a
```

Build and smoke commands:

```text
BREADBOARD_P30_BACKEND_ROOT=/tmp/bb_p30_backend_pin bun --cwd=packages/coding-agent run build
packages/coding-agent/dist/bb --version   # omp/17.4.0
packages/coding-agent/dist/bb --help      # exit 0
packages/coding-agent/dist/bb --smoke-test # smoke-test: ok
```

The artifact has only Bun's local ad-hoc signature (no Developer ID identity and
no notarization); Darwin's loader requires this local signature for the smoke
run. Production Developer ID signing/notarization is covered by the deferred
runbook.

## A-B2 — signing/notarization

Runbook: `aci_signing_runbook.md`. It records Developer ID requirements,
hardened-runtime `codesign`, `notarytool` keychain-profile setup and submission,
Gatekeeper verification, and post-notarization smoke/checksum commands.
