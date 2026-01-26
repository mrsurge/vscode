#!/bin/sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

export PATH="/data/data/com.termux/files/usr/opt/nodejs-22/bin:$PATH"
export CC=clang
export CXX=clang++
export CXXFLAGS="-std=c++20"

cd "$ROOT_DIR"

npm ci --ignore-scripts
npm run gulp -- editor-distro

# Build TE2 language contributions + language-service workers (te2-lang/).
# Without this, the iframe editor will fall back to plaintext-only and /ui/nc may not mount.
/data/data/com.termux/files/usr/opt/nodejs-22/bin/node ../../scripts/build_monaco_language_workers.mjs
