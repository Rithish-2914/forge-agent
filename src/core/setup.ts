// Registers everything Forge needs in a local TrueForge: model providers (keys from env vars),
// the vscode-editor MCP server (with a bearer token), and the forge-coder agent definition.
// Idempotent: uses PUT create-or-update everywhere.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { MCP_SERVER_NAME } from "./tools";

export interface ModelsFile {
  providers?: any[];
  models?: string[];
}

export function tokenFile() {
  return path.join(os.homedir(), ".forge-agent", "mcp-token");
}

export function getOrCreateToken(): string {
  const f = tokenFile();
  try {
    const t = fs.readFileSync(f, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

export function readModelsFile(extRoot: string): { file: string; data: ModelsFile } | null {
  for (const name of ["forge.models.json", "forge.models.example.json"]) {
    const f = path.join(extRoot, name);
    if (fs.existsSync(f)) return { file: f, data: JSON.parse(fs.readFileSync(f, "utf8")) };
  }
  return null;
}

async function http(base: string, method: string, p: string, body?: any) {
  const r = await fetch(base.replace(/\/$/, "") + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${text.slice(0, 400)}`);
  return json;
}

export interface SetupOptions {
  trueforgeUrl: string;
  extRoot: string;
  mcpUrl: string;
  token: string;
  env?: NodeJS.ProcessEnv;
  /** Only register providers when asked (the extension skips this; keys live in TrueForge). */
  registerProviders?: boolean;
  /** Ordered model chain from the VS Code setting `forgeAgent.models` (overrides the file). */
  preferredModels?: string[];
  log?: (s: string) => void;
}

export async function setupTrueForge(o: SetupOptions) {
  const log = o.log ?? console.log;
  const env = o.env ?? process.env;
  const mf = readModelsFile(o.extRoot);

  if (o.registerProviders && mf?.data.providers) {
    for (const p of mf.data.providers) {
      const { api_key_env, api_key, ...rest } = p;
      const key = api_key ?? (api_key_env ? env[api_key_env] : undefined);
      if (!key) {
        log(`skip provider ${p.name ?? p.type}: set ${api_key_env} to register it`);
        continue;
      }
      // Well-known types are named after their type and reject a `name` field; only `custom` has one.
      const { name: _ignored, ...base } = rest;
      const manifest: any = { ...base, auth: { api_key: key } };
      if (p.type === "custom") manifest.name = p.name;
      const label = p.type === "custom" ? p.name : p.type;
      await http(o.trueforgeUrl, "PUT", "/api/v1/settings/model-providers", { manifest });
      log(`model provider ${label}: ok (${(p.models ?? []).map((m: any) => m.name).join(", ")})`);
    }
  }

  await http(o.trueforgeUrl, "PUT", "/api/v1/settings/mcp-servers", {
    manifest: {
      type: "remote",
      name: MCP_SERVER_NAME,
      url: o.mcpUrl,
      description:
        "The user's VS Code workspace: repo map, ranked code search, symbol lookup, file reading, reviewed edits (propose_edit/create_file), and terminal commands.",
      auth: { type: "header", headers: { Authorization: `Bearer ${o.token}` } },
    },
  });
  log(`MCP server ${MCP_SERVER_NAME}: ok (${o.mcpUrl})`);

  const agentDef = JSON.parse(fs.readFileSync(path.join(o.extRoot, "agent", "forge-coder.json"), "utf8"));
  // The fallback chain: explicit setting > forge.models.json > agent file. Only models that
  // TrueForge has configured are usable; the agent is saved with the first usable one.
  const available = await listConfiguredModels(o.trueforgeUrl);
  const wanted = (o.preferredModels?.length ? o.preferredModels : mf?.data.models ?? []).concat(agentDef.manifest.model.name);
  const chain = [...new Set(wanted)].filter((m) => available.includes(m));
  if (!chain.length) {
    if (!available.length)
      throw new Error(`TrueForge has no models configured. Open ${o.trueforgeUrl} → Settings → Models and add one (any provider, or a custom OpenAI-compatible endpoint), or run scripts/setup-trueforge.mjs with your API key env vars.`);
    chain.push(available[0]);
    log(`none of [${wanted.join(", ")}] is configured in TrueForge; using ${available[0]}`);
  }
  const missing = wanted.filter((m) => !available.includes(m));
  if (missing.length) log(`not configured in TrueForge (skipped): ${[...new Set(missing)].join(", ")}`);
  agentDef.manifest.model.name = chain[0];
  const list = await http(o.trueforgeUrl, "GET", "/api/v1/agents?limit=100");
  const existing = (list?.data ?? []).find((a: any) => a.name === agentDef.name);
  if (existing) {
    await http(o.trueforgeUrl, "PUT", `/api/v1/agents/${existing.id}`, { description: agentDef.description, manifest: agentDef.manifest });
    log(`agent ${agentDef.name}: updated (model ${agentDef.manifest.model.name})`);
  } else {
    await http(o.trueforgeUrl, "POST", "/api/v1/agents", agentDef);
    log(`agent ${agentDef.name}: created (model ${agentDef.manifest.model.name})`);
  }
  return { agentDef, models: chain, available };
}

/** Model names TrueForge actually has configured (Settings → Models), e.g. "groq/llama-3-3-70b". */
export async function listConfiguredModels(trueforgeUrl: string): Promise<string[]> {
  try {
    const j = await http(trueforgeUrl, "GET", "/api/v1/models");
    const arr = j?.data ?? j?.models ?? [];
    return arr.map((m: any) => m.name ?? m.fqn ?? m.id).filter(Boolean);
  } catch {
    return [];
  }
}
