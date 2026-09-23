#!/usr/bin/env bun

import { chmod } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireAbsolute(value: string, name: string): string {
	const resolved = resolve(value);
	if (!isAbsolute(resolved) || /[\r\n\0]/u.test(resolved)) throw new Error(`${name} must be an absolute path`);
	return resolved;
}

export function renderNativeDailyDriverLauncher(options: {
	readonly binaryPath: string;
	readonly nativeProfileRoot: string;
	readonly r39ProfileRoot: string;
	readonly authSource: string;
}): string {
	const binaryPath = requireAbsolute(options.binaryPath, "binary path");
	const nativeProfileRoot = requireAbsolute(options.nativeProfileRoot, "native profile root");
	const r39ProfileRoot = requireAbsolute(options.r39ProfileRoot, "R39 profile root");
	const authSource = requireAbsolute(options.authSource, "auth source");
	return `#!/usr/bin/env bash
set -euo pipefail
umask 077
workspace="$(pwd -P)"
workspace_key="$(printf '%s' "$workspace" | /usr/bin/shasum -a 256 | /usr/bin/cut -d ' ' -f 1)"
native_root=${shellQuote(nativeProfileRoot)}/user/projects/$workspace_key
r39_root=${shellQuote(r39ProfileRoot)}/$workspace_key
marker="$native_root/.bb-native-profile-migration.v1.json"
receipt="$native_root/.bb-native-profile-migration.receipt.v1.json"
marker_valid=0
if [[ -f "$marker" && ! -L "$marker" ]] &&
  [[ "$(/usr/bin/plutil -extract schema raw -o - "$marker" 2>/dev/null)" == "bb.native_profile_migration.v1" ]] &&
  [[ "$(/usr/bin/plutil -extract source raw -o - "$marker" 2>/dev/null)" == "$r39_root" ]]; then
  marker_config_sha="$(/usr/bin/plutil -extract sourceConfigSha256 raw -o - "$marker" 2>/dev/null || true)"
  marker_agent_db_sha="$(/usr/bin/plutil -extract sourceAgentDbSha256 raw -o - "$marker" 2>/dev/null || true)"
  if [[ "$marker_config_sha" =~ ^[0-9a-f]{64}$ && "$marker_agent_db_sha" =~ ^[0-9a-f]{64}$ ]]; then
    marker_valid=1
  fi
fi
pending=$((1 - marker_valid))
if [[ "$pending" == 1 ]]; then
  [[ -d "$r39_root" && ! -L "$r39_root" ]] || { printf 'R39 profile is missing for workspace key %s\n' "$workspace_key" >&2; exit 1; }
  [[ ! -e "$native_root" ]] || { [[ -d "$native_root" && ! -L "$native_root" ]] || exit 1; }
  mkdir -p "$(dirname "$native_root")"
  for stale_seed in "$native_root".seed.*; do
    [[ -e "$stale_seed" ]] || continue
    [[ -d "$stale_seed" && ! -L "$stale_seed" ]] || exit 1
    rm -rf "$stale_seed"
  done
  if [[ ! -e "$native_root" ]]; then
    seed_root="$native_root.seed.$$"
    [[ ! -e "$seed_root" ]] || exit 1
    mkdir "$seed_root"
    shopt -s dotglob nullglob
    for source in "$r39_root"/*; do
      if [[ "$(basename "$source")" == agent ]]; then
        mkdir "$seed_root/agent"
        for agent_source in "$source"/*; do
          case "$(basename "$agent_source")" in
            agent.db*) continue ;;
          esac
          cp -a "$agent_source" "$seed_root/agent/"
        done
      else
        cp -a "$source" "$seed_root/"
      fi
    done
    shopt -u dotglob nullglob
    mv "$seed_root" "$native_root"
  fi
  [[ -d "$native_root/agent" && ! -L "$native_root/agent" ]] || exit 1
  rm -f "$native_root/agent"/agent.db*
  ln -s ${shellQuote(authSource)}/agent.db "$native_root/agent/agent.db"
  rm -f "$receipt"
fi
for directory in "$native_root" "$native_root/agent" "$native_root/config" "$native_root/temp"; do
  [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || exit 1
  mkdir -p "$directory"
done
if [[ "$pending" == 1 ]]; then
  export BREADBOARD_NATIVE_PROFILE_MIGRATION=1
fi
set +e
/usr/bin/env -i \\
  HOME="\${HOME:?HOME is required}" \\
  PATH="\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \\
  SHELL="\${SHELL:-/bin/zsh}" \\
  TERM="\${TERM:-xterm-256color}" \\
  COLORTERM="\${COLORTERM:-truecolor}" \\
  LANG="\${LANG:-en_US.UTF-8}" \\
  USER="\${USER:-}" LOGNAME="\${LOGNAME:-}" \\
  OMP_SKIP_SETUP=1 \\
  BREADBOARD_NATIVE_PROFILE_MIGRATION="\${BREADBOARD_NATIVE_PROFILE_MIGRATION:-}" \\
  BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT="$receipt" \\
  TMPDIR="$native_root/temp/" \\
  BREADBOARD_CONFIG_DIR="$native_root/config" PI_CODING_AGENT_DIR="$native_root/agent" \\
  BREADBOARD_OMP_AGENT_DIR=${shellQuote(authSource)} \\
  ${shellQuote(binaryPath)} "$@"
status=$?
set -e
if [[ "$pending" == 1 && "$status" == 0 && -f "$receipt" && ! -L "$receipt" ]]; then
  source_config_sha="$(/usr/bin/shasum -a 256 "$r39_root/agent/config.yml" | /usr/bin/cut -d ' ' -f 1)"
  source_agent_db_sha="$(/usr/bin/shasum -a 256 "$r39_root/agent/agent.db" | /usr/bin/cut -d ' ' -f 1)"
  marker_tmp="$marker.tmp.$$"
  rm -f "$marker_tmp"
  printf '{"schema":"bb.native_profile_migration.v1","source":"%s","sourceConfigSha256":"%s","sourceAgentDbSha256":"%s"}\n' "$r39_root" "$source_config_sha" "$source_agent_db_sha" > "$marker_tmp"
  chmod 600 "$marker_tmp"
  mv -f "$marker_tmp" "$marker"
fi
exit "$status"
`;
}

if (import.meta.main) {
	const [binary, nativeProfileRoot, r39ProfileRoot, authSource, output] = process.argv.slice(2);
	if (!binary || !nativeProfileRoot || !r39ProfileRoot || !authSource || !output) {
		throw new Error(
			"Usage: native-daily-driver-launcher.ts <installed-bb> <native-profile-root> <r39-profile-root> <auth-source> <output>",
		);
	}
	await Bun.write(
		resolve(output),
		renderNativeDailyDriverLauncher({ binaryPath: binary, nativeProfileRoot, r39ProfileRoot, authSource }),
	);
	await chmod(resolve(output), 0o700);
	console.log(JSON.stringify({ output: resolve(output), profile: "per-workspace seeded copy" }));
}
