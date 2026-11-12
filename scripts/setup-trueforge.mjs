// Registers model providers (API keys from env vars), the vscode-editor MCP server and the
// forge-coder agent in a running local TrueForge. Safe to re-run.
//   GEMINI_API_KEY=... GROQ_API_KEY=... node scripts/setup-trueforge.mjs
// The extension does the MCP + agent part automatically on start-up; run this once for providers.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { setupTrueForge, getOrCreateToken } = require(path.join(extRoot, "out", "core", "setup.js"));

const trueforgeUrl = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const port = Number(process.env.FORGE_MCP_PORT ?? 7465);
try {
  const r = await setupTrueForge({
    trueforgeUrl,
    extRoot,
    mcpUrl: `http://localhost:${port}/mcp`,
    token: getOrCreateToken(),
    registerProviders: true,
  });
  console.log(`\nReady. Fallback chain: ${r.models.join(" -> ")}`);
  console.log(`Configured in TrueForge: ${r.available.join(", ") || "(none)"}`);
} catch (e) {
  console.error(`setup failed: ${e.message}`);
  process.exit(1);
}
