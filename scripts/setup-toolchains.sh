#!/usr/bin/env bash
# setup-toolchains.sh — Idempotent installer for Nubyone build toolchain.
#
# Installs: Go 1.25.0 (plain builds), Go 1.26.2 (garble), garble v0.16.0, UPX
# Works as root or non-root. Installs to $HOME/sdk/, $HOME/go/bin/, $HOME/bin/
# Safe to re-run — skips anything already present.
#
# Usage:
#   bash scripts/setup-toolchains.sh                   (normal dev/VPS use)
#   bash /opt/nubyone/scripts/setup-toolchains.sh   (deployed VPS via API)

set -euo pipefail

GO_PLAIN="1.25.0"
GO_GARBLE="1.26.2"
GARBLE_VERSION="v0.16.0"
UPX_VERSION="4.2.4"

SDK_DIR="${HOME}/sdk"
GOPATH_DIR="${HOME}/go"
BIN_DIR="${HOME}/bin"

mkdir -p "${SDK_DIR}" "${GOPATH_DIR}/bin" "${BIN_DIR}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
RAW_ARCH=$(uname -m)
case "${RAW_ARCH}" in
  x86_64)          ARCH="amd64" ;;
  aarch64|arm64)   ARCH="arm64" ;;
  *) echo "[toolchain] Unsupported arch: ${RAW_ARCH}" >&2; exit 1 ;;
esac

log()  { echo "[toolchain] $*"; }
warn() { echo "[toolchain] WARNING: $*" >&2; }

install_go_sdk() {
  local ver="$1"
  local dir="${SDK_DIR}/go${ver}"
  if [[ -x "${dir}/bin/go" ]]; then
    log "Go ${ver} already installed → ${dir}"
    return 0
  fi
  log "Downloading Go ${ver} (${OS}-${ARCH})..."
  local url="https://go.dev/dl/go${ver}.${OS}-${ARCH}.tar.gz"
  local tmp="/tmp/go${ver}-$$.tar.gz"
  if ! curl -fsSL --retry 3 --connect-timeout 30 "${url}" -o "${tmp}"; then
    warn "Failed to download Go ${ver} from ${url}"
    rm -f "${tmp}"
    return 1
  fi
  tar -C "${SDK_DIR}" -xzf "${tmp}"
  # go tarball always extracts as "go/" — rename to versioned dir
  if [[ -d "${SDK_DIR}/go" ]]; then
    mv "${SDK_DIR}/go" "${dir}"
  fi
  rm -f "${tmp}"
  if [[ -x "${dir}/bin/go" ]]; then
    log "Go ${ver} installed → ${dir}"
  else
    warn "Go ${ver} extraction may have failed — ${dir}/bin/go not found"
    return 1
  fi
}

install_garble() {
  local garble_bin="${GOPATH_DIR}/bin/garble"
  if [[ -x "${garble_bin}" ]]; then
    log "garble already installed → ${garble_bin}"
    return 0
  fi
  local go_bin="${SDK_DIR}/go${GO_GARBLE}/bin/go"
  if [[ ! -x "${go_bin}" ]]; then
    warn "Go ${GO_GARBLE} not available — skipping garble install"
    return 1
  fi
  log "Building garble ${GARBLE_VERSION} with Go ${GO_GARBLE}..."
  if GOPATH="${GOPATH_DIR}" \
     GOROOT="${SDK_DIR}/go${GO_GARBLE}" \
     GOTELEMETRY=off \
     GONOSUMDB="*" \
     GOTOOLCHAIN=local \
     PATH="${SDK_DIR}/go${GO_GARBLE}/bin:${PATH}" \
       "${go_bin}" install "mvdan.cc/garble@${GARBLE_VERSION}" 2>&1; then
    log "garble installed → ${garble_bin}"
  else
    warn "garble install failed (builds will work without obfuscation)"
    return 1
  fi
}

install_upx() {
  # Check system UPX first
  if command -v upx &>/dev/null; then
    log "upx already available: $(command -v upx)"
    return 0
  fi
  local upx_bin="${BIN_DIR}/upx"
  if [[ -x "${upx_bin}" ]]; then
    log "upx already installed → ${upx_bin}"
    return 0
  fi
  if [[ "${OS}" != "linux" ]]; then
    log "UPX: skipping on ${OS} (Linux only)"
    return 0
  fi
  # Try apt-get first (root context on VPS)
  if command -v apt-get &>/dev/null && [[ ${EUID:-1} -eq 0 ]]; then
    if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq upx-ucl 2>/dev/null; then
      log "upx installed via apt"
      return 0
    fi
  fi
  # Manual install from GitHub releases
  log "Downloading UPX ${UPX_VERSION}..."
  local upx_url="https://github.com/upx/upx/releases/download/v${UPX_VERSION}/upx-${UPX_VERSION}-${ARCH}_linux.tar.xz"
  local tmp_dir="/tmp/upx-install-$$"
  mkdir -p "${tmp_dir}"
  if curl -fsSL --retry 3 --connect-timeout 30 "${upx_url}" | tar -xJ -C "${tmp_dir}" 2>/dev/null; then
    local found
    found=$(find "${tmp_dir}" -name "upx" -type f 2>/dev/null | head -1)
    if [[ -n "${found}" ]]; then
      cp "${found}" "${upx_bin}"
      chmod +x "${upx_bin}"
      rm -rf "${tmp_dir}"
      log "upx installed → ${upx_bin}"
      return 0
    fi
  fi
  rm -rf "${tmp_dir}"
  warn "UPX install failed — binaries will ship uncompressed (still fully functional)"
  return 0
}


log "Starting toolchain setup (HOME=${HOME}, OS=${OS}, ARCH=${ARCH})"

FAILURES=0
install_go_sdk "${GO_PLAIN}"  || FAILURES=$((FAILURES+1))
install_go_sdk "${GO_GARBLE}" || FAILURES=$((FAILURES+1))
install_garble                || true   # optional — warn only
install_upx                   || true   # optional — warn only

if [[ $FAILURES -gt 0 ]]; then
  warn "Some required SDKs failed to install (network issue?). Plain builds need Go ${GO_PLAIN}."
  exit 1
fi

log "Setup complete."
log "  Plain SDK  → ${SDK_DIR}/go${GO_PLAIN}/bin/go"
log "  Garble SDK → ${SDK_DIR}/go${GO_GARBLE}/bin/go"
[[ -x "${GOPATH_DIR}/bin/garble" ]] && log "  garble     → ${GOPATH_DIR}/bin/garble" || log "  garble     → not installed (obfuscated builds unavailable)"
command -v upx &>/dev/null && log "  upx        → $(command -v upx)" || [[ -x "${BIN_DIR}/upx" ]] && log "  upx        → ${BIN_DIR}/upx" || log "  upx        → not installed (binaries uncompressed)"
