// DEV/TEST ONLY: a scripted OpenAI-compatible endpoint so the TrueForge <-> extension plumbing
// (streaming, MCP tool calls, approvals, fallback) can be exercised without an API key.
// Register it in TrueForge as a custom provider; it is never used in the demo.
//   node scripts/mock-model.mjs [port]           normal
//   MOCK_FAIL=401 node scripts/mock-model.mjs    always fails (to test fallback)
import http from "node:http";

const port = Number(process.argv[2] ?? 11500);
const FAIL = process.env.MOCK_FAIL;

function pickTool(tools, want) {
  const names = (tools ?? []).map((t) => t.function?.name).filter(Boolean);
  return names.find((n) => n === want) ?? names.find((n) => n.endsWith(want)) ?? null;
}

function plan(body) {
  const msgs = body.messages ?? [];
  const tools = body.tools ?? [];
  const toolMsgs = msgs.filter((m) => m.role === "tool");
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  if (!tools.length || !pickTool(tools, "read_file")) {
    // inline-edit style: return the selection with a comment added, in a fenced block
    const m = /<selection[^>]*>\n?([\s\S]*?)<\/selection>/.exec(userText);
    const sel = m ? m[1] : "pass";
    return { text: "Here is the edit:\n```python\n" + sel.replace(/\n?$/, "\n") + "    # edited by mock model\n```\n" };
  }
  const step = toolMsgs.length;
  const call = (name, args) => ({ tool: { name, args } });
  if (step === 0) {
    const n = pickTool(tools, "search_code");
    if (n) return call(n, { query: "readme project description" });
  }
  if (step <= 1) return call(pickTool(tools, "read_file"), { path: "README.md", start_line: 1, end_line: 5 });
  if (step === 2) {
    const read = String(toolMsgs[toolMsgs.length - 1].content ?? "");
    const line = (read.split("\n").find((l) => /^\s*\d+\|\s?\S/.test(l)) ?? "").replace(/^\s*\d+\|\s?/, "");
    return call(pickTool(tools, "propose_edit"), {
      path: "README.md",
      edits: [{ old_text: line, new_text: line + "\n\n> Edited by the mock model (plumbing test)." }],
      summary: "mock edit",
    });
  }
  return { text: "Files I changed: README.md (mock edit). Done." };
}

function chunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "mock-coder", object: "model" }] }));
      return;
    }
    if (FAIL) {
      res.writeHead(Number(FAIL), { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API key provided (mock)", type: "invalid_request_error" } }));
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    const p = plan(body);
    const id = "mock-" + Date.now();
    const model = body.model ?? "mock-coder";
    console.log(`[mock] ${body.stream ? "stream" : "json"} tools=${(body.tools ?? []).length} msgs=${(body.messages ?? []).length} ->`, p.tool ? `tool ${p.tool.name}` : "text");
    if (!body.stream) {
      const message = p.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_" + Date.now(), type: "function", function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] }
        : { role: "assistant", content: p.text };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ id, object: "chat.completion", model, choices: [{ index: 0, message, finish_reason: p.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(chunk(id, model, { role: "assistant", content: "" }));
    if (p.tool) {
      res.write(chunk(id, model, { tool_calls: [{ index: 0, id: "call_" + Date.now(), type: "function", function: { name: p.tool.name, arguments: "" } }] }));
      res.write(chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(p.tool.args) } }] }));
      res.write(chunk(id, model, {}, "tool_calls"));
    } else {
      for (const piece of p.text.match(/[\s\S]{1,12}/g)) {
        res.write(chunk(id, model, { content: piece }));
        await new Promise((r) => setTimeout(r, 15));
      }
      res.write(chunk(id, model, {}, "stop"));
    }
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  })
  .listen(port, "127.0.0.1", () => console.log(`[mock] OpenAI-compatible mock on http://127.0.0.1:${port}/v1 ${FAIL ? "(failing with " + FAIL + ")" : ""}`));
