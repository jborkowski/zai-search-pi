/**
 * Unit tests for the Z AI MCP client and auth loader.
 *
 *   bun test
 *
 * No network. Fetch is mocked per test. These cover every failure mode the
 * extension can hit at runtime — including the exact -401 scenario the user
 * reported on 2026-05-19 (tools/call dispatched before initialize).
 */
import { describe, expect, it, mock } from "bun:test";
import {
  ZaiMcpClient,
  ZaiMcpError,
  decodeToolPayload,
  describeAuthError,
  loadZaiApiKey,
  parseMcpResponseBody,
  suspiciousKeyShape,
} from "../src/zai-client";

// ── helpers ──────────────────────────────────────────────────────────────────

type MockResponse = { status?: number; statusText?: string; body: string; headers?: Record<string, string> };

function mockFetch(responses: MockResponse[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = mock(async (url: string, init: RequestInit = {}) => {
    if (i >= responses.length) throw new Error(`mockFetch: unexpected call #${i + 1} to ${url}`);
    calls.push({ url, init });
    const r = responses[i++];
    return new Response(r.body, {
      status: r.status ?? 200,
      statusText: r.statusText ?? "OK",
      headers: r.headers ?? {},
    });
  });
  return { fn: fn as unknown as typeof fetch, calls, exhausted: () => i === responses.length };
}

function sseBody(payload: object): string {
  return `id:1\nevent:message\ndata:${JSON.stringify(payload)}\n\n`;
}

const okInit: MockResponse = {
  body: sseBody({
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "t", version: "1" } },
  }),
  headers: { "mcp-session-id": "test-session-abc" },
};
const okNotify: MockResponse = { body: "" };

// ── parseMcpResponseBody ─────────────────────────────────────────────────────

describe("parseMcpResponseBody", () => {
  it("parses SSE data lines", () => {
    const r = parseMcpResponseBody(sseBody({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }));
    expect(r.result?.content?.[0].text).toBe("ok");
  });

  it("parses plain JSON", () => {
    const r = parseMcpResponseBody(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] } }));
    expect(r.result?.content?.[0].text).toBe("hi");
  });

  it("recognises Z AI gateway auth errors as ZaiMcpError(gateway-auth)", () => {
    expect(() =>
      parseMcpResponseBody(JSON.stringify({ code: 1001, msg: "Authentication parameter not received in Header, unable to authenticate", success: false })),
    ).toThrow(/gateway error 1001/);
  });

  it("recognises Z AI 401 (bad token) as gateway-auth", () => {
    try {
      parseMcpResponseBody(JSON.stringify({ code: 401, msg: "token expired or incorrect", success: false }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ZaiMcpError);
      expect((e as ZaiMcpError).kind).toBe("gateway-auth");
    }
  });

  it("throws parse-error for garbage bodies", () => {
    try {
      parseMcpResponseBody("not json at all");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ZaiMcpError).kind).toBe("parse-error");
    }
  });

  it("uses the LAST data: line when SSE has multiple events", () => {
    const text =
      `data:${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "first" }] } })}\n\n` +
      `data:${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "final" }] } })}\n\n`;
    const r = parseMcpResponseBody(text);
    expect(r.result?.content?.[0].text).toBe("final");
  });
});

// ── decodeToolPayload ────────────────────────────────────────────────────────

describe("decodeToolPayload", () => {
  it("decodes double-encoded JSON (web_search style)", () => {
    const inner = JSON.stringify([{ title: "x" }]);
    const outer = JSON.stringify(inner);
    expect(decodeToolPayload(outer)).toEqual([{ title: "x" }]);
  });

  it("decodes single-encoded JSON (object)", () => {
    expect(decodeToolPayload(JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
  });

  it("keeps single-encoded markdown string as-is (zread style)", () => {
    expect(decodeToolPayload(JSON.stringify("# Title\n\nbody"))).toBe("# Title\n\nbody");
  });

  it("returns raw string when not JSON at all", () => {
    expect(decodeToolPayload("plain markdown text")).toBe("plain markdown text");
  });
});

// ── ZaiMcpClient ─────────────────────────────────────────────────────────────

describe("ZaiMcpClient", () => {
  it("refuses an empty api key at construction", () => {
    expect(() => new ZaiMcpClient("", "https://example.test")).toThrow(/non-empty/);
    expect(() => new ZaiMcpClient("   ", "https://example.test")).toThrow(/non-empty/);
  });

  it("builds endpoint = base + /mcp, normalising trailing slashes", () => {
    const c1 = new ZaiMcpClient("k", "https://api.z.ai/api/mcp/web_search_prime");
    const c2 = new ZaiMcpClient("k", "https://api.z.ai/api/mcp/web_search_prime/");
    expect(c1.endpoint).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp");
    expect(c2.endpoint).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp");
  });

  it("initialize() runs handshake and captures session id", async () => {
    const m = mockFetch([okInit, okNotify]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    await client.initialize();
    expect(m.exhausted()).toBe(true);
    // session id sent on subsequent calls
    const m2 = mockFetch([
      { body: sseBody({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ ok: 1 }) }] } }) },
    ]);
    (client as unknown as { fetchImpl: typeof fetch }).fetchImpl = m2.fn;
    await client.callTool("foo", {});
    expect(m2.calls[0].init.headers).toMatchObject({ "mcp-session-id": "test-session-abc" });
  });

  it("ALWAYS initializes before the first tools/call (regression: -401 'Api key not found')", async () => {
    const m = mockFetch([
      okInit,
      okNotify,
      { body: sseBody({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ ok: 1 }) }] } }) },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    await client.callTool("foo", {});
    expect(m.calls.length).toBe(3);
    expect(JSON.parse(m.calls[0].init.body as string).method).toBe("initialize");
    expect(JSON.parse(m.calls[1].init.body as string).method).toBe("notifications/initialized");
    expect(JSON.parse(m.calls[2].init.body as string).method).toBe("tools/call");
  });

  it("coalesces concurrent initialize() — only one handshake fires", async () => {
    const m = mockFetch([
      okInit,
      okNotify,
      { body: sseBody({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ a: 1 }) }] } }) },
      { body: sseBody({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: JSON.stringify({ b: 2 }) }] } }) },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    const [a, b] = await Promise.all([client.callTool("foo", {}), client.callTool("foo", {})]);
    expect(a).toEqual({ a: 1 });
    expect(b).toEqual({ b: 2 });
    // 4 calls total = init + notify + 2 tools/call. NOT 6.
    expect(m.calls.length).toBe(4);
  });

  it("surfaces tool execution errors with kind 'tool-error' (the user's exact -401 message)", async () => {
    // Simulate the server returning the exact body that produced the user's error.
    const m = mockFetch([
      okInit,
      okNotify,
      {
        body: sseBody({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [{ type: "text", text: "MCP error -401: Api key not found, please get your apikey" }],
            isError: true,
          },
        }),
      },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    try {
      await client.callTool("foo", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ZaiMcpError);
      expect((e as ZaiMcpError).kind).toBe("tool-error");
      expect((e as ZaiMcpError).message).toContain("MCP error -401: Api key not found");
    }
  });

  it("passes through gateway-auth errors at init unchanged (don't wrap them as 'init-failed')", async () => {
    const m = mockFetch([
      { body: JSON.stringify({ code: 401, msg: "token expired or incorrect", success: false }) },
    ]);
    const client = new ZaiMcpClient("bad-key", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    try {
      await client.initialize();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ZaiMcpError).kind).toBe("gateway-auth");
      expect((e as ZaiMcpError).message).toContain("401");
      expect((e as ZaiMcpError).message).toContain("token expired or incorrect");
    }
  });

  it("rejects init that returns an error envelope (instead of silently proceeding)", async () => {
    const m = mockFetch([
      { body: sseBody({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "invalid" } }) },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    try {
      await client.callTool("foo", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ZaiMcpError);
      expect((e as ZaiMcpError).kind).toBe("init-failed");
    }
  });

  it("does not get stuck after a failed initialize — retries on next call", async () => {
    const m = mockFetch([
      { status: 500, statusText: "Internal", body: "boom" },
      okInit,
      okNotify,
      { body: sseBody({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ ok: 1 }) }] } }) },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    await expect(client.callTool("foo", {})).rejects.toBeInstanceOf(ZaiMcpError);
    // initPromise must be cleared; second attempt re-handshakes
    const r = await client.callTool("foo", {});
    expect(r).toEqual({ ok: 1 });
  });

  it("maps non-2xx HTTP at tool call to ZaiMcpError(http)", async () => {
    const m = mockFetch([
      okInit,
      okNotify,
      { status: 502, statusText: "Bad Gateway", body: "upstream down" },
      { status: 502, statusText: "Bad Gateway", body: "upstream down" },
      { status: 502, statusText: "Bad Gateway", body: "upstream down" },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 2 });
    try {
      await client.callTool("foo", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ZaiMcpError).kind).toBe("http");
      expect((e as ZaiMcpError).message).toContain("502");
    }
  });

  it("retries 5xx on tool call and eventually succeeds", async () => {
    const m = mockFetch([
      okInit,
      okNotify,
      { status: 503, statusText: "Unavailable", body: "" },
      { body: sseBody({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: JSON.stringify({ ok: 1 }) }] } }) },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 2 });
    const r = await client.callTool("foo", {});
    expect(r).toEqual({ ok: 1 });
    expect(m.calls.length).toBe(4);
  });

  it("does NOT retry on 4xx (e.g. auth errors should fail fast)", async () => {
    const m = mockFetch([
      okInit,
      okNotify,
      { status: 401, statusText: "Unauthorized", body: "" },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 2 });
    await expect(client.callTool("foo", {})).rejects.toBeInstanceOf(ZaiMcpError);
    expect(m.calls.length).toBe(3); // no retry attempted
  });

  it("recognises the gateway 'Authentication parameter not received' envelope", async () => {
    const m = mockFetch([
      okInit,
      okNotify,
      { body: JSON.stringify({ code: 1001, msg: "Authentication parameter not received in Header, unable to authenticate", success: false }) },
    ]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    try {
      await client.callTool("foo", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ZaiMcpError).kind).toBe("gateway-auth");
      expect((e as ZaiMcpError).message).toContain("1001");
    }
  });

  it("sends Bearer auth header and Content-Type on every request", async () => {
    const m = mockFetch([
      okInit,
      okNotify,
      { body: sseBody({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ ok: 1 }) }] } }) },
    ]);
    const client = new ZaiMcpClient("the-key", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    await client.callTool("foo", {});
    for (const c of m.calls) {
      expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer the-key");
      expect((c.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    }
  });

  it("notifications/initialized request includes Accept: text/event-stream (fixes Z AI 400)", async () => {
    const m = mockFetch([okInit, okNotify, { body: sseBody({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({}) }] } }) }]);
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    await client.callTool("foo", {});
    const notifyHeaders = m.calls[1].init.headers as Record<string, string>;
    expect(notifyHeaders.Accept).toContain("text/event-stream");
  });

  it("respects pre-aborted AbortSignal", async () => {
    const m = mockFetch([]); // no fetch should fire
    const client = new ZaiMcpClient("k", "https://example.test/svc", { fetch: m.fn, maxRetries: 0 });
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      await client.initialize(ctrl.signal);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ZaiMcpError).kind).toBe("aborted");
    }
    expect(m.calls.length).toBe(0);
  });

  it("times out after timeoutMs", async () => {
    const slowFetch = mock(async (_url: string, init?: RequestInit) => {
      // Wait until the client's controller aborts the request.
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
      return new Response("never");
    });
    const client = new ZaiMcpClient("k", "https://example.test/svc", {
      fetch: slowFetch as unknown as typeof fetch,
      timeoutMs: 30,
      maxRetries: 0,
    });
    try {
      await client.initialize();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ZaiMcpError).kind).toBe("timeout");
    }
  });
});

// ── Auth loader ──────────────────────────────────────────────────────────────

describe("loadZaiApiKey", () => {
  it("returns ok=true for a valid auth file", async () => {
    const r = await loadZaiApiKey("/fake", async () => JSON.stringify({ zai: { key: "abc123" } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.key).toBe("abc123");
  });

  it("trims whitespace around the key", async () => {
    const r = await loadZaiApiKey("/fake", async () => JSON.stringify({ zai: { key: "  abc123  " } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.key).toBe("abc123");
  });

  it("reports missing-file when read throws", async () => {
    const r = await loadZaiApiKey("/nope", async () => { throw new Error("ENOENT"); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("missing-file");
  });

  it("reports parse-error for invalid JSON", async () => {
    const r = await loadZaiApiKey("/x", async () => "{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("parse-error");
  });

  it("reports missing-key when zai.key absent", async () => {
    const r = await loadZaiApiKey("/x", async () => JSON.stringify({ zai: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("missing-key");
  });

  it("reports missing-key when entire 'zai' section absent", async () => {
    const r = await loadZaiApiKey("/x", async () => JSON.stringify({ other: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("missing-key");
  });

  it("reports empty-key for blank string", async () => {
    const r = await loadZaiApiKey("/x", async () => JSON.stringify({ zai: { key: "   " } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("empty-key");
  });

  it("describeAuthError produces actionable messages", () => {
    expect(describeAuthError({ kind: "missing-file", path: "/p" })).toContain("/p");
    expect(describeAuthError({ kind: "missing-key", path: "/p" })).toContain('"zai.key"');
    expect(describeAuthError({ kind: "empty-key", path: "/p" })).toContain("empty");
    expect(describeAuthError({ kind: "parse-error", path: "/p", cause: "x" })).toContain("not valid JSON");
  });
});

describe("suspiciousKeyShape", () => {
  it("accepts a normal JWT-style key", () => {
    expect(suspiciousKeyShape("eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MTUwMDB9.abc-def_XYZ123longenough")).toBeUndefined();
  });

  it("accepts an sk- prefixed key", () => {
    expect(suspiciousKeyShape("sk-abc123def456ghi789jkl012")).toBeUndefined();
  });

  it("flags whitespace (catches the live auth.json paste error)", () => {
    expect(suspiciousKeyShape("!secret 'token y'")).toMatch(/whitespace/);
  });

  it("flags quote characters", () => {
    expect(suspiciousKeyShape("eyAAAAAAAAAAAAAAAAA'XYZ")).toMatch(/quote/);
  });

  it("flags leading '!'", () => {
    expect(suspiciousKeyShape("!secret_paste_error_AAAAAAAAAAAA")).toMatch(/!/);
  });

  it("flags angle-bracket placeholders", () => {
    expect(suspiciousKeyShape("<your-zai-api-key>")).toMatch(/placeholder/);
  });

  it("flags suspiciously short keys", () => {
    expect(suspiciousKeyShape("short")).toMatch(/short/);
  });
});
