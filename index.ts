/**
 * Z AI Extension for pi-agent
 *
 * Integrates Z AI's Web Search Prime, Web Reader, and GitHub Reader services
 * as custom tools for pi-agent.
 *
 * Credentials are read from ~/.pi/agent/auth.json under "zai" -> "key"
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

interface ZaiAuthConfig {
  zai?: {
    key?: string;
  };
}

interface ZaiJsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface ZaiJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: {
    code: number;
    message: string;
  };
}

interface WebSearchResult {
  title: string;
  link: string;
  content: string;
  refer: string;
}

interface WebReaderResult {
  title: string;
  url: string;
  content: string;
  metadata: {
    viewport?: string;
    lang?: string;
  };
}

// ============================================================================
// Configuration & Credentials
// ============================================================================

async function getZaiApiKey(): Promise<string | null> {
  try {
    const authPath = join(homedir(), ".pi/agent/auth.json");
    const authContent = await readFile(authPath, "utf-8");
    const auth = JSON.parse(authContent) as ZaiAuthConfig;
    return auth.zai?.key ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// ZAI MCP Protocol Client
// ============================================================================

class ZaiMcpClient {
  private sessionId: string | null = null;
  private requestId = 0;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  /**
   * Initialize an MCP session
   */
  async initialize(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
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
    });

    if (!response.ok) {
      throw new Error(`MCP initialization failed: ${response.status} ${response.statusText}`);
    }

    // Extract session ID from response headers
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new Error("No Mcp-Session-Id header in response");
    }

    this.sessionId = sessionId;

    // Consume the SSE response body
    await response.text();
  }

  /**
   * Call a tool on the MCP session
   */
  async callTool<T>(toolName: string, arguments_: unknown): Promise<T> {
    if (!this.sessionId) {
      await this.initialize();
    }

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": this.sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: arguments_,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Tool call failed: ${response.status} ${response.statusText}`);
    }

    // Parse SSE response
    const text = await response.text();
    const data = this.parseSseResponse(text);

    if (!data.result) {
      throw new Error(data.error?.message ?? "No result in MCP response");
    }

    if (data.result.isError) {
      throw new Error(`Tool execution error: ${data.result.content[0]?.text ?? "Unknown error"}`);
    }

    const resultText = data.result.content[0]?.text;
    if (!resultText) {
      throw new Error("No content in tool result");
    }

    return JSON.parse(resultText) as T;
  }

  /**
   * Parse Server-Sent Events format response
   */
  private parseSseResponse(text: string): ZaiJsonRpcResponse {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const dataStr = line.slice(5).trim();
        return JSON.parse(dataStr) as ZaiJsonRpcResponse;
      }
    }
    throw new Error("No data event found in SSE response");
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Web Search Prime Tool
 * Endpoint: https://api.z.ai/api/mcp/web_search_prime/mcp
 * Tool name: web_search_prime
 */
const webSearchTool = {
  name: "zai_web_search",
  label: "Z AI Web Search",
  description: "Search the web using Z AI's Web Search Prime service. Returns search results with titles, links, and content snippets.",
  promptSnippet: "Search the web for current information using Z AI's search service",

  parameters: Type.Object({
    search_query: Type.String({ description: "Search query (max 70 chars recommended for best results)" }),
    search_domain_filter: Type.Optional(Type.String({ description: "Whitelist domain e.g. 'www.example.com'" })),
    search_recency_filter: Type.Optional(StringEnum(["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"] as const, { description: "Filter results by recency (default: noLimit)" })),
    content_size: Type.Optional(StringEnum(["medium", "high"] as const, { description: "Result size: medium (400-600 words, default) or high (2500 words)" })),
    location: Type.Optional(StringEnum(["cn", "us"] as const, { description: "Location: cn (Chinese, default) or us (non-Chinese)" })),
  }),

  async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
    const apiKey = await getZaiApiKey();
    if (!apiKey) {
      throw new Error("ZAI_API_KEY not found in ~/.pi/agent/auth.json under 'zai.key'");
    }

    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Search cancelled" }], details: {} };
    }

    const args = params as {
      search_query: string;
      search_domain_filter?: string;
      search_recency_filter?: string;
      content_size?: string;
      location?: string;
    };

    const client = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/web_search_prime");

    try {
      const results = await client.callTool<WebSearchResult[]>("web_search_prime", {
        search_query: args.search_query,
        ...(args.search_domain_filter && { search_domain_filter: args.search_domain_filter }),
        ...(args.search_recency_filter && { search_recency_filter: args.search_recency_filter }),
        ...(args.content_size && { content_size: args.content_size }),
        ...(args.location && { location: args.location }),
      });

      // Format results
      let output = `Found ${results.length} result(s) for "${args.search_query}":\n\n`;
      for (const [i, result] of results.entries()) {
        output += `${i + 1}. ${result.title}\n`;
        output += `   URL: ${result.link}\n`;
        output += `   ${result.content.slice(0, 200)}${result.content.length > 200 ? "..." : ""}\n\n`;
      }

      // Truncate if needed
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      if (truncation.truncated) {
        truncation.content += `\n\n[Results truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: truncation.content }],
        details: { results, count: results.length },
      };
    } catch (error) {
      throw new Error(`Z AI Web Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/**
 * Web Reader Tool
 * Endpoint: https://api.z.ai/api/mcp/web_reader/mcp
 * Tool name: webReader
 */
const webReaderTool = {
  name: "zai_web_reader",
  label: "Z AI Web Reader",
  description: "Read and extract content from web pages. Fetches URLs and returns markdown or plain text content.",
  promptSnippet: "Read and extract content from web pages as markdown or plain text",

  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch and read" }),
    timeout: Type.Optional(Type.Integer({ description: "Timeout in seconds (default: 20)" })),
    no_cache: Type.Optional(Type.Boolean({ description: "Disable cache (default: false)" })),
    return_format: Type.Optional(StringEnum(["markdown", "text"] as const, { description: "Output format: markdown (default) or text" })),
    retain_images: Type.Optional(Type.Boolean({ description: "Keep images (default: true)" })),
    no_gfm: Type.Optional(Type.Boolean({ description: "Disable GitHub Flavored Markdown (default: false)" })),
    keep_img_data_url: Type.Optional(Type.Boolean({ description: "Keep image data URLs (default: false)" })),
    with_images_summary: Type.Optional(Type.Boolean({ description: "Include image summaries (default: false)" })),
    with_links_summary: Type.Optional(Type.Boolean({ description: "Include link summaries (default: false)" })),
  }),

  async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
    const apiKey = await getZaiApiKey();
    if (!apiKey) {
      throw new Error("ZAI_API_KEY not found in ~/.pi/agent/auth.json under 'zai.key'");
    }

    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Read cancelled" }], details: {} };
    }

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

    const client = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/web_reader");

    try {
      const result = await client.callTool<WebReaderResult>("webReader", {
        url: args.url,
        ...(args.timeout !== undefined && { timeout: args.timeout }),
        ...(args.no_cache !== undefined && { no_cache: args.no_cache }),
        ...(args.return_format && { return_format: args.return_format }),
        ...(args.retain_images !== undefined && { retain_images: args.retain_images }),
        ...(args.no_gfm !== undefined && { no_gfm: args.no_gfm }),
        ...(args.keep_img_data_url !== undefined && { keep_img_data_url: args.keep_img_data_url }),
        ...(args.with_images_summary !== undefined && { with_images_summary: args.with_images_summary }),
        ...(args.with_links_summary !== undefined && { with_links_summary: args.with_links_summary }),
      });

      let output = `Title: ${result.title}\n`;
      output += `URL: ${result.url}\n`;
      output += `Language: ${result.metadata.lang ?? "unknown"}\n\n`;
      output += "---\n\n";
      output += result.content;

      // Truncate if needed
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      if (truncation.truncated) {
        truncation.content += `\n\n[Content truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: truncation.content }],
        details: { result },
      };
    } catch (error) {
      throw new Error(`Z AI Web Reader failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/**
 * GitHub Search Doc Tool
 * Endpoint: https://api.z.ai/api/mcp/zread/mcp
 * Tool name: search_doc
 */
const githubSearchDocTool = {
  name: "zai_github_search",
  label: "Z AI GitHub Search",
  description: "Search documentation, issues, and commits of a GitHub repository using Z AI's GitHub Reader service.",
  promptSnippet: "Search GitHub repositories for documentation, issues, and commits",

  parameters: Type.Object({
    repo_name: Type.String({ description: "Repository name in 'owner/repo' format (e.g., 'vitejs/vite')" }),
    query: Type.String({ description: "Search keywords or question" }),
    language: Type.Optional(StringEnum(["zh", "en"] as const, { description: "Language: 'zh' (Chinese) or 'en' (English)" })),
  }),

  async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
    const apiKey = await getZaiApiKey();
    if (!apiKey) {
      throw new Error("ZAI_API_KEY not found in ~/.pi/agent/auth.json under 'zai.key'");
    }

    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Search cancelled" }], details: {} };
    }

    const args = params as {
      repo_name: string;
      query: string;
      language?: string;
    };

    const client = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/zread");

    try {
      const result = await client.callTool<Record<string, unknown>>("search_doc", {
        repo_name: args.repo_name,
        query: args.query,
        ...(args.language && { language: args.language }),
      });

      let output = `GitHub search results for "${args.query}" in ${args.repo_name}:\n\n`;
      output += JSON.stringify(result, null, 2);

      // Truncate if needed
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      if (truncation.truncated) {
        truncation.content += `\n\n[Results truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: truncation.content }],
        details: { result, repo: args.repo_name, query: args.query },
      };
    } catch (error) {
      throw new Error(`Z AI GitHub Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/**
 * GitHub Read File Tool
 * Endpoint: https://api.z.ai/api/mcp/zread/mcp
 * Tool name: read_file
 */
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
    const apiKey = await getZaiApiKey();
    if (!apiKey) {
      throw new Error("ZAI_API_KEY not found in ~/.pi/agent/auth.json under 'zai.key'");
    }

    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Read cancelled" }], details: {} };
    }

    const args = params as {
      repo_name: string;
      file_path: string;
    };

    const client = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/zread");

    try {
      const result = await client.callTool<Record<string, unknown>>("read_file", {
        repo_name: args.repo_name,
        file_path: args.file_path,
      });

      let output = `File: ${args.repo_name}/${args.file_path}\n`;
      output += "---\n\n";
      output += JSON.stringify(result, null, 2);

      // Truncate if needed
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      if (truncation.truncated) {
        truncation.content += `\n\n[Content truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: truncation.content }],
        details: { result, repo: args.repo_name, path: args.file_path },
      };
    } catch (error) {
      throw new Error(`Z AI GitHub Read File failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/**
 * GitHub Get Repo Structure Tool
 * Endpoint: https://api.z.ai/api/mcp/zread/mcp
 * Tool name: get_repo_structure
 */
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
    const apiKey = await getZaiApiKey();
    if (!apiKey) {
      throw new Error("ZAI_API_KEY not found in ~/.pi/agent/auth.json under 'zai.key'");
    }

    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Structure lookup cancelled" }], details: {} };
    }

    const args = params as {
      repo_name: string;
      dir_path?: string;
    };

    const client = new ZaiMcpClient(apiKey, "https://api.z.ai/api/mcp/zread");

    try {
      const result = await client.callTool<Record<string, unknown>>("get_repo_structure", {
        repo_name: args.repo_name,
        ...(args.dir_path !== undefined && { dir_path: args.dir_path }),
      });

      let output = `Repository structure for ${args.repo_name}`;
      if (args.dir_path) {
        output += ` at ${args.dir_path}`;
      }
      output += ":\n\n";
      output += JSON.stringify(result, null, 2);

      // Truncate if needed
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      if (truncation.truncated) {
        truncation.content += `\n\n[Structure truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: truncation.content }],
        details: { result, repo: args.repo_name, path: args.dir_path ?? "/" },
      };
    } catch (error) {
      throw new Error(`Z AI GitHub Structure failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ============================================================================
// Extension Factory
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Register all Z AI tools
  pi.registerTool(webSearchTool);
  pi.registerTool(webReaderTool);
  pi.registerTool(githubSearchDocTool);
  pi.registerTool(githubReadFileTool);
  pi.registerTool(githubGetRepoStructureTool);

  // Notify on successful load
  pi.on("session_start", async (_event, ctx) => {
    const apiKey = await getZaiApiKey();
    if (apiKey) {
      ctx.ui.notify("Z AI extension loaded with API key", "info");
    } else {
      ctx.ui.notify("Z AI extension loaded (no API key found in ~/.pi/agent/auth.json)", "warning");
    }
  });
}