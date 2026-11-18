// Drives a TrueForge agent: session -> streamed turn -> tool approvals -> resumed turns, with
// cancellation, retry-with-backoff and automatic fallback across the configured models.
// The extension never calls a model provider directly; every token comes from TrueForge.
// The SDK ships ESM only in practice (its CJS build is broken), so load it with import().
let sdkPromise: Promise<any> | null = null;
export function loadSdk(): Promise<any> {
  sdkPromise ??= import("@truefoundry/trueforge-sdk");
  return sdkPromise;
}

export interface PendingToolCall {
  toolCallId: string;
  threadId: string;
  name: string;
  server?: string;
  args: any;
  rawArgs: string;
}

export interface ApprovalDecision {
  toolCallId: string;
  threadId: string;
  allow: boolean;
  reason?: string;
}

export interface RunCallbacks {
  onStatus(msg: string, level?: "info" | "warn" | "error"): void;
  onSession?(info: { sessionId: string; model: string; attempt: number; viaAgentName: boolean }): void;
  onDelta?(text: string, threadId: string): void;
  onReasoning?(text: string, threadId: string): void;
  onMessage?(text: string, threadId: string, messageId: string, streamed: boolean): void;
  onToolCall?(call: PendingToolCall): void;
  onToolResult?(r: { toolCallId: string; threadId: string; content: string }): void;
  onThread?(t: { threadId: string; title: string; parent?: string }): void;
  onCompaction?(phase: "started" | "finished", threadId: string): void;
  onApproval(pending: PendingToolCall[]): Promise<ApprovalDecision[]>;
}

export interface RunOptions {
  input: string;
  /** Agent registered in TrueForge (repo: agent/forge-coder.json). Used for the first model. */
  agentName?: string;
  /** Inline spec base used for fallback models (or always, when agentName is absent). */
  baseSpec: any;
  /** Ordered TrueForge model FQNs (`provider/model`). First is primary, rest are fallbacks. */
  models: string[];
  retries: number;
  firstTokenTimeoutMs: number;
  signal: AbortSignal;
  /** True once the user has accepted edits in this run: no silent restart on another model after that. */
  hasSideEffects(): boolean;
}

export interface RunResult {
  status: "done" | "cancelled" | "error";
  sessionId?: string;
  model?: string;
  text: string;
  error?: string;
  attempts: Array<{ model: string; error?: string }>;
}

type ErrKind = "auth" | "transient" | "quota" | "model" | "harness";

export class ModelFailure extends Error {
  constructor(message: string, public kind: ErrKind) {
    super(message);
  }
}

export function classifyError(msg: string): ErrKind {
  const m = msg.toLowerCase();
  if (/(401|403|unauthori[sz]ed|invalid.{0,20}(api)?.?key|key not valid|incorrect api key|api_key_invalid|authentication|permission denied|forbidden)/.test(m)) return "auth";
  // Exhausted daily/billing quota: waiting a minute will not help, so hand over to the next model.
  if (/(per.?day|daily|insufficient_quota)/.test(m)) return "quota";
  if (/(econnrefused|enotfound|eai_again|etimedout|econnreset|fetch failed|timed? ?out|socket|network|unreachable|getaddrinfo|429|rate.?limit|502|503|504|overloaded|temporarily)/.test(m))
    return "transient";
  return "model";
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

function contentToText(c: any): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? p?.refusal ?? "")).join("");
  return String(c?.text ?? "");
}

/** Streamed events arrive as raw JSON (snake_case); normalize keys to the SDK's camelCase. */
export function camelize(v: any): any {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, val] of Object.entries(v)) o[k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = camelize(val);
    return o;
  }
  return v;
}

const snakeify = (v: any): any =>
  Array.isArray(v)
    ? v.map(snakeify)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()), snakeify(x)]))
      : v;

/** Read a Server-Sent Events response and yield each JSON `data:` payload. */
async function* readSse(res: Response): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* keep-alive or partial noise */
      }
    }
  }
}

async function failText(res: Response, what: string, body?: unknown): Promise<Error> {
  const detail = (await res.text().catch(() => "")).slice(0, 400);
  if (process.env.FORGE_DEBUG) console.error(`[forge] ${what}`, JSON.stringify(body ?? null), "->", detail);
  return new Error(`${what} failed (${res.status}): ${detail}`);
}

/**
 * Turn streaming, parsed by hand instead of with the SDK's stream parser, which throws on event
 * variants newer than its schema and would abort a healthy turn. Unknown events pass through.
 *
 * - User messages start a turn: POST /sessions/{id}/turns (SSE).
 * - Approvals / tool responses answer the PAUSED turn (TrueForge >= 0.185):
 *   POST /sessions/{id}/turns/{turn}/events, then GET .../subscribe?after_event_id=... (SSE).
 *   Older servers took them as turn input; that path is the fallback.
 */
async function* streamTurn(
  baseUrl: string,
  sessionId: string,
  input: any[],
  signal: AbortSignal,
  paused?: { turnId: string; lastEventId?: string },
): AsyncGenerator<any> {
  const base = `${baseUrl.replace(/\/$/, "")}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`;
  const json = { "content-type": "application/json" };
  if (paused?.turnId && input.every((i) => i.type !== "user.message")) {
    const events = snakeify(input);
    const r = await fetch(`${base}/${encodeURIComponent(paused.turnId)}/events`, { method: "POST", headers: json, body: JSON.stringify({ events }), signal });
    if (r.ok) {
      const q = paused.lastEventId ? `?after_event_id=${encodeURIComponent(paused.lastEventId)}` : "";
      const sub = await fetch(`${base}/${encodeURIComponent(paused.turnId)}/subscribe${q}`, { headers: { accept: "text/event-stream" }, signal });
      if (!sub.ok || !sub.body) throw await failText(sub, "turn subscribe");
      yield* readSse(sub);
      return;
    }
    if (r.status !== 404 && r.status !== 405) throw await failText(r, "turn events", events);
    await r.text().catch(() => "");
  }
  const body = { input: snakeify(input), stream: true };
  const res = await fetch(base, { method: "POST", headers: { ...json, accept: "text/event-stream" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw await failText(res, "turn request", body);
  yield* readSse(res);
}
export class ForgeRunner {
  client: any;
  constructor(readonly baseUrl: string) {}

  async init(): Promise<this> {
    if (!this.client) {
      const { TrueForge } = await loadSdk();
      this.client = new TrueForge({ baseUrl: this.baseUrl, timeoutInSeconds: 3600, maxRetries: 0 });
    }
    return this;
  }

  /** Fast liveness check so a stopped TrueForge gives a clear message instead of a hang. */
  async ping(timeoutMs = 4000): Promise<string | null> {
    await this.init();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      await this.client.server.getCapabilities({ abortSignal: ac.signal, maxRetries: 0 } as any);
      return null;
    } catch (e: any) {
      return `TrueForge is not reachable at ${this.baseUrl} (${e?.message ?? e}). Start it with scripts/start-trueforge.sh (WSL) or \`npx @truefoundry/trueforge@latest\`.`;
    } finally {
      clearTimeout(t);
    }
  }

  async run(opts: RunOptions, cb: RunCallbacks): Promise<RunResult> {
    const attempts: RunResult["attempts"] = [];
    const down = await this.ping();
    if (down) {
      cb.onStatus(down, "error");
      return { status: "error", text: "", error: down, attempts };
    }
    const models = opts.models.length ? opts.models : [opts.baseSpec?.model?.name].filter(Boolean);
    let lastErr = "no model configured";
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      for (let attempt = 0; attempt <= opts.retries; attempt++) {
        if (opts.signal.aborted) return { status: "cancelled", text: "", attempts };
        try {
          const r = await this.runOnce(opts, cb, model, mi === 0 && attempt === 0 ? 1 : attempt + 1, mi === 0);
          attempts.push({ model });
          return { ...r, attempts };
        } catch (e: any) {
          if (opts.signal.aborted) return { status: "cancelled", text: "", attempts };
          const msg = String(e?.message ?? e);
          const kind: ErrKind = e instanceof ModelFailure ? e.kind : classifyError(msg);
          attempts.push({ model, error: msg });
          lastErr = msg;
          if ((e as any)?.final) {
            cb.onStatus(`All configured models failed (${shorten(msg)}). Stopped; the TrueForge session keeps the progress so far, and accepted changes stay (Undo is available).`, "error");
            return { status: "error", text: "", error: msg, attempts };
          }
          if (opts.hasSideEffects()) {
            cb.onStatus(`Model ${model} failed after edits were accepted: ${msg}. Stopping so nothing is redone silently; your accepted changes are kept (Undo is available).`, "error");
            return { status: "error", text: "", error: msg, attempts, model };
          }
          if (kind === "harness") {
            cb.onStatus(msg, "error");
            return { status: "error", text: "", error: msg, attempts };
          }
          // A refused connection / unknown host will not heal in a few seconds: no retry.
          const unreachable = /econnrefused|connection refused|bad port|enotfound|getaddrinfo|eai_again/i.test(msg);
          const canRetry = kind === "transient" && !unreachable && attempt < opts.retries;
          if (canRetry) {
            const delay = 1000 * 2 ** attempt;
            cb.onStatus(`Model ${model} failed (${shorten(msg)}). Retrying in ${delay / 1000}s (attempt ${attempt + 2}/${opts.retries + 1})…`, "warn");
            await sleep(delay, opts.signal);
            continue;
          }
          // A bad key or a dead endpoint fails every model of that provider: skip to another provider.
          if (kind === "auth" || unreachable) {
            const prov = model.split("/")[0];
            while (mi + 1 < models.length && models[mi + 1].split("/")[0] === prov) mi++;
          }
          if (mi + 1 < models.length)
            cb.onStatus(`Model ${model} failed (${shorten(msg)}). Falling back to ${models[mi + 1]} automatically.`, "warn");
          break;
        }
      }
    }
    const final = `All configured models failed. Last error: ${lastErr}. No files were changed.`;
    cb.onStatus(final, "error");
    return { status: "error", text: "", error: final, attempts };
  }

  private async runOnce(opts: RunOptions, cb: RunCallbacks, model: string, attempt: number, primary: boolean): Promise<Omit<RunResult, "attempts">> {
    // TrueForge refuses to change the agent of a session created by name, so when a fallback
    // model exists the session is created from the same forge-coder spec: the model can then be
    // switched mid-run (sessions.update) without losing history.
    const canHandover = opts.models.indexOf(model) + 1 < opts.models.length;
    const useName = !!opts.agentName && primary && !canHandover && (opts.baseSpec?.model?.name === model || !opts.baseSpec?.model?.name);
    const agent = useName ? { name: opts.agentName! } : { spec: { ...opts.baseSpec, model: { ...(opts.baseSpec?.model ?? {}), name: model } } };
    let session;
    try {
      const metadata = { client: "forge-agent-vscode", agent: opts.agentName ?? "inline" };
      session = (await this.client.sessions.create({ agent: agent as any, metadata: metadata as any }, { abortSignal: opts.signal })).data;
    } catch (e: any) {
      const body = e?.body ? JSON.stringify(e.body) : "";
      const msg = `${e?.message ?? e} ${body}`;
      // Unknown model/agent are configuration problems of THIS model: let the next one try.
      throw new ModelFailure(`could not create session: ${shorten(msg, 300)}`, /fetch failed|econnrefused/i.test(msg) ? "harness" : "model");
    }
    cb.onSession?.({ sessionId: session.id, model, attempt, viaAgentName: useName });

    const onAbort = () => {
      this.client.sessions.cancel(session.id).catch(() => {});
    };
    opts.signal.addEventListener("abort", onAbort);

    const toolCalls = new Map<string, PendingToolCall>();
    const deltaCalls = new Map<string, { id: string; name: string; args: string; threadId: string; toolInfo?: any }>();
    const streamedIds = new Set<string>();
    const registerCall = (id: string, name: string, server: string | undefined, rawArgs: string, threadId: string) => {
      if (!id || toolCalls.has(id)) return;
      let args: any = {};
      try {
        args = JSON.parse(rawArgs || "{}");
      } catch {
        args = { _unparsed: rawArgs };
      }
      const call: PendingToolCall = { toolCallId: id, threadId, name, server, args, rawArgs };
      // Deferred tool loading: the model calls the meta tool `call_tool`; unwrap it for display/review.
      if (call.name === "call_tool" && (args?.tool_name || args?.name)) {
        call.name = args.tool_name ?? args.name;
        call.server = args.server_name ?? args.server ?? call.server;
        call.args = args.arguments ?? args.body ?? args.input ?? args.args ?? {};
      }
      toolCalls.set(id, call);
      cb.onToolCall?.(call);
    };
    const flushDeltas = () => {
      for (const d of deltaCalls.values()) registerCall(d.id, d.toolInfo?.name ?? d.name, d.toolInfo?.serverName, d.args, d.threadId);
      deltaCalls.clear();
    };
    /** Backstop: look tool calls up from the persisted session events. */
    const resolveFromHistory = async (ids: string[]) => {
      try {
        const page: any = await this.client.sessions.listEvents(session.id, { limit: 100 } as any);
        const items: any[] = page?.data ?? page?.response?.data ?? [];
        for (const it of items) {
          const ev = camelize(it.event ?? it);
          if (ev.type !== "model.message") continue;
          for (const tc of ev.toolCalls ?? [])
            if (ids.includes(tc.id)) registerCall(tc.id, tc.toolInfo?.name ?? tc.function?.name, tc.toolInfo?.serverName, tc.function?.arguments ?? "", ev.threadId);
        }
      } catch {}
    };
    let finalText = "";
    let curModel = model;
    let input: any[] = [{ type: "user.message", content: opts.input }];
    // The turn currently paused for approvals (answers go to that turn, not a new one).
    let turnRef: { turnId: string; lastEventId?: string } | undefined;
    let pausedTurn: typeof turnRef;
    try {
      let resumes = 0;
      for (let round = 0; round < 200; round++) {
       try {
        const ac = new AbortController();
        const relay = () => ac.abort();
        opts.signal.addEventListener("abort", relay);
        let gotOutput = false;
        let timedOut = false;
        const timer = setTimeout(() => {
          if (!gotOutput) {
            timedOut = true;
            this.client.sessions.cancel(session.id).catch(() => {});
            ac.abort();
          }
        }, opts.firstTokenTimeoutMs);
        const pending: PendingToolCall[] = [];
        let done: any = null;
        let paused = false;
        try {
          const resumeOf = input.every((i) => i.type !== "user.message") ? pausedTurn : undefined;
          pausedTurn = undefined;
          for await (const rawEv of streamTurn(this.baseUrl, session.id, input, ac.signal, resumeOf)) {
            const ev = camelize(rawEv);
            if (ev.type === "turn.created" && ev.turnId) turnRef = { turnId: ev.turnId };
            if (turnRef && ev.id) turnRef.lastEventId = ev.id;
            switch (ev.type) {
              case "turn.update":
                // A turn waiting for approvals pauses and keeps the stream open: stop reading and answer.
                if (ev.state?.status === "paused") paused = true;
                break;
              case "model.message.delta": {
                gotOutput = true;
                if (ev.content) {
                  streamedIds.add(ev.id);
                  cb.onDelta?.(ev.content, ev.threadId);
                }
                if (ev.reasoningContent) cb.onReasoning?.(ev.reasoningContent, ev.threadId);
                // Tool calls stream as fragments keyed by (message id, index); accumulate them.
                for (const tc of ev.toolCalls ?? []) {
                  const k = `${ev.id}:${tc.index ?? 0}`;
                  const acc: { id: string; name: string; args: string; threadId: string; toolInfo?: any } = deltaCalls.get(k) ?? { id: "", name: "", args: "", threadId: ev.threadId };
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.name += tc.function.name;
                  if (tc.function?.arguments) acc.args += tc.function.arguments;
                  if (tc.toolInfo) acc.toolInfo = tc.toolInfo;
                  deltaCalls.set(k, acc);
                }
                break;
              }
              case "model.message": {
                gotOutput = true;
                const t = contentToText(ev.content);
                if (ev.threadId === "main" && t) finalText = t;
                cb.onMessage?.(t, ev.threadId, ev.id, streamedIds.has(ev.id));
                for (const tc of ev.toolCalls ?? []) registerCall(tc.id, tc.toolInfo?.name ?? tc.function?.name, tc.toolInfo?.serverName, tc.function?.arguments ?? "", ev.threadId);
                break;
              }
              case "tool.response":
                gotOutput = true;
                flushDeltas();
                cb.onToolResult?.({ toolCallId: ev.toolCallId, threadId: ev.threadId, content: String(ev.content ?? "") });
                break;
              case "tool.approval_required":
                gotOutput = true;
                flushDeltas();
                for (const ref of ev.toolCalls ?? []) {
                  const c = toolCalls.get(ref.id) ?? { toolCallId: ref.id, threadId: ev.threadId, name: "unknown", args: {}, rawArgs: "" };
                  pending.push({ ...c, threadId: ev.threadId });
                }
                break;
              case "tool.response_required":
                for (const ref of ev.toolCalls ?? []) pending.push({ toolCallId: ref.id, threadId: ev.threadId, name: "__response__", args: {}, rawArgs: "" });
                break;
              case "thread.created":
                cb.onThread?.({ threadId: ev.threadId, title: ev.title, parent: ev.parent?.threadId });
                break;
              case "thread.context_compaction.started":
              case "thread.context_compaction_started":
                cb.onCompaction?.("started", ev.threadId);
                break;
              case "thread.context_compaction.finished":
              case "thread.context_compaction_finished":
                cb.onCompaction?.("finished", ev.threadId);
                break;
              case "turn.done":
                done = ev.state;
                break;
              default:
                if (typeof ev.type === "string" && ev.type.includes("compaction"))
                  cb.onCompaction?.(ev.type.includes("start") ? "started" : "finished", ev.threadId);
            }
            if (done || (paused && pending.length)) break;
          }
          if (paused && turnRef) pausedTurn = { ...turnRef };
        } catch (e: any) {
          if (opts.signal.aborted) return { status: "cancelled", sessionId: session.id, model: curModel, text: finalText };
          if (timedOut) throw new ModelFailure(`no response from the model within ${Math.round(opts.firstTokenTimeoutMs / 1000)}s`, "transient");
          { const k = classifyError(String(e?.message ?? e)); throw new ModelFailure(`stream failed: ${e?.message ?? e}`, k === "auth" || k === "quota" ? k : "transient"); }
        } finally {
          clearTimeout(timer);
          opts.signal.removeEventListener("abort", relay);
        }
        if (opts.signal.aborted) return { status: "cancelled", sessionId: session.id, model: curModel, text: finalText };
        if (timedOut) throw new ModelFailure(`no response from the model within ${Math.round(opts.firstTokenTimeoutMs / 1000)}s`, "transient");
        // A turn that pauses for approval ends with turn.done{status:"done", requiredActions:[...]}.
        if (done && !pending.length && Array.isArray(done.requiredActions)) {
          for (const ra of done.requiredActions)
            for (const ref of ra.toolCalls ?? []) {
              const c = toolCalls.get(ref.id) ?? { toolCallId: ref.id, threadId: ra.threadId, name: "unknown", args: {}, rawArgs: "" };
              pending.push(ra.type === "tool.response_required" ? { ...c, name: "__response__" } : { ...c, threadId: ra.threadId ?? c.threadId });
            }
        }
        if (pending.length) done = null;
        if (done) {
          if (done.status === "done") return { status: "done", sessionId: session.id, model: curModel, text: finalText };
          if (done.status === "cancelled") return { status: "cancelled", sessionId: session.id, model: curModel, text: finalText };
          const msg = String(done.message ?? "turn failed");
          throw new ModelFailure(msg, classifyError(msg));
        }
        if (!pending.length) {
          // Stream closed without a terminal event: ask the server what happened.
          const turns = await this.client.sessions.listTurns(session.id, {} as any).catch(() => null);
          const last: any = (turns as any)?.data?.[0] ?? (turns as any)?.response?.data?.[0];
          const st = last?.state?.status;
          if (st === "done") return { status: "done", sessionId: session.id, model: curModel, text: finalText };
          if (st === "error") throw new ModelFailure(String(last.state.message ?? "turn failed"), classifyError(String(last.state.message ?? "")));
          throw new ModelFailure("stream ended unexpectedly", "transient");
        }
        flushDeltas();
        const unknown = pending.filter((p) => p.name === "unknown" && !toolCalls.has(p.toolCallId)).map((p) => p.toolCallId);
        if (unknown.length) await resolveFromHistory(unknown);
        for (let i = 0; i < pending.length; i++) {
          const known = toolCalls.get(pending[i].toolCallId);
          if (known && pending[i].name !== "__response__") pending[i] = { ...known, threadId: pending[i].threadId || known.threadId };
        }
        const responses = pending.filter((p) => p.name === "__response__");
        const approvals = pending.filter((p) => p.name !== "__response__");
        if (responses.length) {
          input = responses.map((p) => ({ type: "user.tool_response", threadId: p.threadId, toolCallId: p.toolCallId, content: "The editor cannot answer questions mid-run; make a reasonable assumption and continue." }));
          continue;
        }
        resumes = 0; // this round made progress
        const decisions = await cb.onApproval(approvals);
        if (opts.signal.aborted) return { status: "cancelled", sessionId: session.id, model: curModel, text: finalText };
        input = decisions.map((d) => ({
          type: "user.tool_approval",
          threadId: d.threadId,
          toolCallId: d.toolCallId,
          approval: d.allow ? { status: "allow" } : { status: "deny", reason: d.reason ?? "rejected by the user" },
        }));
       } catch (e: any) {
        // Rate limits / overload after the agent already made progress: wait and resume the SAME
        // TrueForge session (its history is kept) instead of restarting the task from scratch.
        const msg = String(e?.message ?? e);
        const kind = e instanceof ModelFailure ? e.kind : classifyError(msg);
        if (opts.signal.aborted || toolCalls.size === 0 || kind === "harness") throw e;
        // Per-minute free-tier limits clear by themselves: keep waiting and resuming (slow but free).
        const perMinute = /per.?minute|perminute/i.test(msg);
        const maxResumes = perMinute ? 40 : opts.retries + 3;
        const exhausted = kind !== "transient" || resumes >= maxResumes;
        if (exhausted) {
          // The agent already made progress: switch THIS session to the next configured model
          // (TrueForge keeps the history), so the fallback continues the task instead of redoing it.
          const next = opts.models[opts.models.indexOf(curModel) + 1];
          if (!next) {
            // Every model was tried inside this session: stop here rather than redo the work in a fresh one.
            const f = new ModelFailure(`${msg} (last model in the chain; the session keeps all progress)`, kind);
            (f as any).final = true;
            throw f;
          }
          try {
            const spec = { ...opts.baseSpec, model: { ...(opts.baseSpec?.model ?? {}), name: next } };
            await this.client.sessions.update(session.id, { agent: { spec } as any }, { abortSignal: opts.signal });
          } catch (pe: any) {
            throw new ModelFailure(`${msg} (and could not switch the session to ${next}: ${pe?.message ?? pe})`, kind);
          }
          cb.onStatus(`Model ${curModel} failed (${shorten(msg, 90)}). Switched this TrueForge session to ${next} automatically; it continues with the full history.`, "warn");
          cb.onSession?.({ sessionId: session.id, model: next, attempt: 1, viaAgentName: false });
          curModel = next;
          resumes = 0;
          input = [{ type: "user.message", content: "The previous model stopped because of a provider error. Continue the task from exactly where it stopped. Do not redo steps that already succeeded." }];
          continue;
        }
        resumes++;
        const hinted = /retry in ([\d.]+)s/i.exec(msg) ?? /"retryDelay":\s*"(\d+)s"/.exec(msg);
        // Wait only as long as the provider asks (Gemini says "retry in Ns"), not a fixed minute.
        const waitS = perMinute
          ? (hinted ? Math.min(65, Math.max(3, Math.ceil(Number(hinted[1])) + 1)) : Math.min(60, 15 * resumes))
          : Math.min(90, Math.max(hinted ? Math.ceil(Number(hinted[1])) + 1 : 0, 10 * 2 ** (resumes - 1)));
        cb.onStatus(perMinute
          ? `Free-tier per-minute limit on ${curModel}. Waiting ${waitS}s (as the provider asked), then resuming the same TrueForge session; progress is kept.`
          : `Model ${curModel} is rate-limited/overloaded (${shorten(msg, 90)}). Resuming the same TrueForge session in ${waitS}s (${resumes}/${maxResumes}); progress is kept.`, "warn");
        await sleep(waitS * 1000, opts.signal);
        if (opts.signal.aborted) return { status: "cancelled", sessionId: session.id, model: curModel, text: finalText };
        input = [{ type: "user.message", content: "Continue the task from exactly where you stopped. Do not redo steps that already succeeded." }];
       }
      }
      throw new ModelFailure("too many approval rounds", "model");
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

function shorten(s: string, n = 160) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
