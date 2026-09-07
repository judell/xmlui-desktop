#!/usr/bin/env bash
#
# install.sh — bootstrap installer for Bram.
#
# Usage:
#   curl -fsSL https://github.com/judell/bram/releases/latest/download/install.sh | sh
#
# What it does:
#   1. Detects platform (uname -s/-m).
#   2. Downloads the matching release artifact and SHA256SUMS.
#   3. Verifies SHA256.
#   4. Extracts the binary.
#   5. Copies bram to /usr/local/bin (if writable) or ~/.local/bin.
#   6. On macOS, removes the com.apple.quarantine xattr.
#   7. Prints PATH advice if the install dir isn't on PATH.
#
# Override the release tag with BRAM_VERSION=v1.2.3 (default: latest).
# Legacy XMLUI_DESKTOP_VERSION is also accepted.
# Override the download base URL with BRAM_BASE_URL=https://example.com
# Legacy XMLUI_DESKTOP_BASE_URL is also accepted.
# (useful for local dry-runs against a python -m http.server).

set -euo pipefail

VERSION="${BRAM_VERSION:-${XMLUI_DESKTOP_VERSION:-latest}}"
REPO="judell/bram"

if [[ -n "${BRAM_BASE_URL:-}" ]]; then
  BASE_URL="${BRAM_BASE_URL}"
elif [[ -n "${XMLUI_DESKTOP_BASE_URL:-}" ]]; then
  BASE_URL="${XMLUI_DESKTOP_BASE_URL}"
elif [[ "${VERSION}" == "latest" ]]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}_${ARCH}" in
  Darwin_arm64)             ARTIFACT="bram-macos-arm64.tar.gz" ;;
  Darwin_x86_64)            ARTIFACT="bram-macos-intel.tar.gz" ;;
  Linux_x86_64|Linux_amd64) ARTIFACT="bram-linux-amd64.tar.gz" ;;
  *)
    echo "Bram install: unsupported platform ${OS}/${ARCH}" >&2
    echo "Supported: macOS arm64/x86_64, Linux x86_64." >&2
    exit 1
    ;;
esac

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Bram install: missing required tool: $1" >&2
    exit 1
  }
}
require curl
require tar

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "Bram install: neither shasum nor sha256sum is available" >&2
    exit 1
  fi
}

TMP="$(mktemp -d)"
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

ARTIFACT_PATH="${TMP}/${ARTIFACT}"
SUMS_PATH="${TMP}/SHA256SUMS"

echo "Downloading ${ARTIFACT}…"
curl -fsSL "${BASE_URL}/${ARTIFACT}" -o "${ARTIFACT_PATH}"

echo "Downloading SHA256SUMS…"
curl -fsSL "${BASE_URL}/SHA256SUMS" -o "${SUMS_PATH}"

EXPECTED="$(awk -v f="${ARTIFACT}" '$2 == f { print $1; exit }' "${SUMS_PATH}")"
if [[ -z "${EXPECTED}" ]]; then
  echo "Bram install: ${ARTIFACT} not found in SHA256SUMS — refusing to install." >&2
  exit 1
fi
ACTUAL="$(sha256_of "${ARTIFACT_PATH}")"
if [[ "${ACTUAL}" != "${EXPECTED}" ]]; then
  echo "Bram install: SHA256 mismatch for ${ARTIFACT}." >&2
  echo "  expected: ${EXPECTED}" >&2
  echo "  actual:   ${ACTUAL}" >&2
  echo "Aborting." >&2
  exit 1
fi
echo "SHA256 verified."

echo "Extracting…"
tar -xzf "${ARTIFACT_PATH}" -C "${TMP}"

BIN="$(find "${TMP}" -type f \( -name bram -o -name xmlui-desktop \) | head -n 1)"
if [[ -z "${BIN}" ]]; then
  echo "Bram install: bram binary not found in archive" >&2
  exit 1
fi
chmod +x "${BIN}"

# Pick install dir: /usr/local/bin if writable, else ~/.local/bin.
INSTALL_DIR=""
if [[ -w /usr/local/bin ]] || ([[ -w /usr/local ]] && mkdir -p /usr/local/bin 2>/dev/null); then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
  mkdir -p "${INSTALL_DIR}"
fi

# issue-361: install by atomic rename, never in-place cp. Overwriting an
# existing binary reuses its inode, and on macOS the kernel's cached
# code-signing state for that vnode goes stale against the new content —
# an exec in the following moments is killed with SIGKILL (Code Signature
# Invalid) before its first instruction, which is what killed the 0.6.4
# self-update's relaunch child. Staging in the target directory keeps the
# mv a same-filesystem rename (fresh vnode, clean signature evaluation),
# and a running old binary keeps its unlinked inode. Quarantine is cleared
# on the staged file so the installed one never carries it.
install_binary() {
  local src="$1" target="$2"
  local staged="${target}.new.$$"
  cp "${src}" "${staged}"
  chmod +x "${staged}"
  if [[ "${OS}" == "Darwin" ]]; then
    xattr -d com.apple.quarantine "${staged}" 2>/dev/null || true
  fi
  mv -f "${staged}" "${target}"
}

TARGET="${INSTALL_DIR}/bram"
echo "Installing to ${TARGET}…"
install_binary "${BIN}" "${TARGET}"

# The dedicated hook binary rides beside the app: ~/.bram/bram-guard links to
# the sibling of the running executable, so it must land in the same dir.
# Older archives don't carry it; the app then falls back to itself as the
# hook target, so its absence is not fatal.
GUARD_BIN="$(find "${TMP}" -type f -name bram-guard | head -n 1)"
if [[ -n "${GUARD_BIN}" ]]; then
  GUARD_TARGET="${INSTALL_DIR}/bram-guard"
  install_binary "${GUARD_BIN}" "${GUARD_TARGET}"
  echo "Installed: ${GUARD_TARGET}"
fi

echo "Installed: ${TARGET}"

# PATH advice.
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo
    echo "Note: ${INSTALL_DIR} is not on your PATH."
    echo "Add this line to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

# Linux: note runtime deps required by Tauri's WebView.
if [[ "${OS}" == "Linux" ]]; then
  echo
  echo "Note: Bram dynamically links libwebkit2gtk-4.1 and friends."
  echo "On Ubuntu/Debian 22.04+, install runtime deps with:"
  echo "  sudo apt install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2"
  echo "WSL2 also requires WSLg (ships with Windows 11 / recent Windows 10)."
fi
