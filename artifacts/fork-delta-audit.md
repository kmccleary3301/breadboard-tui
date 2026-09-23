# Fork delta audit receipt

- Schema: `bb-omp.delta-audit.v1`
- Status: **fail**
- Changed paths: 548
- Renames: 2

## Upstream identity

- Tag: `v18.2.2`
- Commit: expected `60c9a115b2e8decc0f75825459362d14188a8bc0`, observed `60c9a115b2e8decc0f75825459362d14188a8bc0`
- Tree: expected `aaeba635247ec3e4b0775848b9603cab4a2c0d33`, observed `aaeba635247ec3e4b0775848b9603cab4a2c0d33`

## Checks

- adapters: fail
- budgets: fail
- distribution: pass
- manifest: fail
- monorepoDependencies: pass
- upstreamIdentity: pass
- upstreamInlineLogic: fail

## Paths

| Path | Class | Rule | Declared | Owner | Layer |
| --- | --- | --- | --- | --- | --- |
| .github/ISSUE_TEMPLATE/config.yml | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| .github/SECURITY.md | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| .github/actions/setup-product-backend/action.yml | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| .github/workflows/bazel-cache-warm.yml | upstream-owned | upstream-ordinary-omp | yes |  |  |
| .github/workflows/ci.yml | upstream-owned | upstream-ordinary-omp | yes |  |  |
| .github/workflows/fork-delta-audit.yml | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| CONTRIBUTING.md | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| Dockerfile | manual-review | manual-review-boundaries | yes | fork-release | 1 |
| README.md | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| README.omp-upstream.md | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| bun.lock | manual-review | manual-review-boundaries | yes | fork-release | 1 |
| crates/pi-edit/src/modes/sloppy/apply.rs | upstream-owned | upstream-ordinary-omp | yes |  |  |
| crates/pi-edit/tests/sloppy.rs | upstream-owned | upstream-ordinary-omp | yes |  |  |
| crates/pi-shell/BUILD.bazel | upstream-owned | upstream-ordinary-omp | yes |  |  |
| docs/cli-reference.md | manual-review | manual-review-unknown | no |  |  |
| docs/conformance/p30/bb-omp/harbor-license-provenance.v1.manifest.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| docs/conformance/p30/bb-omp/harbor-license-provenance.v1.tsv | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| docs/conformance/p30/bb-omp/session-port-live-journeys.v1.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| docs/conformance/p31/e4-canonical-tui-evidence.md | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| docs/environment-variables.md | manual-review | manual-review-boundaries | yes | fork-runtime | 3 |
| docs/extensions.md | manual-review | manual-review-boundaries | yes | fork-runtime | 3 |
| docs/settings.md | manual-review | manual-review-unknown | no |  |  |
| docs/system-prompt-customization.md | manual-review | manual-review-boundaries | yes | fork-runtime | 3 |
| docs/task-agent-discovery.md | manual-review | manual-review-boundaries | yes | fork-runtime | 3 |
| docs/theme.md | manual-review | manual-review-unknown | no |  |  |
| docs/tools/eval.md | manual-review | manual-review-boundaries | yes | fork-runtime | 3 |
| docs/tools/task.md | manual-review | manual-review-boundaries | yes | fork-runtime | 3 |
| docs_tmp/bb_direction_assessment/evidence/ACI/aci_ab_report.md | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| docs_tmp/bb_direction_assessment/evidence/ACI/aci_binary_provenance.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| docs_tmp/bb_direction_assessment/evidence/ACI/aci_signing_runbook.md | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| package.json | manual-review | manual-review-boundaries | yes | fork-release | 1 |
| packages/agent/src/agent.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/agent/src/types.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/agent/test/agent.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/ai/src/auth-gateway/server.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/ai/test/auth-gateway-effort.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/breadboard-harness/README.md | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/engine-data/snapshot.json | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/package.json | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/scripts/snapshot-engine-data.ts | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/src/canonical-json.ts | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/src/compiler/index.ts | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/src/index.ts | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/src/native/adapters.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/index.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/load-native-harness.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/lock-loader.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/lock-values.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/omp-extension.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/prompt-assembly.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/shell-eval-results.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/text-calls.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/todo-write.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/tool-pack.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/turn-policy.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/src/native/types.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/canonical-json.test.ts | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/test/compiler/compiler.test.ts | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/test/native/adapters.test.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/apply_unified_patch__add-dev-null.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/apply_unified_patch__context-mismatch.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/apply_unified_patch__delete.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/apply_unified_patch__modify.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/apply_unified_patch__multi-hunk.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/apply_unified_patch__path-escape.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/create_file_from_block__create-nested.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/create_file_from_block__legacy-file-name.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/create_file_from_block__overwrite.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/create_file_from_block__path-escape.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/list_dir__depth-bound.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/list_dir__depth-one-hidden-order.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/list_dir__depth-two.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/list_dir__missing.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/list_dir__path-escape.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/r39-openai/compiled_system.md | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/r39-openai/framed_hello.txt | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/r39-openai/per_turn/turn_1.md | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/r39-openai/tools-provided.turn_1.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/r39-workspace/.breadboard/bb-omp/r39/.bb-omp.harness.lock.json.meta.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/r39-workspace/.breadboard/bb-omp/r39/bb-omp.harness.lock.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/r39-workspace/.breadboard/bb-omp/r39/bb-omp.harness.yaml | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/r39-workspace/.breadboard/bb-omp/r39/prompts/daily_driver_system.md | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/read_file__bounds.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/read_file__directory.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/read_file__missing.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/read_file__normal.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/read_file__offset-limit.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/read_file__path-escape.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/eval__oracle-actual-wrapper-turn-16.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/eval__oracle-actual-wrapper-turn-8.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/eval__oracle-bb-kernels-final-turn-16.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/eval__oracle-bb-kernels-final-turn-24.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/eval__oracle-bb-kernels-final-turn-8.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/eval__oracle-bb-kernels-turn-24.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/eval__oracle-bb-kernels-turn-8.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/run_shell__oracle-bb-kernels-turn-16.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/shell-eval/run_shell__timeout-captured.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/text-calls/format.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/text-calls/parser.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/todo-write/guard.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/fixtures/todo-write/manager.json | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/load-native-harness.test.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/prompt-assembly.test.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/shell-eval-results.test.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/text-calls.test.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/todo-write.test.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/tool-pack.test.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/native/turn-policy.test.ts | breadboard-owned | breadboard-harness-package | no |  |  |
| packages/breadboard-harness/test/snapshot.test.ts | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/breadboard-harness/tsconfig.json | breadboard-owned | breadboard-harness-package | yes |  |  |
| packages/coding-agent/CHANGELOG.md | manual-review | manual-review-boundaries | yes | fork-runtime | 3 |
| packages/coding-agent/DEVELOPMENT.md | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/THIRD_PARTY_NOTICES.manifest.json | generated | generated-artifacts | yes |  |  |
| packages/coding-agent/THIRD_PARTY_NOTICES.txt | generated | generated-artifacts | yes |  |  |
| packages/coding-agent/breadboard-sdk-provenance.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/package.json | manual-review | manual-review-boundaries | yes | fork-release | 1 |
| packages/coding-agent/scripts/build-binary.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/build-engine-distribution.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/build-engine-distribution.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/bundle-dist.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/c03-provider-parity-smoke.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/compile-binary.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/engine-build-requirements.darwin-arm64-py311.txt | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/engine-build-requirements.in | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/omp | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/scripts/prepare-installed-engine-sidecar.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/prepare-installed-engine-sidecar.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/scripts/verify-breadboard-sdk-provenance.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/sdk-export-inventory.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/activity/index.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/assets/branding/breadboard_icon_bb_v1.provenance.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/assets/branding/breadboard_icon_bb_v1.svg | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/bb.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/blob-broker/uploaders-cloud-drives.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/canonical-e4-session-port.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/canonical-e4-session-port.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/composer-metrics.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/src/breadboard/e4-agent-stream.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/e4-agent-stream.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/e4-observations.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/engine-port.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/engine-port.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/harness-lock-view.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/harness-port-client.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/harness-port.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/darwin-pinned-directory.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/darwin-pinned-directory.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/darwin-verified-spawn.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/darwin-verified-spawn.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/engine-distribution-installer.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/engine-distribution-installer.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/engine-runtime-bundle.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/engine-runtime-bundle.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/installed-engine-manifest.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/installed-engine-manifest.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/installed-engine-selection.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/installed-engine-selection.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/lifecycle-presenter.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/lifecycle-production.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/lifecycle-state.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/lifecycle-supervisor.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/lifecycle-supervisor.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/linux-pinned-directory.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/linux-pinned-directory.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/local-authority-store.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/local-authority-store.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/pinned-directory.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/product-run-config.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/product-run-config.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/run-config.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/run-config.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/runtime-cleanup-store.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/lifecycle/runtime-cleanup-store.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/model-role-port.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/native-control-policy.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/src/breadboard/native-harness-extension.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/src/breadboard/native-harness-port.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/src/breadboard/native-harness-session.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/src/breadboard/native-launch-policy.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/omp-auth-gateway.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/omp-auth-gateway.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/product-settings.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/provider-auth-adapter.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/provider-auth-login.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/provider-auth-port.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/provider-free-model.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/runtime-lifecycle.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/runtime.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/session-binding.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/session-binding.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/session-port.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/breadboard/shared-engine-client.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/src/breadboard/shared-engine-protocol.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/src/breadboard/shared-engine-worker.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/src/cli-commands.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/coding-agent/src/cli.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/coding-agent/src/cli/args.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/coding-agent/src/cli/command-help.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/cli/flag-tables.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/coding-agent/src/cli/gallery-cli.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/cli/help-extra.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/cli/update-cli.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/coding-agent/src/cli/worker-selectors.ts | manual-review | manual-review-boundaries | no |  |  |
| packages/coding-agent/src/collab/guest.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/collab/host.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/collab/protocol.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/commands/engine.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/commands/launch-help.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/commands/research.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/commands/setup.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/config/model-registry.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/config/settings-schema.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/config/settings.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/debug/index.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/extensibility/extensions/runner.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/extensibility/extensions/types.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/irc/bus.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/irc/conversations.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/irc/history.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/irc/types.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/main.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/coding-agent/src/modes/components/agent-hub.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/agent-hub/activity-view.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/components/agent-hub/harness-view.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/agent-hub/messages-view.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/components/agent-hub/roster-view.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/components/agent-transcript-viewer.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/components/assistant-message.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/attachment-chips.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/breadboard-tool-renderers.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/collab-prompt-message.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/composer-shape-preview.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/composer-shape-registry.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/custom-editor.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/diff.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/login-dialog.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/components/logout-account-selector.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/components/model-hub.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/components/model-picker.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/components/move-overlay.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/oauth-provider-data-source.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/oauth-selector.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/plan-save-overlay.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/segment-track.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/settings-defs.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/components/settings-selector.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/status-line/breadboard-fields.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/components/status-line/breadboard-presentation.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/components/status-line/component.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/status-line/index.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/components/status-line/presets.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/status-line/segments.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/status-line/types.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/tips.txt | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/tool-execution.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/transcript-container.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/components/user-message.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/components/welcome.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/composer-attachments.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/composer-cache.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/composer.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/controllers/cleanse-command-controller.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/controllers/command-controller.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/controllers/event-controller.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/controllers/input-controller.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/controllers/selector-controller.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/gradient-highlight.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/interactive-mode.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/macos-spelling.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/prompt-action-autocomplete.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/session-teardown.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/index.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/lazy.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/composer.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/glyph.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/information-layout.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/model.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/outro.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/providers.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/sign-in.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/splash.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/types.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/scenes/web-search.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/setup-wizard/startup-splash.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/setup-wizard/wizard-overlay.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/startup-composer.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/modes/theme/color.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/defaults/breadboard-light.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/defaults/breadboard.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/defaults/index.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/schema-validation.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/theme/schema.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/shimmer.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/symbols.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/theme-class.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/theme-schema.json | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/modes/theme/theme.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/theme/tui-adapters.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/types.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/modes/utils/ui-helpers.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/native-product-env.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/omp.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/product-entrypoint.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/product-identity.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/sdk.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/session/agent-session-types.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/session/agent-session.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/session/auth-storage.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/session/session-entries.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/session/session-maintenance.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/session/session-manager.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/session/session-stats.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/slash-commands/acp-builtins.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/slash-commands/available-commands.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/src/slash-commands/builtin-registry.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/slash-commands/builtin-session.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/slash-commands/harness.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/startup-prepaint-args.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/startup-prepaint-args.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/tools/ask.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/tools/hub/messaging.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/tui/hyperlink.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/utils/command-usage.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/utils/objects.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/utils/reduced-motion.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/src/utils/session-color.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/src/utils/title-generator.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/activity-index.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/agent-hub-activate.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/agent-hub-advisor-scroll.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/agent-hub-ordering.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/agent-session-handoff.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/agent-session-stats.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/agent-session-terminal-tool.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/agent-session-turn-settle.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/autolearn-controller.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/bbomp-core-52/bbomp-core-52.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard-accessibility.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard-api-key.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard-lifecycle-real-backend.integration.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard-sdk-provenance.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard-status-presentation.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/test/breadboard/cancel-recovery-journey.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/cancel_recovery_journey_test.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/composer-metrics.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/test/breadboard/e4-observation-notices.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/engine-port.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/everyday-interactions-journey.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/fixtures/codex_e4.lock.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/harness-lock-view.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/harness-palette.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/harness-port-client.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/harness-port-wiring.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/harness-view.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/installed-product-journey.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/installed_product_journey_geometry_test.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/native-harness-session.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/test/breadboard/native-startup-selection.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/test/breadboard/product-task-defaults.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/provider-auth-login.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/provider-auth-port.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/research-compare-failure-journey.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/research-compare-journey.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/responsiveness-baseline.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/responsiveness_baseline_error_frames_test.py | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/breadboard/shared-engine-worker.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | no |  |  |
| packages/coding-agent/test/cli-argv-routing.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/cli/completions.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/cli/update-cli.test.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/coding-agent/test/collab/guest-ui-request.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/collab/read-only.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/command-controller-new-session.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/composer-cache.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/fixtures/breadboard-drain-controller.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/flag-tables.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/helpers/interactive-mode-context.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/helpers/retry-ambiguous-replay.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/hook-selector-overflow.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/input-controller-escape.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/input-controller-keybindings.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/interactive-mode-working-accent.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/interactive-terminal-e2e.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/irc-history.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/issue-2761-hidden-local-providers.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/issue-3031-repro.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/issue-970-custom-provider-discovery.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/keybindings-escape-components.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/macos-spelling.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/main-session-resolution-error.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/main-startup-initialization.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/model-hub.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/model-picker.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/model-registry.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/ask-dialog.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/components/attachment-chips.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/breadboard-tool-renderers.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/composer-shape-preview.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/custom-editor.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/components/effective-lock-fixture.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/login-dialog.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/components/oauth-selector.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/plan-review-overlay.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/components/segment-track.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/settings-defs-breadboard.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/settings-multiselect.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/modes/components/settings-selector-memory-refresh.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/modes/components/status-line-harness.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/status-line/breadboard-fields.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/modes/components/transcript-container.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/components/user-message-keywords.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/components/welcome.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/controllers/event-controller-abort-guard.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/controllers/event-controller-superseded-agent-end.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/magic-keywords.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/modes/orchestrate.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/session-teardown.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/modes/workflow.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/plugin-extensions-discovery.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/read-tool-group.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/reduced-motion.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/retry-ambiguous-replay.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/sdk-extension-tool-seams.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/sdk-main-stream-auth.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/session-color.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/session-exit-diagnostics.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/setup-identity.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/setup-wizard-sign-in.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/setup-wizard.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/silent-abort-overlay-render.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/branch.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/btw.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/collab-list.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/collab-qrcode.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/compact.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/copy.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/debug.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/force.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/fresh.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/guided-goal.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/harness.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/slash-commands/login.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/slash-commands/memory.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/mode-attachments.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/move.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/omfg.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/pin.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/plan-history.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/rename.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/resume.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/retry.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/session.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/slash-commands/setup.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/shake.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/slash-commands/tan.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/startup-composer.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/startup-splash.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/status-line-context-cache.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/status-line-overflow.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/status-line-settings-cache.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/status-line-transparent.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/status-line-usage-refresh.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/status-line-usage.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/status-line-vcs-refresh.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/status-text-sanitization.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/streaming-preview-height.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/task/task-progress-render.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/theme-color-mode.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/coding-agent/test/theme-highlight-diff-parity.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/theme-lazy-status-color.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/tool-execution-write-repaint.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/tools/bash-sixel-render.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/tools/edit-renderer.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/tools/glob-renderer.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/tools/grep-path-lists.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/coding-agent/test/tools/grep-renderer.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/tools/resolve.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/welcome-history-resize.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/welcome-tip.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/test/write-xdev-dispatch.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/coding-agent/tsconfig.json | manual-review | manual-review-boundaries | yes | fork-release | 1 |
| packages/coding-agent/vendor/breadboard-sdk-0.4.0.tgz | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/natives/CHANGELOG.md | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/natives/native/loader-state.d.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/natives/native/loader-state.js | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/natives/test/issue-823-repro.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/stats/src/aggregator.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/stats/src/sync-worker.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/CHANGELOG.md | manual-review | manual-review-boundaries | yes | fork-runtime | 3 |
| packages/tui/src/autocomplete.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/src/components/editor.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/src/components/markdown.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/tui/src/components/select-list.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/src/components/settings-list.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/tui/src/desktop-notify.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/src/terminal-capabilities.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/src/tui.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/test/adaptive-render-backpressure.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/test/autocomplete.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/test/desktop-notify.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/tui/test/editor-autocomplete-actions.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/test/editor-text-assist.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/test/editor-top-border-provider.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/tui/test/editor.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/test/history-frame-plan.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/test/input-render-scheduling.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/tui/test/markdown.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/tui/test/notifications.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/tui/test/settings-list.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/utils/src/chalk.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/utils/src/cli.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/utils/src/dirs.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/utils/src/index.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/utils/src/logger.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/utils/src/product-distribution.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/utils/src/worker-host.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/utils/test/fixtures/logger-contract-probe.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/utils/test/logger-contract.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| packages/utils/test/product-distribution.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| packages/utils/test/worker-host.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/wire/CHANGELOG.md | upstream-owned | upstream-ordinary-omp | yes |  |  |
| packages/wire/src/index.ts | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| packages/wire/test/constants.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| scripts/audit-fork-delta.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/audit-fork-delta.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/build-product-release.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/build-product-release.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/ci-release-build-binaries.test.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| scripts/ci-release-build-binaries.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| scripts/ci-release-publish.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/ci-release-publish.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/fork-layer-manifest.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/generate-third-party-notices.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/generate-third-party-notices.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/inspect-upstream-sync.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/inspect-upstream-sync.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/install-product-release.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/install-product-release.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/install-tests/binary.dockerfile | upstream-owned | upstream-ordinary-omp | yes |  |  |
| scripts/link-omp.sh | manual-review | manual-review-boundaries | yes | omp-entrypoint | 2 |
| scripts/local-product-launcher.test.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| scripts/local-product-launcher.ts | upstream-owned | upstream-ordinary-omp | no |  |  |
| scripts/p31/upstream-sync-policy.json | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/product-archive.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/source-identity-generators.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/sync-themes.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| scripts/sync-versions.ts | upstream-owned | upstream-ordinary-omp | yes |  |  |
| scripts/verify-upstream-sync.test.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |
| scripts/verify-upstream-sync.ts | breadboard-owned | breadboard-owned-adapters-and-controls | yes |  |  |

## Violations

- **unknown-path** `docs/cli-reference.md`: path did not match an ordered delta-policy rule
- **unknown-path** `docs/settings.md`: path did not match an ordered delta-policy rule
- **unknown-path** `docs/theme.md`: path did not match an ordered delta-policy rule
- **manifest** `packages/coding-agent/src/cli/worker-selectors.ts`: manual boundary path is absent from the migrated manifest
- **budget**: changed path count 548 exceeds total budget 400
- **budget**: upstream entrypoint count 14 exceeds budget 13
- **adapter-boundary** `packages/coding-agent/src/slash-commands/acp-builtins.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **adapter-boundary** `packages/coding-agent/src/slash-commands/available-commands.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **adapter-boundary** `packages/coding-agent/test/modes/components/status-line/breadboard-fields.test.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **adapter-boundary** `packages/coding-agent/test/sdk-main-stream-auth.test.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **adapter-boundary** `packages/coding-agent/test/startup-composer.test.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **adapter-boundary** `packages/utils/test/fixtures/logger-contract-probe.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **adapter-boundary** `packages/utils/test/logger-contract.test.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **adapter-boundary** `scripts/local-product-launcher.test.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **adapter-boundary** `scripts/local-product-launcher.ts`: BreadBoard endpoint/schema literal is outside a declared adapter
- **inline-breadboard** `packages/coding-agent/src/config/settings.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/components/agent-transcript-viewer.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/components/model-hub.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/components/model-picker.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/components/status-line/breadboard-fields.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/components/status-line/breadboard-presentation.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/components/status-line/index.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/controllers/cleanse-command-controller.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/controllers/input-controller.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/modes/setup-wizard/scenes/information-layout.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/sdk.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/session/agent-session.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/slash-commands/acp-builtins.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/src/slash-commands/available-commands.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/test/modes/components/status-line/breadboard-fields.test.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/test/sdk-main-stream-auth.test.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/coding-agent/test/startup-composer.test.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/utils/test/fixtures/logger-contract-probe.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `packages/utils/test/logger-contract.test.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `scripts/local-product-launcher.test.ts`: upstream-owned diff adds inline BreadBoard logic
- **inline-breadboard** `scripts/local-product-launcher.ts`: upstream-owned diff adds inline BreadBoard logic
