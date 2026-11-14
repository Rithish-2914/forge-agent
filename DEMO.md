# Demo recording script (≤ 4 minutes)

Record the screen at 1080p, with VS Code full screen and the Forge panel open on the right. Note each timestamp as you go and copy them into the write-up scorecard.

## Before recording
1. Start TrueForge in WSL: `bash scripts/start-trueforge.sh`. Wait for http://localhost:8790 to load.
2. Open `flask` (tag 3.1.3, clean `git status`) with the extension:
   `code --extensionDevelopmentPath="E:\techfest mumbai\forge-agent" "E:\techfest mumbai\flask"`
3. Check that the status bar shows the model chain (`gemini-flash-lite-latest → gemini-3-8-flash → gpt-oss-120b`).
4. In the integrated terminal, activate the venv: `.venv\Scripts\activate`.
5. Keep the TrueForge UI open in a browser tab.

## 0:00–0:15 Intro
"Forge: a VS Code agent whose loop runs on TrueForge. The editor's capabilities are MCP tools, and every write is reviewed hunk by hunk."

## 0:15–1:05 Task A: inline edit (A1, B2, A3)
1. Open `src/flask/helpers.py` and put the cursor in `get_debug_flag`.
2. Press `Ctrl+Alt+K` and type: *make FLASK_DEBUG=off, no, n and 0 all count as false, case-insensitive*.
3. Show the tokens streaming. Then show the diff that opens, **nothing written to disk yet**, and `git status` still clean.
4. Accept one hunk (✓) and reject a cosmetic one if there is one, to show per-hunk control.
5. In the terminal, run:
   `$env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False`
6. Click **↶ Undo**, show that the file is back to the original, then redo the inline edit and accept it (or keep the undo and say so).

## 1:05–2:45 Task B: agent mode (A2, B1, B4, A3)
1. In the Forge panel, paste the exact Task B instruction. Name no files.
2. Point at the **Context card**: the chosen files (cli.py commands, test_cli.py, docs/cli.rst), the reason for each, and the budget bar.
3. Show the agent's tool calls streaming: `search_code`, `read_file`, `find_symbol`.
4. For each `propose_edit`, review the hunks in the panel and diff, then accept. Approve `run_command` for pytest.
5. Optional, to show cancellation: press **■ Stop** once in the middle of a run, show `git status` is consistent, then start again. If you show it, give it its own timestamp in the scorecard.
6. When it finishes, run `pytest tests/test_cli.py -q` (all pass), then `flask --help`, and show `config` under *Commands*. It works without an app.
7. Run `git diff --stat` and show that 3 or more files changed (cli.py, test_cli.py, docs/cli.rst).
8. Click **TrueForge session ↗** and show the session in the TrueForge UI: tool calls, approvals, and the model used.

## 2:45–3:40 Task C: resilience (B3)
1. Run `git checkout -- .` to reset.
2. In the TrueForge UI, go to *Settings → Models → google-gemini* and change the API key to `invalid`. Save.
3. Repeat Task A (`Ctrl+Alt+K` on `get_debug_flag`).
4. Show the panel warning "Model … failed (API key not valid). Falling back to groq/gpt-oss-120b automatically" and the diff coming from the second model. The editor stays responsive throughout.
5. Reject all (`Ctrl+Alt+Backspace`), then run `git status` → clean.
6. Restore the real key in TrueForge. Do this after recording, off camera.

## 3:40–4:00 Close
Show the scorecard section of the write-up and the repo README. End.
