/**
 * Z AI MCP client + credential loader.
 *
 * Extracted from index.ts for testability. The exports here are
 * pure (no pi-agent imports) so unit tests can mock fetch + fs.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Auth ────────────────────────────────────────────────────────────────────

export type AuthError =
  | { kind: "missing-file"; path: string }
  | { kind: "parse-error"; path: string; cause: string }
  | { kind: "missing-key"; path: string }
  | { kind: "empty-key"; path: string };

/**
 * Load the Z AI API key from ~/.pi/agent/auth.json.
 * Returns a discriminated result so callers can produce specific error messages.
 */
export async function loadZaiApiKey(
  authPath: string = join(homedir(), ".pi/agent/auth.json"),
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf-8"),
): Promise<{ ok: true; key: string } | { ok: false; error: AuthError }> {
  let raw: string;
  try {
    raw = await read(authPath);
  } catch {
    return { ok: false, error: { kind: "missing-file", path: authPath } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: { kind: "parse-error", path: authPath, cause: e instanceof Error ? e.message : String(e) },
    };
  }
  const key = (parsed as { zai?: { key?: unknown } })?.zai?.key;
  if (typeof key !== "string") {
    return { ok: false, error: { kind: "missing-key", path: authPath } };
  }
  if (key.trim().length === 0) {
    return { ok: false, error: { kind: "empty-key", path: authPath } };
  }
  return { ok: true, key: key.trim() };
}

/**
 * Best-effort sanity check on key shape. Returns a warning string if the key
 * looks suspicious (whitespace, quote chars, shell metacharacters); otherwise
 * undefined. This catches paste errors before the server has to.
 *
 * Z AI keys are typically either JWT-style (xxx.yyy.zzz, ~50 chars) or
 * `sk-...`. They never contain whitespace, single quotes, or leading `!`.
 */
export function suspiciousKeyShape(key: string): string | undefined {
  if (/\s/.test(key)) return "contains whitespace";
  if (/['"]/.test(key)) return "contains quote characters (shell paste error?)";
  if (key.startsWith("!")) return "starts with '!' (looks like a placeholder or shell history expansion)";
  if (key.startsWith("<") && key.endsWith(">")) return "looks like a placeholder (<...>)";
  if (key.length < 16) return `unusually short (len=${key.length})`;
  return undefined;
}

/**
 * Minimal shape of pi-agent's modelRegistry that we depend on.
 * Defined here to keep the auth-resolver decoupled from pi-coding-agent's types.
 */
export interface ModelRegistryLike {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

/**
 * Pi-agent context shape we depend on. Optional fields so we can be passed a
 * partial context, undefined, or a full ExtensionContext interchangeably.
 */
export interface AuthContextLike {
  modelRegistry?: ModelRegistryLike;
}

const ZAI_PROVIDER_ID = "zai";

/**
 * Ask pi-agent's modelRegistry for the Z AI key. Returns null if the registry
 * is unavailable, throws, or yields a missing/empty value.
 *
 * This is the preferred path because it respects: CLI --api-key overrides,
 * credential-protection plugins, OAuth refresh, and env-var fallbacks.
 */
export async function resolveKeyFromRegistry(ctx: AuthContextLike | undefined): Promise<string | null> {
  try {
    const key = await ctx?.modelRegistry?.getApiKeyForProvider?.(ZAI_PROVIDER_ID);
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Z AI key from any available source.
 *
 * Order:
 *   1. modelRegistry (respects pi-agent's full credential chain)
 *   2. Direct fs read of ~/.pi/agent/auth.json (fallback for tests/older agents)
 *
 * Returns the trimmed key or a descriptive AuthError result describing why
 * neither source produced one.
 */
export async function resolveZaiApiKey(
  ctx?: AuthContextLike,
  loader: () => Promise<{ ok: true; key: string } | { ok: false; error: AuthError }> = loadZaiApiKey,
): Promise<{ ok: true; key: string; source: "registry" | "disk" } | { ok: false; error: AuthError }> {
  const fromRegistry = await resolveKeyFromRegistry(ctx);
  if (fromRegistry) return { ok: true, key: fromRegistry, source: "registry" };

  const fromDisk = await loader();
  if (fromDisk.ok) return { ok: true, key: fromDisk.key, source: "disk" };

  return { ok: false, error: fromDisk.error };
}

export function describeAuthError(err: AuthError): string {
  switch (err.kind) {
    case "missing-file":
      return `Z AI auth file not found at ${err.path}. Create it with: {"zai":{"key":"<your-zai-api-key>"}}`;
    case "parse-error":
      return `Z AI auth file at ${err.path} is not valid JSON: ${err.cause}`;
    case "missing-key":
      return `Z AI auth file at ${err.path} is missing "zai.key". Expected shape: {"zai":{"key":"..."}}`;
    case "empty-key":
      return `Z AI auth file at ${err.path} has an empty "zai.key". Set it to your API key from https://z.ai`;
  }
}

// ── MCP types ───────────────────────────────────────────────────────────────

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    [k: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

/** Non-MCP error envelope Z AI's gateway returns for auth failures (HTTP 200 + body). */
interface ZaiGatewayError {
  code: number;
  msg: string;
  success: false;
}

export class ZaiMcpError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "http"
      | "gateway-auth"
      | "rpc-error"
      | "tool-error"
      | "no-result"
      | "parse-error"
      | "init-failed"
      | "timeout"
      | "aborted",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ZaiMcpError";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isGatewayError(value: unknown): value is ZaiGatewayError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "msg" in value &&
    "success" in value &&
    (value as { success: unknown }).success === false
  );
}

/**
 * Parse a Z AI MCP response. The transport returns either:
 *   • SSE: `id:1\nevent:message\ndata:{...json...}\n\n`
 *   • Plain JSON (older endpoints, errors)
 *   • A non-MCP gateway error envelope `{code, msg, success:false}`
 */
export function parseMcpResponseBody(text: string): JsonRpcResponse {
  // SSE first — pick the LAST data: line in case of multi-event streams.
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
  if (dataLines.length > 0) {
    const last = dataLines[dataLines.length - 1].slice(5).trim();
    try {
      return JSON.parse(last) as JsonRpcResponse;
    } catch (e) {
      throw new ZaiMcpError(`Malformed SSE data line: ${(e as Error).message}`, "parse-error", {
        excerpt: last.slice(0, 200),
      });
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ZaiMcpError(`Unexpected MCP response (not SSE, not JSON): ${text.slice(0, 200)}`, "parse-error");
  }

  if (isGatewayError(parsed)) {
    throw new ZaiMcpError(`Z AI gateway error ${parsed.code}: ${parsed.msg}`, "gateway-auth", {
      code: parsed.code,
      msg: parsed.msg,
    });
  }

  return parsed as JsonRpcResponse;
}

/**
 * Tool result payloads may be:
 *   • A JSON object/array (zread structure responses)
 *   • A JSON-encoded string of a JSON value (web_search/web_reader, double-encoded)
 *   • A plain string (zread markdown)
 */
export function decodeToolPayload(resultText: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return resultText;
  }
  if (typeof parsed === "string") {
    try {
      return JSON.parse(parsed);
    } catch {
      return parsed;
    }
  }
  return parsed;
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface ZaiMcpClientOptions {
  /** Override the global fetch — primarily for tests. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Number of retries on transient errors (5xx / network). Default 2. */
  maxRetries?: number;
}

export class ZaiMcpClient {
  private sessionId: string | null = null;
  private requestId = 0;
  private initPromise: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(
    private readonly apiKey: string,
    /** Base URL WITHOUT trailing `/mcp` — e.g. `https://api.z.ai/api/mcp/web_search_prime`. */
    private readonly baseUrl: string,
    options: ZaiMcpClientOptions = {},
  ) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new ZaiMcpError("API key must be a non-empty string", "init-failed");
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** Endpoint used by all RPC calls. */
  get endpoint(): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/mcp`;
  }

  private headers(includeAcceptSse = true): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (includeAcceptSse) h.Accept = "application/json, text/event-stream";
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const onUserAbort = () => controller.abort(new Error("aborted"));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new ZaiMcpError("Request aborted", "aborted");
      }
      signal.addEventListener("abort", onUserAbort, { once: true });
    }
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (e) {
      const reason = (controller.signal.reason as Error | undefined)?.message;
      if (reason === "timeout") {
        throw new ZaiMcpError(`Request timed out after ${this.timeoutMs}ms`, "timeout");
      }
      if (reason === "aborted") {
        throw new ZaiMcpError("Request aborted by caller", "aborted");
      }
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onUserAbort);
    }
  }

  /**
   * Run the MCP handshake. Coalesced — concurrent calls share one initialize.
   * Verifies the JSON-RPC response body (not just HTTP status) actually
   * returned `result`, so we never proceed to tools/call with a half-open session.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.sessionId) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize(signal).catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(signal?: AbortSignal): Promise<void> {
    const response = await this.fetchWithTimeout(
      this.endpoint,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.requestId,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "pi-agent", version: "1.0.0" },
          },
        }),
      },
      signal,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ZaiMcpError(
        `MCP initialize HTTP ${response.status} ${response.statusText}`,
        "init-failed",
        { body: body.slice(0, 400) },
      );
    }

    const sessionId = response.headers.get("mcp-session-id");
    const text = await response.text();
    let body: JsonRpcResponse;
    try {
      body = parseMcpResponseBody(text);
    } catch (e) {
      // Pass through gateway-auth errors unchanged — they're the most
      // diagnostic class of failure (wrong/missing/expired key).
      if (e instanceof ZaiMcpError && e.kind === "gateway-auth") throw e;
      throw new ZaiMcpError(
        `MCP initialize returned unparseable body: ${(e as Error).message}`,
        "init-failed",
      );
    }
    if (body.error) {
      throw new ZaiMcpError(
        `MCP initialize rejected: ${body.error.message} (code ${body.error.code})`,
        "init-failed",
        { rpcError: body.error },
      );
    }
    if (!body.result) {
      throw new ZaiMcpError("MCP initialize returned no result", "init-failed");
    }

    this.sessionId = sessionId;

    // Send notifications/initialized. Z AI's server returns 400 if we omit
    // the SSE Accept header — sending it produces a clean 200.
    // We tolerate non-2xx silently since the server is also okay if we skip
    // this step entirely (tested empirically).
    try {
      await this.fetchWithTimeout(
        this.endpoint,
        {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        },
        signal,
      );
    } catch {
      // notifications/* are advisory; the tool call will still work.
    }
  }

  /**
   * Call a tool. Always initializes first (idempotent). Handles double-encoded
   * payloads. Surfaces auth/gateway/RPC/tool errors with specific kinds.
   */
  async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.initialize(signal);
    return this.callWithRetry<T>(toolName, args, signal, 0);
  }

  private async callWithRetry<T>(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<T> {
    try {
      return await this.callOnce<T>(toolName, args, signal);
    } catch (e) {
      if (
        e instanceof ZaiMcpError &&
        attempt < this.maxRetries &&
        shouldRetry(e)
      ) {
        const backoff = 200 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
        return this.callWithRetry<T>(toolName, args, signal, attempt + 1);
      }
      throw e;
    }
  }

  private async callOnce<T>(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchWithTimeout(
      this.endpoint,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.requestId,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      },
      signal,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ZaiMcpError(
        `MCP tool call HTTP ${response.status} ${response.statusText}`,
        "http",
        { body: body.slice(0, 400) },
      );
    }

    const text = await response.text();
    const body = parseMcpResponseBody(text);

    if (body.error) {
      throw new ZaiMcpError(
        `MCP error ${body.error.code}: ${body.error.message}`,
        "rpc-error",
        { rpcError: body.error },
      );
    }
    if (!body.result) {
      throw new ZaiMcpError("MCP tool call returned no result", "no-result");
    }
    if (body.result.isError) {
      const msg = body.result.content?.[0]?.text ?? "(no error text)";
      throw new ZaiMcpError(`Tool execution error: ${msg}`, "tool-error", { content: body.result.content });
    }
    const resultText = body.result.content?.[0]?.text;
    if (typeof resultText !== "string") {
      throw new ZaiMcpError("MCP tool call returned no text content", "no-result");
    }
    return decodeToolPayload(resultText) as T;
  }
}

function shouldRetry(e: ZaiMcpError): boolean {
  if (e.kind === "timeout") return true;
  if (e.kind === "http") {
    const body = e.details?.body;
    // Retry only on 5xx — never on 4xx (auth, bad args).
    return /\bHTTP 5\d\d\b/.test(e.message) || (typeof body === "string" && /5\d\d/.test(e.message));
  }
  return false;
}
