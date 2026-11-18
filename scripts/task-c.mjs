// Task C helper: make the primary model provider unreachable in TrueForge, and restore it.
//   node scripts/task-c.mjs break      point the provider's base_url at a dead local port
//   node scripts/task-c.mjs restore    put the original base_url back
//   node scripts/task-c.mjs status
// The stored API key is never read or changed: TrueForge returns it redacted, and sending the
// redacted value back keeps the stored key. Only `base_url` is changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TF = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const PROVIDER = process.env.TASK_C_PROVIDER ?? "google-gemini";
const DEAD = "http://127.0.0.1:9/v1beta";
const saved = path.join(os.homedir(), ".forge-agent", `task-c-${PROVIDER}.json`);
const cmd = process.argv[2] ?? "status";

const list = await (await fetch(`${TF}/api/v1/settings/model-providers`)).json();
const entry = (list.data ?? list).find((p) => {
  const m = p.manifest ?? p;
  return m.name === PROVIDER || (!m.name && m.type === PROVIDER);
});
if (!entry) {
  console.error(`provider ${PROVIDER} is not configured in TrueForge`);
  process.exit(1);
}
const manifest = structuredClone(entry.manifest ?? entry);

async function put(m) {
  const r = await fetch(`${TF}/api/v1/settings/model-providers`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: m }),
  });
  if (!r.ok) throw new Error(`PUT failed (${r.status}): ${await r.text()}`);
}

if (cmd === "break") {
  if (manifest.base_url !== DEAD) {
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, JSON.stringify({ base_url: manifest.base_url ?? null }));
  }
  await put({ ...manifest, base_url: DEAD });
  console.log(`${PROVIDER}: endpoint is now UNREACHABLE (${DEAD}). Undo with: node scripts/task-c.mjs restore`);
} else if (cmd === "restore") {
  const prev = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, "utf8")).base_url : null;
  const m = { ...manifest };
  if (prev) m.base_url = prev;
  else delete m.base_url;
  await put(m);
  console.log(`${PROVIDER}: endpoint restored (${prev ?? "default"})`);
} else {
  console.log(`${PROVIDER}: base_url = ${manifest.base_url ?? "(default)"}${manifest.base_url === DEAD ? "  <- UNREACHABLE (Task C mode)" : ""}`);
}
