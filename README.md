# Forge Agent: a VS Code coding agent on TrueForge

Forge is an editor-native coding agent for Visual Studio Code. Its **agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge)**: the extension creates TrueForge sessions, streams turns, and answers TrueForge tool approvals. It never calls a model provider itself. The editor's capabilities are exposed to the agent as an **MCP server**, so the agent decides what to read, search, change and run.

**Starting point:** written from scratch (no fork). Built for the TrueFoundry Forge-a-thon, Techfest 2026-27.

| Capability | How Forge does it |
|---|---|
| Inline edit | Select code → `Ctrl+Alt+K` → instruction. The reply streams from TrueForge, becomes a proposal, and opens as a diff with **per-hunk Accept / Reject**. |
| Agent mode | Activity-bar panel. One request drives the `forge-coder` TrueForge agent through `repo_map`, `search_code`, `find_symbol`, `read_file`, `propose_edit`, `create_file`, `run_command` and `git_diff` until it is done. |
| Context assembly | `@file` / `@symbol` mentions plus automatic BM25 retrieval over symbol-level chunks, under a **token budget**. The panel shows every chosen snippet and *why* it was chosen. |
| Diff review | Every write tool requires TrueForge approval. The approval becomes a hunk-by-hunk review (panel cards + diff editor + CodeLens). Only accepted hunks are written. Undo with `Ctrl+Z` or **↶ Undo**. |
| Streaming & cancel | `model.message.delta` events stream into the panel and the editor. **■ Stop**, `Ctrl+Alt+X` or the progress-notification ✕ cancels the TrueForge session immediately. Edits are only ever applied whole-file-atomically after acceptance, so a cancel never leaves half an edit. |
| Resilience | Retry with exponential backoff on transient errors, then **automatic fallback** to the next configured model, with no user action. A hard timeout covers unreachable endpoints. The workspace is untouched on failure. |

## Architecture

```
 VS Code extension (Windows)                         TrueForge (local, npx)            Model(s)
 ┌─────────────────────────────┐  SDK: sessions,     ┌──────────────────────┐  OpenAI-  ┌────────────┐
 │ Agent panel / inline edit   │  streamed turns,    │ forge-coder agent    │  compat / │ any        │
 │ ForgeRunner (fallback chain)│──approvals────────▶ │ loop, approvals,     │──catalog─▶│ provider   │
 │ ReviewManager (hunks, undo) │◀─SSE events──────── │ subagents, compaction│           └────────────┘
 │ Context engine (BM25+budget)│                     │ deferred tool loading│
 │ MCP server :7465/mcp ◀──────┼──── MCP (HTTP) ─────┤                      │
 └─────────────────────────────┘                     └──────────────────────┘
```

* `src/core/runner.ts`: TrueForge client. It handles session creation (by agent name, or an inline spec for fallback models), streaming, approval rounds, cancellation, retry/backoff and model fallback.
* `src/core/tools.ts`: the MCP server (streamable HTTP, bearer-token protected) with the editor tools.
* `src/core/context.ts`: the index (symbol-aware chunks, BM25, role-balanced selection, budget).
* `src/vscode/review.ts`: per-hunk review, the diff editor, CodeLens, atomic apply, and undo.
* `agent/forge-coder.json`: **the TrueForge agent definition** (instructions, MCP attachment, approvals, subagents, compaction, deferred loading).

## Setup (from a clean clone)

Requirements: Node.js ≥ 22.14, VS Code ≥ 1.90, git. A Python environment is needed only to run the Flask tests.

### 1. Start TrueForge locally

```bash
npx @truefoundry/trueforge@latest
```

The UI and API come up at <http://localhost:8790>. Forge is tested with TrueForge **0.185.1** (`npx @truefoundry/trueforge@0.185.1` pins it). TrueForge blocks outbound calls to private hosts by default, so let it reach the extension's MCP server on loopback:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest
```

> **Windows with Smart App Control:** SAC blocks TrueForge's native SQLite module. Run TrueForge in WSL instead: put `networkingMode=mirrored` under `[wsl2]` in `%USERPROFILE%\.wslconfig` so Windows and WSL share `localhost`, then run `bash scripts/wsl-setup.sh` (installs Node 22) and `bash scripts/start-trueforge.sh` inside WSL.

### 2. Configure models (bring your own)

Use **any** provider. In the TrueForge UI go to *Settings → Models* and add a catalog provider, or a *custom* OpenAI-compatible endpoint (Groq, OpenRouter, vLLM, Ollama, a gateway…). Or do it from the example file:

```bash
cp forge.models.example.json forge.models.json      # edit: providers + fallback order
npm install && npm run compile
MISTRAL_API_KEY=... GEMINI_API_KEY=... GROQ_API_KEY=... node scripts/setup-trueforge.mjs
```

Any key you leave unset is skipped, and the chain uses the providers that are configured. The default chain is free: Mistral (free API plan) → Gemini (free tier) → Groq (free tier). Keys are read from environment variables and stored only inside TrueForge. **No key is ever committed**: `forge.models.json` is git-ignored.

The `models` array is the fallback chain (first = primary). You can also set it in VS Code with `"forgeAgent.models": ["mistral/mistral-medium", "google-gemini/gemini-flash-lite-latest", "groq/gpt-oss-120b"]`. To switch models, reorder that list.

### 3. Run the extension

```bash
npm install
npm run compile
code --extensionDevelopmentPath="$PWD" /path/to/flask
```

Alternatively, open this folder in VS Code and press **F5**. On start-up the extension:
1. indexes the workspace,
2. starts its MCP server on `localhost:7465`,
3. registers it in TrueForge as `vscode-editor` (with a bearer token kept in `~/.forge-agent/mcp-token`),
4. creates or updates the `forge-coder` agent from `agent/forge-coder.json`.

The status bar shows the active model chain.

## Using it

* **Inline edit:** select code (or just put the cursor in a function), press `Ctrl+Alt+K`, and type an instruction. Review the hunks with ✓/✗ in the Forge panel or with CodeLens in the diff, or use `Ctrl+Alt+Enter` (accept all) / `Ctrl+Alt+Backspace` (reject all).
* **Agent:** open the Forge view in the activity bar and describe the change. Use `@` to mention files or symbols. Watch the context card, the tool calls and the streamed reasoning. Review each proposed file hunk by hunk. *TrueForge session ↗* opens the run in the TrueForge UI.
* **Stop:** ■ Stop / `Ctrl+Alt+X` / Esc in the panel input. **Undo:** ↶ Undo, `Forge: Undo Last Change`, or `Ctrl+Z` in the file.

## Fixed tasks (pallets/flask 3.1.3)

```bash
git clone https://github.com/pallets/flask && cd flask && git checkout 3.1.3
python -m venv .venv && .venv/Scripts/pip install -e . pytest==8.4.2 asgiref python-dotenv
```

* **A:** select `get_debug_flag` in `src/flask/helpers.py`, press `Ctrl+Alt+K`, give the instruction, accept the hunks, then run `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`.
* **B:** in the panel, with no files named, give the `flask config` instruction, review and accept the hunks, then run `pytest tests/test_cli.py -q`.
* **C:** in TrueForge *Settings → Models*, set the primary provider's key to an invalid value (or its base URL to a dead port), then repeat A. Forge skips the other models of that provider and the next provider (Groq) takes over automatically. `git status` stays clean if the hunks are rejected.

## Tests

* `node scripts/headless.mjs <workspace> "<request>" --models a,b` runs the runner, MCP server and context engine without VS Code, auto-accepting hunks.
* `node scripts/headless.mjs <workspace> "<instruction>" --inline --file src/flask/helpers.py --symbol get_debug_flag --models a,b [--apply]` runs the inline-edit path (same prompt and proposal code as the extension). Hunks are printed and written only with `--apply`.
* `scripts/e2e/index.js` is an in-editor end-to-end suite (inline review, undo, agent tools, approvals, cancel, fallback, all-fail) run with `--extensionTestsPath`.
* `scripts/mock-model.mjs` is a dev-only scripted OpenAI-compatible endpoint used by those tests. It is never used in the demo.

## License

MIT, see [LICENSE](LICENSE). Dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `zod` (all MIT/Apache-compatible).
