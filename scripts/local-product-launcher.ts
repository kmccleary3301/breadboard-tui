#!/usr/bin/env bun

import { readdirSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	type BuildEngineDistribution,
	loadBuildEngineDistribution,
} from "../packages/coding-agent/scripts/prepare-installed-engine-sidecar";
import { resolveInstalledEngineSelection } from "../packages/coding-agent/src/breadboard/lifecycle/installed-engine-selection";

interface LocalProductLauncherOptions {
	readonly binaryPath: string;
	readonly profileRoot: string;
	readonly harnessPath: string;
	readonly workspaceHarnessPath: string;
	readonly authSource: string;
	readonly defaultModel: string;
	readonly distribution: BuildEngineDistribution;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Generate a local installed-product profile without binding it to a test workspace. */
export function renderLocalProductLauncher(options: LocalProductLauncherOptions): string {
	for (const value of [options.binaryPath, options.profileRoot, options.harnessPath, options.authSource]) {
		if (!isAbsolute(value) || /[\r\n\0]/u.test(value))
			throw new Error("Launcher paths must be absolute single-line paths");
	}
	const workspaceParts = options.workspaceHarnessPath.split("/");
	if (
		isAbsolute(options.workspaceHarnessPath) ||
		workspaceParts.some(part => !part || part === "." || part === ".." || /[\r\n\0]/u.test(part)) ||
		basename(options.workspaceHarnessPath) !== basename(options.harnessPath)
	) {
		throw new Error("Workspace harness must be a contained relative path with the source filename");
	}
	const sourceRoot = dirname(options.harnessPath);
	const targetRoot = dirname(options.workspaceHarnessPath);
	const files: string[] = [];
	const directories = new Set<string>();
	const addDirectories = (directory: string) => {
		const parts = directory.split("/");
		for (let count = 1; count <= parts.length; count++) directories.add(parts.slice(0, count).join("/"));
	};
	addDirectories(targetRoot);
	for (const entry of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() && !entry.isDirectory()) throw new Error("Harness resources must be regular files");
		const resource = relative(sourceRoot, join(entry.parentPath, entry.name));
		if (entry.isDirectory()) addDirectories(join(targetRoot, resource));
		else files.push(resource);
	}
	files.sort();
	const engine = options.distribution.manifest.engine;
	const initialSettings = JSON.stringify({
		symbolPreset: "nerd",
		composer: { shape: "box" },
		theme: { dark: "titanium", light: "light" },
		tools: { approvalMode: "always-ask" },
		modelRoles: { default: options.defaultModel, tiny: options.defaultModel },
		breadboard: {
			engineMode: "local-owned",
			harness: { default: options.workspaceHarnessPath },
			engineArtifact: {
				kind: "runtime-bundle",
				executablePath: engine.executablePath,
				executableSizeBytes: engine.executableSizeBytes,
				argv: engine.argv,
				executableSha256: engine.executableSha256,
				engineSourceSha256: engine.engineSourceSha256,
				servedBackendCommit: engine.servedBackendCommit,
				runtimeBundle: { ...engine.runtimeBundle, path: options.distribution.bundlePath },
			},
		},
	});
	return `#!/bin/bash
set -euo pipefail
umask 077
# Do not cd: the caller's project is the execution workspace.
workspace="$(pwd -P)"
workspace_key="$(printf '%s' "$workspace" | /usr/bin/shasum -a 256 | /usr/bin/cut -d ' ' -f 1)"
project=${shellQuote(join(options.profileRoot, "user", "projects"))}/"$workspace_key"
# Public harness operations stay contained in this workspace.
# Publish regular files atomically; never replace conflicting project resources.
case "\${1:-}" in
  --version|-v|--help|-h|help|--license) ;;
  *)
for relative_directory in ${[...directories].sort().map(shellQuote).join(" ")}; do
  target="$workspace/$relative_directory"
  [[ ! -L "$target" ]] || { printf 'Refusing symlinked harness directory: %s\\n' "$target" >&2; exit 1; }
  mkdir -p "$target"
done
for resource in ${files.map(shellQuote).join(" ")}; do
  source=${shellQuote(sourceRoot)}/"$resource"
  target="$workspace"/${shellQuote(targetRoot)}/"$resource"
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    seed="$(mktemp "$target.XXXXXX")"
    trap 'rm -f "$seed"' EXIT
    cp "$source" "$seed"
    chmod 600 "$seed"
    if ! ln "$seed" "$target" 2>/dev/null; then
      [[ -f "$target" && ! -L "$target" ]] || exit 1
    fi
    rm -f "$seed"
    trap - EXIT
  fi
  if [[ ! -f "$target" || -L "$target" ]] || ! cmp -s "$source" "$target"; then
    printf 'Refusing conflicting harness resource: %s\\n' "$target" >&2
    exit 1
  fi
done
for directory in ${[options.profileRoot, join(options.profileRoot, "user"), join(options.profileRoot, "user", "projects")].map(shellQuote).join(" ")} "$project" "$project/agent" "$project/config" "$project/temp"; do
  [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || { printf 'Refusing unsafe profile directory: %s\\n' "$directory" >&2; exit 1; }
  mkdir -p "$directory"
done
[[ ! -L "$project/agent/config.yml" && ( ! -e "$project/agent/config.yml" || -f "$project/agent/config.yml" ) ]] || { printf 'Refusing unsafe profile settings: %s\\n' "$project/agent/config.yml" >&2; exit 1; }
if [[ ! -e "$project/agent/config.yml" ]]; then
  seed="$(mktemp "$project/agent/config.yml.XXXXXX")"
  trap 'rm -f "$seed"' EXIT
  cat > "$seed" <<'BB_PROFILE_SETTINGS'
${initialSettings}
BB_PROFILE_SETTINGS
  # Atomic create: simultaneous launches must not truncate each other's settings.
  if ! ln "$seed" "$project/agent/config.yml" 2>/dev/null; then
    [[ -f "$project/agent/config.yml" && ! -L "$project/agent/config.yml" ]] || exit 1
  fi
  rm -f "$seed"
  trap - EXIT
fi
    ;;
esac
exec /usr/bin/env -i \\
  HOME="\${HOME:?HOME is required}" \\
  PATH="\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \\
  SHELL="\${SHELL:-/bin/zsh}" \\
  TERM="\${TERM:-xterm-256color}" \\
  COLORTERM="\${COLORTERM:-truecolor}" \\
  LANG="\${LANG:-en_US.UTF-8}" \\
  USER="\${USER:-}" LOGNAME="\${LOGNAME:-}" \\
  PI_DEBUG_STARTUP="\${PI_DEBUG_STARTUP:-}" \\
  TMPDIR="$project/temp/" OMP_SKIP_SETUP=1 \\
  BREADBOARD_CONFIG_DIR="$project/config" PI_CODING_AGENT_DIR="$project/agent" \\
  BREADBOARD_OMP_AGENT_DIR=${shellQuote(options.authSource)} \\
  ${shellQuote(options.binaryPath)} "$@"
`;
}

if (import.meta.main) {
	const [binary, profile, harness, workspaceHarness, authSource, defaultModel, engineRoot, extra] =
		process.argv.slice(2);
	if (
		!binary ||
		!profile ||
		!harness ||
		!workspaceHarness ||
		!authSource ||
		!defaultModel ||
		!engineRoot ||
		extra !== undefined
	) {
		throw new Error(
			"Usage: local-product-launcher.ts <installed-binary> <profile-root> <harness> <workspace-harness> <auth-source> <default-model> <engine-distribution-root>",
		);
	}
	const binaryPath = resolve(binary);
	const profileRoot = resolve(profile);
	const distribution = await loadBuildEngineDistribution(resolve(engineRoot));
	const installed = await resolveInstalledEngineSelection({
		productExecutablePath: binaryPath,
		trustRoot: distribution.trustRoot,
	});
	if (installed.artifact.kind !== "runtime-bundle")
		throw new Error("Local product requires its installed runtime bundle");
	const launcher = join(profileRoot, "launch");
	await mkdir(profileRoot, { recursive: true, mode: 0o700 });
	await Bun.write(
		launcher,
		renderLocalProductLauncher({
			binaryPath,
			profileRoot,
			harnessPath: resolve(harness),
			authSource: resolve(authSource),
			workspaceHarnessPath: workspaceHarness,
			defaultModel,
			distribution: { ...distribution, bundlePath: installed.artifact.runtimeBundle.path },
		}),
	);
	await chmod(launcher, 0o700);
	console.log(JSON.stringify({ launcher, workspace: "caller", settings: "per-project" }));
}
