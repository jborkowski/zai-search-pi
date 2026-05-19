#!/usr/bin/env bun
/**
 * Test that the exact production URL works with the same init+notify+call flow
 * the extension uses. Reproduces the path index.ts walks today.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SHAPES = [
  "https://api.z.ai/api/mcp/web_search_prime",        // missing /mcp (likely broken)
  "https://api.z.ai/api/mcp/web_search_prime/mcp",    // correct
  "https://api.z.ai/api/mcp/web_search_prime/mcp/mcp",// double /mcp
];

const raw = await readFile(join(homedir(), ".pi/agent/auth.json"), "utf-8");
const key = JSON.parse(raw).zai.key;

for (const url of SHAPES) {
  console.log(`\n── ${url}`);
  const init = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
  });
  console.log(`  initialize: ${init.status} ${init.statusText}, session=${init.headers.get("mcp-session-id") ?? "-"}`);
  const initText = (await init.text()).slice(0, 200).replace(/\n/g, " | ");
  console.log(`  body: ${initText}`);
}
