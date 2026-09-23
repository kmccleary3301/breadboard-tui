# @breadboard/harness

Native BreadBoard harness data and snapshot-manifest helpers for the bb-omp fork.
`engine-data/` is generated from the pinned Python engine, never hand-edited.
The kernel schemas come from `contracts/kernel/schemas`; generated types come from `sdk/ts-kernel-contracts/src/generated/types`.

The snapshot script records the source commit, tree, and hashes so refreshes are explicit and reproducible.
