/**
 * Z AI Extension for pi-agent
 *
 * Integrates Z AI's Web Search, Web Reader, and GitHub Reader / Zread as custom tools — all via MCP.
 *
 * Credentials are read from ~/.pi/agent/auth.json under "zai" -> "key".
 *
 * The MCP client lives in src/zai-client.ts so it can be unit-tested in isolation.
 */

import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

import {
  ZaiMcpClient,
  ZaiMcpError,
  loadZaiApiKey,
  describeAuthError,
  suspiciousKeyShape,
} from "./src/zai-client";

// ── Endpoints ────────────────────────────────────────────────────────────────

const ENDPOINT = {
  webSearch: "https://api.z.ai/api/mcp/web_search_prime",
  webReader: "https://api.z.ai/api/mcp/web_reader",
  zread: "https://api.z.ai/api/mcp/zread",
} as const;

// ── Shared helpers ───────────────────────────────────────────────────────────

function truncateOutput(output: string): string {
  const t = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!t.truncated) return t.content;
  return `${t.content}\n\n[Truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)})]`;
}

function formatZaiError(toolLabel: string, err: unknown): Error {
  if (err instanceof ZaiMcpError) {
    return new Error(`${toolLabel} failed [${err.kind}]: ${err.message}`);
  }
  return new Error(`${toolLabel} failed: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Loads the API key, returning the key or throwing a descriptive error.
 * One place for the credential check so all tools fail the same way.
 */
async function requireApiKey(): Promise<string> {
  const result = await loadZaiApiKey();
  if (!result.ok) throw new Error(describeAuthError(result.error));
  return result.key;
}

/** Build a tool result envelope with consistent truncation + details. */
function toolResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: truncateOutput(text) }], details };
}

// ── Tool: Web Search ─────────────────────────────────────────────────────────

interface WebSearchResult {
  title: string;
  link: string;
  content: string;
  refer: string;
}

const webSearchTool = {
  name: "zai_web_search",
  label: "Z AI Web Search",
  description:
    "Search the web using Z AI's Web Search Prime service. Returns search results with titles, links, and content snippets.",
  promptSnippet: "Search the web for current information using Z AI's search service",

  parameters: Type.Object({
    search_query: Type.String({ description: "Search query (max 70 chars recommended for best results)" }),
    search_domain_filter: Type.Optional(Type.String({ description: "Whitelist domain e.g. 'www.example.com'" })),
    search_recency_filter: Type.Optional(
      StringEnum(["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"] as const, {
        description: "Filter results by recency (default: noLimit)",
      }),
    ),
    content_size: Type.Optional(
      StringEnum(["medium", "high"] as const, {
        description: "Result size: medium (400-600 words, default) or high (2500 words)",
      }),
    ),
    location: Type.Optional(
      StringEnum(["cn", "us"] as const, {
        description: "Location: cn (Chinese, default) or us (non-Chinese)",
      }),
    ),
  }),

  async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
    const args = params as {
      search_query: string;
      search_domain_filter?: string;
      search_recency_filter?: string;
      content_size?: string;
      location?: string;
    };
    const apiKey = await requireApiKey();
    if (signal?.aborted) return toolResult("Search cancelled");
    const client = new ZaiMcpClient(apiKey, ENDPOINT.webSearch);

    try {
      const results = await client.callTool<WebSearchResult[]>(
        "web_search_prime",
        {
          search_query: args.search_query,
          ...(args.search_domain_filter && { search_domain_filter: args.search_domain_filter }),
          ...(args.search_recency_filter && { search_recency_filter: args.search_recency_filter }),
          ...(args.content_size && { content_size: args.content_size }),
          ...(args.location && { location: args.location }),
        },
        signal,
      );

      if (!Array.isArray(results)) {
        throw new ZaiMcpError("Unexpected web_search response shape", "parse-error", { received: typeof results });
      }

      let output = `Found ${results.length} result(s) for "${args.search_query}":\n\n`;
      for (const [i, r] of results.entries()) {
        const snippet = r.content.slice(0, 200) + (r.content.length > 200 ? "..." : "");
        output += `${i + 1}. ${r.title}\n   URL: ${r.link}\n   ${snippet}\n\n`;
      }
      return toolResult(output, { results, count: results.length });
    } catch (err) {
      throw formatZaiError("Z AI Web Search", err);
    }
  },
};

// ── Tool: Web Reader ─────────────────────────────────────────────────────────

const webReaderTool = {
  name: "zai_web_reader",
  label: "Z AI Web Reader",
  description: "Read and extract content from web pages. Fetches URLs and returns markdown or plain text content.",
  promptSnippet: "Read and extract content from web pages as markdown or plain text",

  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch and read" }),
    timeout: Type.Optional(Type.Integer({ description: "Timeout in seconds (default: 20)" })),
    no_cache: Type.Optional(Type.Boolean({ description: "Disable cache (default: false)" })),
    return_format: Type.Optional(
      StringEnum(["markdown", "text"] as const, { description: "Output format: markdown (default) or text" }),
    ),
    retain_images: Type.Optional(Type.Boolean({ description: "Keep images (default: true)" })),
    no_gfm: Type.Optional(Type.Boolean({ description: "Disable GitHub Flavored Markdown (default: false)" })),
    keep_img_data_url: Type.Optional(Type.Boolean({ description: "Keep image data URLs (default: false)" })),
    with_images_summary: Type.Optional(Type.Boolean({ description: "Include image summaries (default: false)" })),
    with_links_summary: Type.Optional(Type.Boolean({ description: "Include link summaries (default: false)" })),
  }),

  async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
    const args = params as {
      url: string;
      timeout?: number;
      no_cache?: boolean;
      return_format?: string;
      retain_images?: boolean;
      no_gfm?: boolean;
      keep_img_data_url?: boolean;
      with_images_summary?: boolean;
      with_links_summary?: boolean;
    };
    const apiKey = await requireApiKey();
    if (signal?.aborted) return toolResult("Read cancelled");
    const client = new ZaiMcpClient(apiKey, ENDPOINT.webReader);

    try {
      const result = await client.callTool<{
        title: string;
        url: string;
        content: string;
        metadata?: { viewport?: string; lang?: string };
      }>(
        "webReader",
        {
          url: args.url,
          ...(args.timeout !== undefined && { timeout: args.timeout }),
          ...(args.no_cache !== undefined && { no_cache: args.no_cache }),
          ...(args.return_format && { return_format: args.return_format }),
          ...(args.retain_images !== undefined && { retain_images: args.retain_images }),
          ...(args.no_gfm !== undefined && { no_gfm: args.no_gfm }),
          ...(args.keep_img_data_url !== undefined && { keep_img_data_url: args.keep_img_data_url }),
          ...(args.with_images_summary !== undefined && { with_images_summary: args.with_images_summary }),
          ...(args.with_links_summary !== undefined && { with_links_summary: args.with_links_summary }),
        },
        signal,
      );

      const output =
        `Title: ${result.title}\nURL: ${result.url}\n` +
        `Language: ${result.metadata?.lang ?? "unknown"}\n\n---\n\n${result.content}`;
      return toolResult(output, { result });
    } catch (err) {
      throw formatZaiError("Z AI Web Reader", err);
    }
  },
};

// ── Tool: GitHub Search ──────────────────────────────────────────────────────

const githubSearchDocTool = {
  name: "zai_github_search",
  label: "Z AI GitHub Search",
  description: "Search documentation, issues, and commits of a GitHub repository using Z AI's GitHub Reader service.",
  promptSnippet: "Search GitHub repositories for documentation, issues, and commits",

  parameters: Type.Object({
    repo_name: Type.String({ description: "Repository name in 'owner/repo' format (e.g., 'vitejs/vite')" }),
    query: Type.String({ description: "Search keywords or question" }),
    language: Type.Optional(
      StringEnum(["zh", "en"] as const, { description: "Language: 'zh' (Chinese) or 'en' (English)" }),
    ),
  }),

  async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
    const args = params as { repo_name: string; query: string; language?: string };
    const apiKey = await requireApiKey();
    if (signal?.aborted) return toolResult("Search cancelled");
    const client = new ZaiMcpClient(apiKey, ENDPOINT.zread);

    try {
      const result = await client.callTool<unknown>(
        "search_doc",
        { repo_name: args.repo_name, query: args.query, ...(args.language && { language: args.language }) },
        signal,
      );
      const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return toolResult(
        `GitHub search results for "${args.query}" in ${args.repo_name}:\n\n${body}`,
        { result, repo: args.repo_name, query: args.query },
      );
    } catch (err) {
      throw formatZaiError("Z AI GitHub Search", err);
    }
  },
};

// ── Tool: GitHub Read File ───────────────────────────────────────────────────

const githubReadFileTool = {
  name: "zai_github_read_file",
  label: "Z AI GitHub Read File",
  description: "Read a specific file from a GitHub repository using Z AI's GitHub Reader service.",
  promptSnippet: "Read files directly from GitHub repositories",

  parameters: Type.Object({
    repo_name: Type.String({ description: "Repository name in 'owner/repo' format (e.g., 'vitejs/vite')" }),
    file_path: Type.String({ description: "Relative path to the file in the repository (e.g., 'src/index.ts')" }),
  }),

  async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
    const args = params as { repo_name: string; file_path: string };
    const apiKey = await requireApiKey();
    if (signal?.aborted) return toolResult("Read cancelled");
    const client = new ZaiMcpClient(apiKey, ENDPOINT.zread);

    try {
      const result = await client.callTool<unknown>(
        "read_file",
        { repo_name: args.repo_name, file_path: args.file_path },
        signal,
      );
      const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return toolResult(
        `File: ${args.repo_name}/${args.file_path}\n---\n\n${body}`,
        { result, repo: args.repo_name, path: args.file_path },
      );
    } catch (err) {
      throw formatZaiError("Z AI GitHub Read File", err);
    }
  },
};

// ── Tool: GitHub Repo Structure ──────────────────────────────────────────────

const githubGetRepoStructureTool = {
  name: "zai_github_structure",
  label: "Z AI GitHub Structure",
  description: "List directory contents of a GitHub repository using Z AI's GitHub Reader service.",
  promptSnippet: "Explore GitHub repository directory structure",

  parameters: Type.Object({
    repo_name: Type.String({ description: "Repository name in 'owner/repo' format (e.g., 'vitejs/vite')" }),
    dir_path: Type.Optional(Type.String({ description: "Directory path (default: root '/')" })),
  }),

  async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
    const args = params as { repo_name: string; dir_path?: string };
    const apiKey = await requireApiKey();
    if (signal?.aborted) return toolResult("Structure lookup cancelled");
    const client = new ZaiMcpClient(apiKey, ENDPOINT.zread);

    try {
      const result = await client.callTool<unknown>(
        "get_repo_structure",
        { repo_name: args.repo_name, ...(args.dir_path !== undefined && { dir_path: args.dir_path }) },
        signal,
      );
      const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const header = `Repository structure for ${args.repo_name}` + (args.dir_path ? ` at ${args.dir_path}` : "");
      return toolResult(
        `${header}:\n\n${body}`,
        { result, repo: args.repo_name, path: args.dir_path ?? "/" },
      );
    } catch (err) {
      throw formatZaiError("Z AI GitHub Structure", err);
    }
  },
};

// ── Extension Factory ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool(webSearchTool);
  pi.registerTool(webReaderTool);
  pi.registerTool(githubSearchDocTool);
  pi.registerTool(githubReadFileTool);
  pi.registerTool(githubGetRepoStructureTool);

  pi.on("session_start", async (_event, ctx) => {
    const result = await loadZaiApiKey();
    if (!result.ok) {
      ctx.ui.notify(`Z AI extension: ${describeAuthError(result.error)}`, "warning");
      return;
    }
    const suspicion = suspiciousKeyShape(result.key);
    if (suspicion) {
      ctx.ui.notify(`Z AI extension: API key looks malformed (${suspicion}). Tools will likely fail.`, "warning");
    } else {
      ctx.ui.notify("Z AI extension loaded with API key", "info");
    }
  });
}
