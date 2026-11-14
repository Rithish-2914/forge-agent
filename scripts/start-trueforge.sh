#!/usr/bin/env bash
# Start TrueForge in local (standalone) mode inside WSL. UI + API on http://localhost:8790.
# With networkingMode=mirrored in %USERPROFILE%\.wslconfig, Windows and WSL share localhost,
# so VS Code (Windows) reaches TrueForge and TrueForge reaches the extension's MCP server.
export PORT="${PORT:-8790}"
# TrueForge blocks outbound calls to private hosts (SSRF guard). Allow ONLY loopback, so it can
# reach the extension's MCP server (and an optional local Ollama) on this machine.
export OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'
# Pinned to the version Forge is tested with; override with TRUEFORGE_VERSION=latest.
# (0.185 changed how approvals resume a paused turn: they now go to /turns/{id}/events.)
exec npx -y "@truefoundry/trueforge@${TRUEFORGE_VERSION:-0.185.1}"
