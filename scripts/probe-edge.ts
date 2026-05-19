#!/usr/bin/env bun
/**
 * Edge-case probes to reproduce the "MCP error -401: Api key not found".
 *
 * Tries each failure mode that could produce that exact error string:
 *  1. tools/call WITHOUT initialize (no session)
 *  2. tools/call with STALE/FAKE session id
 *  3. tools/call with NO Authorization header but with session id
 *  4. tools/call with EMPTY Authorization header
 *  5. tools/call with WRONG key
 *  6. notifications/initialized with params:{} (might fix the 400)
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";

async function readKey(): Promise<string> {
  const raw = await readFile(join(homedir(), ".pi/agent/auth.json"), "utf-8");
  return JSON.parse(raw).zai.key;
}

async function call(label: string, headers: Record<string, string>, body: unknown) {
  console.log(`\n── ${label}`);
  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`  status: ${res.status} ${res.statusText}`);
  console.log(`  body: ${text.slice(0, 400).replace(/\n/g, " | ")}`);
  return { status: res.status, text, sessionId: res.headers.get("mcp-session-id") };
}

const key = await readKey();
const baseAccept = "application/json, text/event-stream";

// 1. tools/call WITHOUT initialize
await call(
  "tools/call without initialize",
  { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: baseAccept },
  { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_prime", arguments: { search_query: "x" } } },
);

// 2. tools/call with fake session id
await call(
  "tools/call with fake session id",
  {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: baseAccept,
    "mcp-session-id": "00000000-0000-0000-0000-000000000000",
  },
  { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_prime", arguments: { search_query: "x" } } },
);

// Establish a real session for the next tests
const init = await call(
  "initialize (fresh session)",
  { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: baseAccept },
  {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "edge", version: "1" } },
  },
);
const session = init.sessionId!;
console.log(`  → got session: ${session}`);

// 3. tools/call with session but NO Authorization header
await call(
  "tools/call WITH session, NO auth header",
  { "Content-Type": "application/json", Accept: baseAccept, "mcp-session-id": session },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search_prime", arguments: { search_query: "x" } } },
);

// 4. tools/call with empty Authorization
await call(
  "tools/call WITH session, EMPTY auth",
  { Authorization: "", "Content-Type": "application/json", Accept: baseAccept, "mcp-session-id": session },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search_prime", arguments: { search_query: "x" } } },
);

// 5. tools/call with WRONG key (no session, fresh approach)
await call(
  "tools/call with WRONG key",
  { Authorization: "Bearer wrong-key-XYZ", "Content-Type": "application/json", Accept: baseAccept },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "web_search_prime", arguments: { search_query: "x" } } },
);

// 6. Fix notifications/initialized — try with params:{}
const init2 = await call(
  "initialize again",
  { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: baseAccept },
  {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "edge2", version: "1" } },
  },
);
const s2 = init2.sessionId!;
await call(
  "notifications/initialized with params:{}",
  { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "mcp-session-id": s2 },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
);
await call(
  "notifications/initialized with Accept SSE",
  { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: baseAccept, "mcp-session-id": s2 },
  { jsonrpc: "2.0", method: "notifications/initialized" },
);
