#!/usr/bin/env bash
# One-time setup inside WSL Ubuntu: Node 22 (for TrueForge) + Ollama (local fallback model).
set -e
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  V=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys;print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))')
  echo "Installing Node $V"
  curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz" -o /tmp/node.tar.xz
  mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
fi
node -v
