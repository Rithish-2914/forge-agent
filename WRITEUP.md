# Forge Agent: an editor-native coding agent on TrueForge

> Fill the `TODO` items (team, video timestamps) after recording, then run the PDF export.

## 1. Team
TODO: members, college or employer, GitHub handles.

## 2. Starting point
From scratch, with no fork. The editor side (webview panel, diff rendering, hunk review, undo, keybindings) and the context engine are our own code. Dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `zod`.

## 3. Architecture on TrueForge
* **Client of a TrueForge agent.** The extension uses the TypeScript SDK to create sessions from the `forge-coder` agent (by name, or from its spec when a fallback model exists, so the model can be switched mid-session). It sends `user.message` turns and renders the turn's SSE stream: `model.message.delta`, `model.message`, `tool.response`, `thread.created`, compaction and `turn.done`. Nothing calls a model provider directly.
* **Editor capabilities as MCP tools.** The extension hosts a streamable-HTTP MCP server (`vscode-editor`, bearer-token protected, loopback only) with these tools:

    * `repo_map`, `search_code` (ranked BM25 or regex), `find_symbol` and `read_file` (read-only),
    * `propose_edit` (exact search/replace) and `create_file` (writes),
    * `run_command` (terminal) and `git_diff`.

    The agent decides what to read and change.

* **TrueForge approval drives the diff review.** `require_approval_for_tools: [propose_edit, create_file, run_command]`. When `tool.approval_required` arrives, the extension rebuilds the proposal from the tool arguments and shows it hunk by hunk. It then answers `user.tool_approval` with *allow* if at least one hunk was accepted (otherwise *deny* with a reason). When TrueForge executes the approved tool, the MCP handler writes **only the accepted hunks** and tells the agent exactly which hunks were rejected. Edits whose `old_text` does not exist in the file are auto-denied before review, which targets the failure "confidently edits a symbol that does not exist".
* **Harness features used, and why:**

    * **Deferred tool loading:** core tools (including `run_command`) are in `preload_tools`, while `list_dir` and `git_diff` stay deferred, which keeps the tool schemas out of every prompt.
    * **Compaction:** `input_tokens` trigger at 60k, so long agent runs on a repo larger than the window keep going.
    * **Dynamic subagents:** the root agent may delegate broad exploration and get back only paths and line ranges. Sub-agent threads render in the panel.
    * **Iteration limit:** 80.

## 4. How context is selected
* **Index:** every text file (skipping VCS/venv/build directories). Python is chunked per top-level def/class with decorators, long classes per method, and click commands are tagged as `built-in cli command "<name>"`. Docs are chunked per heading. Terms are identifiers split on snake/camel case with light stemming; path segments are indexed with a boost. Flask 3.1.3: 213 files, 34k lines, 1,414 chunks, indexed in about 160 ms.
* **Per request, under a token budget (default 8,000):**

    1. `@file` / `@symbol` mentions first (≤ 45% of the budget);
    2. a compact repo map of top-level symbols per file (≤ 15%);
    3. BM25 chunks re-scored with **file-level evidence**, a bigram bonus and a code-over-prose prior, then selected **role-balanced** (best implementation, test and docs chunks first, because a change usually spans all three). Limits are ≤ 3 chunks per file and docs ≤ 30% of the budget.
* **Visible:** the panel's *Context* card lists every snippet with its score, matched terms and token cost, plus the used/budget bar. After that the agent refines with `search_code`/`find_symbol`, which are visible as tool calls.
* **Inline edits:** the selection, ±60 lines around it, and definitions of identifiers used in the selection (≤ 1,500 tokens).
* **Trade-off:** BM25 needs no embeddings model, so it works with any or a free model, offline, and starts instantly. It misses pure synonyms, which the agent's own searches compensate for.

## 5. Model setup
Models are listed in fallback order:

* **Primary:** `google-gemini/gemini-flash-lite-latest` (free tier, catalog provider). It's first because the free tier allows `gemini-3-8-flash` only 20 requests per day, and one agent run needs dozens.
* **Second:** `google-gemini/gemini-3-8-flash`.
* **Third:** `groq/gpt-oss-120b` (free tier, custom OpenAI-compatible provider; its 8k tokens/min limit suits inline edits).
* **Error handling:** rate limits (per minute) wait and resume in the same session. Daily-quota, auth and model errors switch the session to the next model.
* **Optional local:** Ollama `qwen2.5-coder:7b` (in the example config; not used in the demo).

Approximate cost: ₹0 (free tiers). All models are configured in TrueForge. Users switch models by reordering the VS Code setting `forgeAgent.models` (or `forge.models.json`), or by adding a provider in TrueForge *Settings → Models*. During development we tested with a scripted mock endpoint, which is not used in the demo.

## 6. Scorecard
| Criterion | Video timestamp | Claim |
|---|---|---|
| A1 Inline edit | TODO | Diff rendered in editor; per-hunk accept/reject |
| A2 Agent mode | TODO | Task B: discovers and edits ≥ 3 files unprompted |
| A3 Streaming & cancellation | TODO | Tokens stream; Stop cancels immediately; workspace stays consistent |
| B1 Context assembly | TODO | Budgeted retrieval; context card shows files chosen and why |
| B2 Diff safety | TODO | Per-hunk review, nothing written before accept, working undo |
| B3 Resilience | TODO | Invalid key → automatic fallback to second model; git status clean |
| B4 TrueForge integration | TODO | MCP tools + approvals drive review; subagents/compaction/deferred loading visible in session |
| C1 Video | n/a | A, B, C in order, each verified on screen |
| C2 Write-up | n/a | This document |

## 7. Tools used

* Claude Code (AI coding assistant) helped write the extension.
* VS Code, Node.js 22/24, TypeScript 5.9, WSL Ubuntu (to run TrueForge, because Windows Smart App Control blocks its native SQLite module), git.

## 8. Known limitations and what we would do with another month
* Retrieval is lexical (BM25). With more time we would add an optional embedding re-ranker and call-graph expansion (callers/callees of the top chunks).
* Fallback before any progress starts a fresh session on the next model. After progress, Forge switches the **same** TrueForge session to the next model (`PATCH /sessions/{id}` with the forge-coder spec), so the history is kept and nothing is redone. Because TrueForge does not allow changing the agent of a session created by name, sessions are created from the forge-coder spec whenever a fallback model exists.
* Hunk review is shown in the panel and in a diff editor. CodeLens inside the diff needs `diffEditor.codeLens: true`. With more time we would add inline accept/reject widgets inside the real editor.
* `run_command` runs on the host shell after explicit approval. TrueForge's sandbox (Code Mode, skills) is not used yet.
* Only one workspace folder is supported.
