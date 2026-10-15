#!/usr/bin/env bash
# Vercel build: install the pinned Compact compiler, ship its binary to the function (vendor/),
# and build the static site with live analysis pointing at this same deployment.
set -euo pipefail
COMPACT_VERSION="${COMPACT_VERSION:-0.31.1}"

if ! command -v xz >/dev/null 2>&1; then
  # The installer unpacks a .tar.xz; the build image may lack xz.
  (command -v dnf >/dev/null && dnf install -y xz) || (command -v yum >/dev/null && yum install -y xz) || true
fi
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
compact update "$COMPACT_VERSION"
compact compile --version

mkdir -p vendor
cp "$HOME/.compact/versions/$COMPACT_VERSION/x86_64-unknown-linux-musl/compactc.bin" vendor/compactc.bin
chmod +x vendor/compactc.bin

XRAY_API=same-origin npx tsx scripts/build-site.ts site
