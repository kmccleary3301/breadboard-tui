#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"

NATIVES_PACKAGE="$ROOT_DIR/packages/natives/package.json"
NATIVES_PACKAGE_INITIAL="$WORK_DIR/natives-package.initial.json"
cp "$NATIVES_PACKAGE" "$NATIVES_PACKAGE_INITIAL"
restore_workspace() {
   cp "$NATIVES_PACKAGE_INITIAL" "$NATIVES_PACKAGE"
   rm -rf "$WORK_DIR"
}
trap restore_workspace EXIT

smoke_cli() {
   local cli_bin="$1"
   local runtime_dir
   runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$cli_bin" --version
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$cli_bin" --help >/dev/null
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$cli_bin" stats --summary >/dev/null
   # Spawns bundled workers and serves the stats dashboard once. Regression
   # probe for #1011/#1027 worker loading and for compiled distributions
   # missing the dashboard assets that `stats --summary` never touches.
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$cli_bin" --smoke-test
}

align_native_manifest() {
   local addon_version=""
   local addon
   local candidate_version
   local candidates=()
   shopt -s nullglob
   candidates=("$ROOT_DIR"/packages/natives/native/pi_natives.*.node)
   shopt -u nullglob

   if [ "${#candidates[@]}" -eq 0 ]; then
      echo "No native addon found for install smoke" >&2
      exit 1
   fi
   for addon in "${candidates[@]}"; do
      candidate_version="$(bun "$ROOT_DIR/scripts/install-tests/native-version.ts" "$addon")" || exit 1
      if [ -z "$addon_version" ]; then
         addon_version="$candidate_version"
      elif [ "$addon_version" != "$candidate_version" ]; then
         echo "Native addon version mismatch: $addon_version vs $candidate_version ($addon)" >&2
         exit 1
      fi
   done

   local declared_version
   declared_version="$(jq -r '.version' "$NATIVES_PACKAGE")"
   if [ "$declared_version" = "$addon_version" ]; then return; fi

   echo "Aligning install smoke native manifest $declared_version → $addon_version"
   jq --arg version "$addon_version" '.version = $version' "$NATIVES_PACKAGE" > "$WORK_DIR/natives-package.aligned.json"
   mv "$WORK_DIR/natives-package.aligned.json" "$NATIVES_PACKAGE"
}

if [ "${BB_INSTALL_TEST_SKIP_NATIVE_BUILD:-0}" != "1" ]; then
   bun --cwd=packages/natives run build
fi
align_native_manifest
bun --cwd=packages/coding-agent run build:bb

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/bb "$BINARY_DIR/bb"
smoke_cli "$BINARY_DIR/bb"

echo "Product binary install smoke passed"
