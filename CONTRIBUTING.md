# Contributing to BreadBoard TUI

Pull requests are welcome. Keep them focused, understand the work you submit,
and be prepared to explain and maintain it.

## Choose the correct repository

Use this repository for BreadBoard-specific TUI behavior, product packaging,
the `bb` entrypoint, the BreadBoard engine adapter, and downstream release
governance.

Changes that are generally useful to Oh My Pi should be developed against the
clean [`kmccleary3301/oh-my-pi`](https://github.com/kmccleary3301/oh-my-pi)
contribution fork and proposed to
[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi). Do not route
BreadBoard product releases through that fork.

## Before you start

Bug fixes, documentation corrections, and narrowly scoped improvements can go
straight to a pull request. Start a feature request before implementing a new
subsystem, broad UI change, dependency, or change spanning several packages.
Prior discussion does not guarantee that a pull request will be merged.

## AI-assisted contributions

AI agents are welcome as tools, not as unattended contributors. Do not give an
agent a vague goal and submit whatever it produces.

Before opening a pull request, you must:

- constrain the agent to the agreed scope and reject unrelated changes;
- review every changed file and understand the resulting behavior;
- run the relevant checks and exercise the changed behavior yourself; and
- submit the pull request only after that review, rather than letting an agent
  publish it autonomously.

You are responsible for the code, regardless of who or what generated it.

## Pull request requirements

Every pull request body **MUST include at least one sentence written by you, in
your own words**, explaining what changed and why. A generated summary, pasted
agent transcript, or checklist alone does not satisfy this requirement.

You **MUST verify that the change works as intended**. Automated checks are
expected where relevant, but they are not proof that the behavior works:

- for a bug fix, reproduce the bug and confirm the same reproduction no longer
  fails;
- for a feature, launch the product and use the feature end to end;
- for a UI change, interact with it and inspect the rendered result; and
- for a packaging or governance change, run the fork-delta audit, build the
  compiled `bb` binary, and execute its smoke test.

Use [`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md)
for development commands. Keep each pull request to one logical change. Avoid
unrelated cleanup, generated noise, or features outside the agreed scope.

## Contribution licensing

A contribution intentionally submitted for inclusion in BreadBoard TUI is
licensed under the MIT License.

This policy does not relicense upstream, third-party, or vendored code. You
must have the right to submit your contribution and must preserve applicable
copyright, license, attribution, and notice material. Submitting a contribution
does not require signing a Contributor License Agreement (CLA) or certifying a
Developer Certificate of Origin (DCO).

## Review

Maintainers review the submitted behavior and the contributor's understanding
of it—not the volume of generated code. Respond to review feedback yourself,
and only apply suggestions you have checked.

Pull requests may be closed when they skip required prior discussion, lack the
human-written explanation, contain unreviewed agent output, or mix unrelated
changes.
