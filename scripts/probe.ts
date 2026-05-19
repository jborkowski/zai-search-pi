#!/usr/bin/env bun
/**
 * Probe Z AI MCP endpoints to capture the exact raw response.
 *
 * Reads the key from ~/.pi/agent/auth.json and prints:
 *   - key shape (length + first/last 2 chars only)
 *   - initialize response (status, headers, body excerpt)
 *   - tools/call response (status, headers, body excerpt)
 *
 * Never prints the full API key. Safe to share output for debugging.
 *
 *   bun run scripts/probe.ts
 *   bun run scripts/probe.ts --service web_reader
 *   bun run scripts/probe.ts --service zread
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICES = {
  web_search_prime: {
    url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
    tool: "web_search_prime",
    args: { search_query: "ping", location: "us" },
  },
  web_reader: {
    url: "https://api.z.ai/api/mcp/web_reader/mcp",
    tool: "webReader",
    args: { url: "https://example.com", return_format: "text", timeout: 15 },
  },
  zread: {
    url: "https://api.z.ai/api/mcp/zread/mcp",
    tool: "search_doc",
    args: { repo_name: "vitejs/vite", query: "HMR", language: "en" },
  },
} as const;

function redactKey(key: string): string {
  if (key.length <= 6) return `<${key.length} chars>`;
  return `${key.slice(0, 4)}…${key.slice(-2)} (len=${key.length})`;
}

function redactBody(body: string, key: string): string {
  return body.split(key).join("<API_KEY>");
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k.toLowerCase() === "authorization") out[k] = "Bearer <redacted>";
    else out[k] = v;
  });
  return out;
}

async function readKey(): Promise<string> {
  const path = join(homedir(), ".pi/agent/auth.json");
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as { zai?: { key?: string } };
  const key = parsed.zai?.key;
  if (!key) throw new Error(`No zai.key in ${path}`);
  return key;
}

async function probe(serviceName: keyof typeof SERVICES, key: string) {
  const svc = SERVICES[serviceName];
  console.log(`\n── ${serviceName} ── ${svc.url}\n`);

  // 1. initialize
  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "zai-probe", version: "1.0.0" },
    },
  });

  const initRes = await fetch(svc.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: initBody,
  });

  const initText = await initRes.text();
  console.log(`initialize → ${initRes.status} ${initRes.statusText}`);
  console.log("  headers:", JSON.stringify(headersToObject(initRes.headers), null, 2));
  console.log("  body excerpt:", redactBody(initText.slice(0, 600), key));
  const sessionId = initRes.headers.get("mcp-session-id");
  console.log("  mcp-session-id:", sessionId ?? "(none)");

  // 2. notifications/initialized
  const notifyHeaders: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (sessionId) notifyHeaders["mcp-session-id"] = sessionId;
  const notifyRes = await fetch(svc.url, {
    method: "POST",
    headers: notifyHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  console.log(`\nnotifications/initialized → ${notifyRes.status} ${notifyRes.statusText}`);

  // 3. tools/call
  const callHeaders: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) callHeaders["mcp-session-id"] = sessionId;
  const callRes = await fetch(svc.url, {
    method: "POST",
    headers: callHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: svc.tool, arguments: svc.args },
    }),
  });
  const callText = await callRes.text();
  console.log(`\ntools/call → ${callRes.status} ${callRes.statusText}`);
  console.log("  body excerpt:", redactBody(callText.slice(0, 1200), key));
}

const arg = process.argv.indexOf("--service");
const service = arg >= 0 ? process.argv[arg + 1] : "web_search_prime";

const key = await readKey();
console.log(`key shape: ${redactKey(key)}`);
console.log(`starts with 'sk-' → ${key.startsWith("sk-")}`);
console.log(`contains '.' (JWT-like) → ${key.includes(".")}`);
console.log(`contains whitespace → ${/\s/.test(key)}`);

if (service === "all") {
  for (const name of Object.keys(SERVICES) as (keyof typeof SERVICES)[]) {
    await probe(name, key);
  }
} else if (service in SERVICES) {
  await probe(service as keyof typeof SERVICES, key);
} else {
  console.error(`Unknown service: ${service}. Use one of: ${Object.keys(SERVICES).join(", ")} | all`);
  process.exit(2);
}
