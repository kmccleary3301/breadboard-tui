#!/usr/bin/env bun

import { readFileSync } from "node:fs";
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

function extractFreshProfileSettings(launchPath: string): string {
	const source = readFileSync(requireAbsolute(launchPath, "R39 launcher"), "utf8");
	const match = source.match(/cat > "\$seed" <<'BB_PROFILE_SETTINGS'\n([\s\S]*?)\nBB_PROFILE_SETTINGS/u);
	if (!match) throw new Error("R39 launcher is missing its profile settings seed");
	const settings = JSON.parse(match[1]) as Record<string, unknown>;
	const breadboard = settings.breadboard;
	if (typeof breadboard !== "object" || breadboard === null || Array.isArray(breadboard)) {
		throw new Error("R39 profile settings seed is missing breadboard settings");
	}
	const breadboardSettings = breadboard as Record<string, unknown>;
	for (const key of [
		"engineMode",
		"baseUrl",
		"auth",
		"tls",
		"engineArtifact",
		"ownerExitPolicy",
		"sessionConfigPath",
	]) {
		delete breadboardSettings[key];
	}
	const harness = breadboardSettings.harness;
	if (typeof harness !== "object" || harness === null || Array.isArray(harness)) {
		throw new Error("R39 profile settings seed is missing harness settings");
	}
	(harness as Record<string, unknown>).default = "daily_driver";
	return JSON.stringify(settings);
}

export function renderNativeDailyDriverLauncher(options: {
	readonly binaryPath: string;
	readonly nativeProfileRoot: string;
	readonly r39ProfileRoot: string;
	readonly authSource: string;
	readonly freshProfileSettings?: string;
}): string {
	const binaryPath = requireAbsolute(options.binaryPath, "binary path");
	const nativeProfileRoot = requireAbsolute(options.nativeProfileRoot, "native profile root");
	const r39ProfileRoot = requireAbsolute(options.r39ProfileRoot, "R39 profile root");
	const authSource = requireAbsolute(options.authSource, "auth source");
	const freshProfileSettings = options.freshProfileSettings ? shellQuote(options.freshProfileSettings) : "''";
	return `#!/usr/bin/env bash
set -euo pipefail
umask 077
workspace="$(pwd -P)"
workspace_key="$(printf '%s' "$workspace" | /usr/bin/shasum -a 256 | /usr/bin/cut -d ' ' -f 1)"
native_root=${shellQuote(nativeProfileRoot)}/user/projects/$workspace_key
r39_root=${shellQuote(r39ProfileRoot)}/$workspace_key
marker="$native_root/.bb-native-profile-migration.v1.json"
receipt="$native_root/.bb-native-profile-migration.receipt.v1.json"
case "\${1:-}" in
  --version|-v|--help|-h|help|--license)
    exec /usr/bin/env -i \\
      HOME="\${HOME:?HOME is required}" \\
      PATH="\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \\
      SHELL="\${SHELL:-/bin/zsh}" \\
      TERM="\${TERM:-xterm-256color}" \\
      COLORTERM="\${COLORTERM:-truecolor}" \\
      LANG="\${LANG:-en_US.UTF-8}" \\
      USER="\${USER:-}" LOGNAME="\${LOGNAME:-}" \\
      PI_DEBUG_STARTUP="\${PI_DEBUG_STARTUP:-}" \\
      OMP_SKIP_SETUP=1 BREADBOARD_PRODUCT=1 \\
      ${shellQuote(binaryPath)} "$@"
    ;;
esac
marker_valid=0
if [[ -f "$marker" && ! -L "$marker" ]] &&
  [[ "$(/usr/bin/plutil -extract schema raw -o - "$marker" 2>/dev/null)" == "bb.native_profile_migration.v1" ]]; then
  marker_source="$(/usr/bin/plutil -extract source raw -o - "$marker" 2>/dev/null || true)"
  if [[ "$marker_source" == "$r39_root" || "$marker_source" == "fresh" ]]; then
    marker_config_sha="$(/usr/bin/plutil -extract sourceConfigSha256 raw -o - "$marker" 2>/dev/null || true)"
    marker_agent_db_sha="$(/usr/bin/plutil -extract sourceAgentDbSha256 raw -o - "$marker" 2>/dev/null || true)"
    if [[ "$marker_config_sha" =~ ^[0-9a-f]{64}$ && "$marker_agent_db_sha" =~ ^[0-9a-f]{64}$ ]]; then
      marker_valid=1
    fi
  fi
fi
pending=$((1 - marker_valid))
source_profile=0
markerless_profile=0
fresh_profile=0
if [[ "$pending" == 1 ]]; then
  if [[ -d "$r39_root" && ! -L "$r39_root" ]]; then
    source_profile=1
  elif [[ -e "$native_root" ]]; then
    markerless_profile=1
  elif [[ -z ${freshProfileSettings} ]]; then
    printf 'R39 profile is missing and no fresh profile settings were provided for workspace key %s\n' "$workspace_key" >&2
    exit 1
  else
    fresh_profile=1
  fi
  [[ ! -e "$native_root" ]] || { [[ -d "$native_root" && ! -L "$native_root" ]] || exit 1; }
  mkdir -p "$(dirname "$native_root")"
  for stale_seed in "$native_root".seed.*; do
    [[ -e "$stale_seed" ]] || continue
    [[ -d "$stale_seed" && ! -L "$stale_seed" ]] || exit 1
    stale_pid="\${stale_seed##*.seed.}"
    if [[ "$stale_pid" =~ ^[0-9]+$ ]] && kill -0 "$stale_pid" 2>/dev/null; then
      continue
    fi
    rm -rf "$stale_seed"
  done
  if [[ ! -e "$native_root" ]]; then
    seed_root="$native_root.seed.$$"
    [[ ! -e "$seed_root" ]] || exit 1
    mkdir "$seed_root"
    if [[ "$source_profile" == 1 ]]; then
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
    else
      mkdir "$seed_root/agent"
      config_tmp="$seed_root/agent/config.yml.tmp"
      printf '%s\n' ${freshProfileSettings} > "$config_tmp"
      chmod 600 "$config_tmp"
      mv "$config_tmp" "$seed_root/agent/config.yml"
      agent_db_link="$seed_root/agent/.agent.db.$$"
      ln -s ${shellQuote(authSource)}/agent.db "$agent_db_link"
      mv -f "$agent_db_link" "$seed_root/agent/agent.db"
      receipt_tmp="$seed_root/.bb-native-profile-migration.receipt.v1.json.tmp.$$"
      printf '{"schema":"bb.native_profile_migration.receipt.v1"}\n' > "$receipt_tmp"
      chmod 600 "$receipt_tmp"
      mv -f "$receipt_tmp" "$seed_root/.bb-native-profile-migration.receipt.v1.json"
      source_config_sha="$(/usr/bin/shasum -a 256 "$seed_root/agent/config.yml" | /usr/bin/cut -d ' ' -f 1)"
      source_agent_db_sha="$(/usr/bin/shasum -a 256 ${shellQuote(authSource)}/agent.db | /usr/bin/cut -d ' ' -f 1)"
      marker_tmp="$seed_root/.bb-native-profile-migration.v1.json.tmp.$$"
      printf '{"schema":"bb.native_profile_migration.v1","source":"fresh","sourceConfigSha256":"%s","sourceAgentDbSha256":"%s"}\n' "$source_config_sha" "$source_agent_db_sha" > "$marker_tmp"
      chmod 600 "$marker_tmp"
      mv -f "$marker_tmp" "$seed_root/.bb-native-profile-migration.v1.json"
    fi
    if ! mv "$seed_root" "$native_root" 2>/dev/null; then
      [[ -d "$native_root" && ! -L "$native_root" ]] || exit 1
      rm -rf "$seed_root"
    fi
  fi
  if [[ "$fresh_profile" == 1 ]]; then
    [[ -f "$native_root/agent/config.yml" ]] || exit 1
    if [[ ! -f "$receipt" ]]; then
      receipt_tmp="$receipt.tmp.$$"
      printf '{"schema":"bb.native_profile_migration.receipt.v1"}\n' > "$receipt_tmp"
      chmod 600 "$receipt_tmp"
      mv -f "$receipt_tmp" "$receipt"
    fi
    if [[ ! -f "$marker" ]]; then
      source_config_sha="$(/usr/bin/shasum -a 256 "$native_root/agent/config.yml" | /usr/bin/cut -d ' ' -f 1)"
      source_agent_db_sha="$(/usr/bin/shasum -a 256 ${shellQuote(authSource)}/agent.db | /usr/bin/cut -d ' ' -f 1)"
      marker_tmp="$marker.tmp.$$"
      printf '{"schema":"bb.native_profile_migration.v1","source":"fresh","sourceConfigSha256":"%s","sourceAgentDbSha256":"%s"}\n' "$source_config_sha" "$source_agent_db_sha" > "$marker_tmp"
      chmod 600 "$marker_tmp"
      mv -f "$marker_tmp" "$marker"
    fi
    pending=0
  else
    rm -f "$receipt"
  fi
fi
for directory in "$native_root" "$native_root/agent" "$native_root/config" "$native_root/temp"; do
  [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || exit 1
  mkdir -p "$directory"
done
expected_agent_db=${shellQuote(authSource)}/agent.db
if [[ ! -L "$native_root/agent/agent.db" || "$(readlink "$native_root/agent/agent.db")" != "$expected_agent_db" ]]; then
  rm -f "$native_root/agent"/agent.db* "$native_root/agent"/.agent.db.*
  agent_db_link="$native_root/agent/.agent.db.$$"
  ln -s "$expected_agent_db" "$agent_db_link"
  mv -f "$agent_db_link" "$native_root/agent/agent.db"
fi
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
  PI_DEBUG_STARTUP="\${PI_DEBUG_STARTUP:-}" \\
  OMP_SKIP_SETUP=1 BREADBOARD_PRODUCT=1 \\
  BREADBOARD_NATIVE_PROFILE_MIGRATION="\${BREADBOARD_NATIVE_PROFILE_MIGRATION:-}" \\
  BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT="$receipt" \\
  TMPDIR="$native_root/temp/" \\
  BREADBOARD_CONFIG_DIR="$native_root/config" PI_CODING_AGENT_DIR="$native_root/agent" \\
  BREADBOARD_OMP_AGENT_DIR=${shellQuote(authSource)} \\
  ${shellQuote(binaryPath)} "$@"
status=$?
set -e
if [[ "$pending" == 1 && "$status" == 0 && -f "$receipt" && ! -L "$receipt" && ( "$source_profile" == 1 || "$markerless_profile" == 1 ) ]]; then
  marker_source="$r39_root"
  marker_config="$r39_root/agent/config.yml"
  marker_db="$r39_root/agent/agent.db"
  if [[ "$source_profile" != 1 ]]; then
    marker_source="fresh"
    marker_config="$native_root/agent/config.yml"
    marker_db=${shellQuote(authSource)}/agent.db
  fi
  if [[ ! -f "$marker_config" ]]; then
    marker_config="$native_root/agent/config.yml"
  fi
  if [[ ! -f "$marker_db" ]]; then
    marker_db=${shellQuote(authSource)}/agent.db
  fi
  source_config_sha=""
  source_agent_db_sha=""
  if [[ -f "$marker_config" ]]; then
    source_config_sha="$(/usr/bin/shasum -a 256 "$marker_config" | /usr/bin/cut -d ' ' -f 1)"
  fi
  if [[ -f "$marker_db" ]]; then
    source_agent_db_sha="$(/usr/bin/shasum -a 256 "$marker_db" | /usr/bin/cut -d ' ' -f 1)"
  fi
  marker_tmp="$marker.tmp.$$"
  rm -f "$marker_tmp"
  printf '{"schema":"bb.native_profile_migration.v1","source":"%s","sourceConfigSha256":"%s","sourceAgentDbSha256":"%s"}\n' "$marker_source" "$source_config_sha" "$source_agent_db_sha" > "$marker_tmp"
  chmod 600 "$marker_tmp"
  mv -f "$marker_tmp" "$marker"
fi
exit "$status"
`;
}

if (import.meta.main) {
	const [binary, nativeProfileRoot, r39ProfileRoot, authSource, output, r39Launch] = process.argv.slice(2);
	if (!binary || !nativeProfileRoot || !r39ProfileRoot || !authSource || !output || !r39Launch) {
		throw new Error(
			"Usage: native-daily-driver-launcher.ts <installed-bb> <native-profile-root> <r39-profile-root> <auth-source> <output> <r39-launch>",
		);
	}
	await Bun.write(
		resolve(output),
		renderNativeDailyDriverLauncher({
			binaryPath: binary,
			nativeProfileRoot,
			r39ProfileRoot,
			authSource,
			freshProfileSettings: extractFreshProfileSettings(r39Launch),
		}),
	);
	await chmod(resolve(output), 0o700);
	console.log(JSON.stringify({ output: resolve(output), profile: "per-workspace seeded copy" }));
}
