#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
engine="$script_dir/demo_instance.py"

# The repo-root symlink is the supported Unix development path: Bram resolves
# the adjacent app/ checkout and serves edits from disk on every pane reload.
launching=false
for arg in "$@"; do
  if [ "$arg" = "launch" ]; then
    launching=true
  fi
done

if [ "$launching" = true ]; then
  bram_binary=${BRAM_BIN:-"$repo_root/bram"}
  if [ ! -x "$bram_binary" ]; then
    echo "demo-instance: no executable Bram at $bram_binary" >&2
    echo "Build the debug binary and refresh the repo-root ./bram symlink." >&2
    exit 2
  fi
  if [ ! -d "$repo_root/app" ]; then
    echo "demo-instance: on-disk app/ checkout is missing at $repo_root/app" >&2
    exit 2
  fi
  export BRAM_DEMO_DEFAULT_BINARY="$bram_binary"
fi

exec "${PYTHON:-python3}" "$engine" "$@"
