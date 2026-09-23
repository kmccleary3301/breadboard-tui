# @breadboard/harness

Native BreadBoard harness data and snapshot-manifest helpers for the bb-omp fork.
`engine-data/snapshot.json` is generated from the pinned Python engine, never hand-edited.
The bundle stores tool definitions, prompt/config packs, and the two kernel schemas plus generated types used by later validation.

The snapshot script records the source commit, tree, and hashes so refreshes are explicit and reproducible.

`harnesses/` holds the built-in native harnesses, embedded in the binary. `bb-omp.native` is the native-mode default.
Its spec uses host tokens, which hand a slot back to the OMP session: `@host.tools` (OMP's tool set), `@host.system` (OMP's system prompt; later `system_order` entries are appended) and `@host.model` (OMP's model selection).
Both compilers keep the tokens as plain strings, so the lock matches the Python reference. After editing a built-in spec or prompt, regenerate its lock with `bun scripts/builtin-harness-locks.ts` from this package; `test/native/builtin-harness.test.ts` fails while a lock is stale.
