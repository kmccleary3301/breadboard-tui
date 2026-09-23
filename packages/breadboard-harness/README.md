# @breadboard/harness

Native BreadBoard harness data and snapshot-manifest helpers for the bb-omp fork.
`engine-data/snapshot.json` is generated from the pinned Python engine, never hand-edited.
The bundle stores tool definitions, prompt/config packs, and the two kernel schemas plus generated types used by later validation.

The snapshot script records the source commit, tree, and hashes so refreshes are explicit and reproducible.
