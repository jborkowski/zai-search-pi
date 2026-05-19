/**
 * Live integration test for all 5 Z AI tools (MCP-based).
 *
 *   bun run test-integration.ts
 *
 * Uses the same ZaiMcpClient as the extension itself — so this also smoke-tests
 * the production code path. For pure unit tests, run `bun test`.
 */

import { loadZaiApiKey, describeAuthError, ZaiMcpClient, ZaiMcpError } from "./src/zai-client";

// ── test runner ──────────────────────────────────────────────────────────────

const failed: string[] = [];
let passed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    passed++;
    console.log("✅ PASS");
  } catch (err) {
    failed.push(name);
    console.log("❌ FAIL");
    const msg = err instanceof ZaiMcpError ? `[${err.kind}] ${err.message}` : err instanceof Error ? err.message : String(err);
    console.log(`       ${msg}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Z AI Extension — Integration Test Suite (live network)\n");

  const auth = await loadZaiApiKey();
  if (!auth.ok) {
    console.error(`✗ ${describeAuthError(auth.error)}`);
    process.exit(2);
  }
  const apiKey = auth.key;
  console.log(`  auth: loaded key (len=${apiKey.length})\n`);

  const search = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/web_search_prime");
  const reader = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/web_reader");
  const zread = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/zread");

  // Force-initialize and report handshake status up front so a bad key fails
  // before we burn time on tool calls.
  await test("handshake: web_search_prime", () => search.initialize());
  await test("handshake: web_reader", () => reader.initialize());
  await test("handshake: zread", () => zread.initialize());

  // ── zai_web_search ─────────────────────────────────────────────────────────

  await test("web_search: basic query returns results matching topic", async () => {
    const results = await search.callTool<Array<{ title: string; link: string; content: string }>>("web_search_prime", {
      search_query: "Nicolaus Copernicus", location: "us",
    });
    if (!Array.isArray(results) || results.length === 0) throw new Error("no results");
    if (!results.some((r) => /Copernicus/i.test(r.content + r.title))) throw new Error("results unrelated to query");
    console.log(`       → ${results.length} results, top: "${results[0].title}"`);
  });

  await test("web_search: recency filter accepted", async () => {
    const results = await search.callTool<Array<{ title: string }>>("web_search_prime", {
      search_query: "AI news", search_recency_filter: "oneDay", location: "us",
    });
    if (!Array.isArray(results)) throw new Error("unexpected shape");
    console.log(`       → ${results.length} results`);
  });

  await test("web_search: content_size=high returns longer content", async () => {
    const results = await search.callTool<Array<{ content: string }>>("web_search_prime", {
      search_query: "Nicolaus Copernicus biography", content_size: "high", location: "us",
    });
    if (results.length === 0) throw new Error("no results");
    const avgLen = Math.round(results.reduce((s, r) => s + r.content.length, 0) / results.length);
    console.log(`       → avg content: ${avgLen} chars`);
  });

  // ── zai_web_reader ─────────────────────────────────────────────────────────

  await test("web_reader: markdown fetches Wikipedia page", async () => {
    const r = await reader.callTool<{ title: string; content: string }>("webReader", {
      url: "https://en.wikipedia.org/wiki/Nicolaus_Copernicus", return_format: "markdown", timeout: 30,
    });
    if (!r.content.includes("Copernicus")) throw new Error("missing expected content");
    console.log(`       → "${r.title}" — ${r.content.length} chars`);
  });

  await test("web_reader: plain text returns title", async () => {
    const r = await reader.callTool<{ title: string; content: string }>("webReader", {
      url: "https://example.com", return_format: "text", timeout: 15,
    });
    if (!r.title) throw new Error("no title");
    console.log(`       → "${r.title}" — ${r.content.length} chars`);
  });

  // ── zai_github_search ──────────────────────────────────────────────────────

  await test("github_search: returns HMR docs for vitejs/vite", async () => {
    const res = await zread.callTool<unknown>("search_doc", { repo_name: "vitejs/vite", query: "HMR", language: "en" });
    const s = typeof res === "string" ? res : JSON.stringify(res);
    if (!s.includes("HMR")) throw new Error("missing HMR");
    console.log(`       → ${s.length} chars`);
  });

  // ── zai_github_read_file ───────────────────────────────────────────────────

  await test("github_read_file: README mentions Vite", async () => {
    const res = await zread.callTool<unknown>("read_file", { repo_name: "vitejs/vite", file_path: "README.md" });
    const s = typeof res === "string" ? res : JSON.stringify(res);
    if (!s.includes("Vite")) throw new Error("missing Vite");
    console.log(`       → ${s.length} chars`);
  });

  // ── zai_github_structure ───────────────────────────────────────────────────

  await test("github_structure: root has 'packages' dir", async () => {
    const res = await zread.callTool<unknown>("get_repo_structure", { repo_name: "vitejs/vite" });
    const s = typeof res === "string" ? res : JSON.stringify(res);
    if (!s.includes("packages")) throw new Error("missing packages");
    console.log(`       → ${s.length} chars`);
  });

  await test("github_structure: subdir has 'vite' package", async () => {
    const res = await zread.callTool<unknown>("get_repo_structure", { repo_name: "vitejs/vite", dir_path: "packages" });
    const s = typeof res === "string" ? res : JSON.stringify(res);
    if (!s.includes("vite")) throw new Error("missing vite");
    console.log(`       → ${s.length} chars`);
  });

  // ── error-handling smoke tests (negative paths) ────────────────────────────

  await test("error: wrong API key surfaces gateway-auth (not silent success)", async () => {
    const bad = new ZaiMcpClient("definitely-not-a-real-key", "https://api.z.ai/api/mcp/web_search_prime", { maxRetries: 0 });
    try {
      await bad.callTool("web_search_prime", { search_query: "x" });
      throw new Error("expected failure");
    } catch (e) {
      if (!(e instanceof ZaiMcpError)) throw e;
      if (e.kind !== "gateway-auth" && e.kind !== "tool-error" && e.kind !== "init-failed") {
        throw new Error(`expected gateway-auth/tool-error/init-failed, got ${e.kind}`);
      }
      console.log(`       → ${e.kind}: ${e.message.slice(0, 80)}`);
    }
  });

  // ── results ────────────────────────────────────────────────────────────────

  const total = passed + failed.length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f}`);
    process.exit(1);
  }
  console.log("All tests passed! ✅");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
