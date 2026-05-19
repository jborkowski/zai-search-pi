/**
 * Comprehensive integration test for all 5 Z AI tools (MCP-based).
 *
 * Usage: bun run test-integration.ts
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── helpers ──────────────────────────────────────────────────────────────────

async function getApiKey(): Promise<string> {
  const authPath = join(homedir(), ".pi/agent/auth.json");
  const raw = await readFile(authPath, "utf-8");
  const auth = JSON.parse(raw);
  const key = auth?.zai?.key;
  if (!key) throw new Error("No ZAI API key in auth.json");
  return key;
}

// ── MCP client ───────────────────────────────────────────────────────────────

class ZaiMcpClient {
  private sessionId: string | null = null;
  private requestId = 0;

  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}

  async initialize(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: ++this.requestId, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-test", version: "1" } },
      }),
    });
    if (!res.ok) throw new Error(`MCP init failed: ${res.status}`);
    this.sessionId = res.headers.get("mcp-session-id");
    await res.text();
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    await fetch(`${this.baseUrl}/mcp`, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }

  async callTool<T>(toolName: string, args: unknown): Promise<T> {
    if (!this.sessionId) await this.initialize();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method: "tools/call", params: { name: toolName, arguments: args } }),
    });
    if (!res.ok) throw new Error(`Tool call failed: ${res.status}`);
    const text = await res.text();
    let json: { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    json = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
    if (!json.result) throw new Error(json.error?.message ?? "No result");
    if (json.result.isError) throw new Error(`Tool error: ${json.result.content?.[0]?.text ?? ""}`);
    const resultText = json.result.content?.[0]?.text;
    if (!resultText) throw new Error("No content");
    let parsed: unknown = JSON.parse(resultText);
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* single-encoded */ } }
    return parsed as T;
  }
}

// ── test runner ──────────────────────────────────────────────────────────────

const failed: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name} ... `);
  try { await fn(); console.log("✅ PASS"); }
  catch (err) { console.log("❌ FAIL"); console.log(`       ${err instanceof Error ? err.message : String(err)}`); failed.push(name); }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Z AI Extension — Integration Test Suite (MCP)\n");
  const apiKey = await getApiKey();

  const searchMcp = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/web_search_prime");
  await searchMcp.initialize();
  console.log("  web_search_prime ✅\n");

  const readerMcp = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/web_reader");
  await readerMcp.initialize();
  console.log("  web_reader ✅\n");

  const zreadMcp = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/zread");
  await zreadMcp.initialize();
  console.log("  zread ✅\n");

  // ── 1. zai_web_search ──────────────────────────────────────────────────

  await test("web_search (basic query)", async () => {
    const results = await searchMcp.callTool<Array<{ title: string; link: string; content: string }>>(
      "web_search_prime", { search_query: "Nicolaus Copernicus", location: "us" },
    );
    if (!Array.isArray(results) || results.length === 0) throw new Error("No results");
    if (!results[0].content.includes("Copernicus")) throw new Error("Results don't match query");
    console.log(`→ ${results.length} results, top: "${results[0].title}"`);
  });

  await test("web_search (recency filter)", async () => {
    const results = await searchMcp.callTool<Array<{ title: string }>>(
      "web_search_prime", { search_query: "AI news", search_recency_filter: "oneDay", location: "us" },
    );
    if (!Array.isArray(results)) throw new Error("No results for recent news");
    console.log(`→ ${results.length} results with oneDay filter`);
  });

  await test("web_search (content_size=high)", async () => {
    const results = await searchMcp.callTool<Array<{ content: string }>>(
      "web_search_prime", { search_query: "Nicolaus Copernicus biography", content_size: "high", location: "us" },
    );
    const avgLen = results.reduce((s, r) => s + r.content.length, 0) / results.length;
    console.log(`→ avg content: ${Math.round(avgLen)} chars`);
  });

  // ── 2. zai_web_reader ──────────────────────────────────────────────────

  await test("web_reader (markdown)", async () => {
    const result = await readerMcp.callTool<{ title: string; content: string }>(
      "webReader", { url: "https://en.wikipedia.org/wiki/Nicolaus_Copernicus", return_format: "markdown", timeout: 30 },
    );
    if (!result.content.includes("Copernicus")) throw new Error("Missing expected content");
    console.log(`→ "${result.title}" — ${result.content.length} chars`);
  });

  await test("web_reader (plain text)", async () => {
    const result = await readerMcp.callTool<{ title: string; content: string }>(
      "webReader", { url: "https://example.com", return_format: "text", timeout: 15 },
    );
    if (!result.title) throw new Error("No title");
    console.log(`→ "${result.title}" — ${result.content.length} chars`);
  });

  // ── 3. zai_github_search ───────────────────────────────────────────────

  await test("github_search (zread)", async () => {
    const res = await zreadMcp.callTool<unknown>("search_doc", {
      repo_name: "vitejs/vite", query: "HMR", language: "en",
    });
    const s = typeof res === "string" ? res : JSON.stringify(res);
    if (!s.includes("HMR")) throw new Error("Missing HMR in results");
    console.log(`→ ${s.length} chars`);
  });

  // ── 4. zai_github_read_file ────────────────────────────────────────────

  await test("github_read_file (zread)", async () => {
    const res = await zreadMcp.callTool<unknown>("read_file", {
      repo_name: "vitejs/vite", file_path: "README.md",
    });
    const s = typeof res === "string" ? res : JSON.stringify(res);
    if (!s.includes("Vite")) throw new Error("Missing Vite in file");
    console.log(`→ ${s.length} chars`);
  });

  // ── 5. zai_github_structure ────────────────────────────────────────────

  await test("github_structure root (zread)", async () => {
    const res = await zreadMcp.callTool<unknown>("get_repo_structure", { repo_name: "vitejs/vite" });
    const s = typeof res === "string" ? res : JSON.stringify(res);
    if (!s.includes("packages")) throw new Error("Missing packages dir");
    console.log(`→ ${s.length} chars`);
  });

  await test("github_structure subdir (zread)", async () => {
    const res = await zreadMcp.callTool<unknown>("get_repo_structure", {
      repo_name: "vitejs/vite", dir_path: "packages",
    });
    const s = typeof res === "string" ? res : JSON.stringify(res);
    if (!s.includes("vite")) throw new Error("Missing vite package");
    console.log(`→ ${s.length} chars`);
  });

  // ── results ────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  const passed = 9 - failed.length;
  console.log(`Results: ${passed}/9 passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f}`);
    process.exit(1);
  }
  console.log("All tests passed! ✅");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
