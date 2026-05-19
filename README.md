# Z AI Extension for pi-agent

A pi-agent extension that integrates Z AI's web search, web reader, and GitHub reader services over MCP.

## Tools

| Tool                    | What it does                                   |
| ----------------------- | ---------------------------------------------- |
| `zai_web_search`        | Z AI Web Search Prime with recency/domain filters |
| `zai_web_reader`        | Fetch a URL as markdown or plain text          |
| `zai_github_search`     | Search a GitHub repo's docs / issues / commits |
| `zai_github_read_file`  | Read a file from a GitHub repo                 |
| `zai_github_structure`  | List a GitHub repo's directory contents        |

## Installation

The extension is loaded from `.pi/extensions/zai/`. Configure your API key in `~/.pi/agent/auth.json`:

```json
{
  "zai": {
    "key": "your-zai-api-key-here"
  }
}
```

Then start pi-agent:

```bash
pi -e ./.pi/extensions/zai/index.ts
```

On session start the extension verifies the key shape and warns if it looks malformed (whitespace, quotes, placeholders).

## Diagnostics

When something goes wrong, the extension surfaces a typed `ZaiMcpError` with a `kind` discriminator. Each failure mode has a distinct, actionable message:

| kind             | When it fires                                   | Example                                                        |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `gateway-auth`   | Wrong/expired key, or missing Authorization     | `Z AI gateway error 401: token expired or incorrect`           |
| `init-failed`    | MCP handshake didn't return `result`            | `MCP initialize HTTP 502 Bad Gateway`                          |
| `tool-error`     | The tool ran but the server rejected the inputs | `Tool execution error: …`                                      |
| `rpc-error`      | JSON-RPC protocol error                         | `MCP error -32601: Method not found`                           |
| `http`           | Non-2xx HTTP at tool call (retried for 5xx)     | `MCP tool call HTTP 502 Bad Gateway`                           |
| `parse-error`    | Body wasn't SSE, JSON, or a gateway envelope    | `Unexpected MCP response (not SSE, not JSON)`                  |
| `timeout`        | Request didn't complete within `timeoutMs`      | `Request timed out after 60000ms`                              |
| `aborted`        | Caller-provided `AbortSignal` fired             | `Request aborted by caller`                                    |
| `no-result`      | Server returned 200 but no payload              | `MCP tool call returned no result`                             |

**Common failure cures:**

- `Z AI gateway error 401: token expired or incorrect` — rotate the key in `~/.pi/agent/auth.json`.
- `Z AI gateway error 1001: Authentication parameter not received…` — internal: the Authorization header was stripped; check proxy/agent config.
- `Z AI auth file at … is not valid JSON` — fix the JSON; the file was edited while pi-agent was running.
- A startup warning like *"API key looks malformed (contains whitespace)"* means the file content has shell-quoting artifacts.

## Development

```bash
bun install
bun run lint          # oxlint
bun run typecheck     # tsc --noEmit
bun test              # 42 unit tests, no network
bun run test:integration  # live API smoke tests (requires valid key)
bun run probe         # raw HTTP probe — prints request/response with the key redacted
bun run check         # lint + typecheck + unit tests
```

## Architecture

- **`src/zai-client.ts`** — `ZaiMcpClient`, auth loader, response parser. No pi-agent imports → unit-testable.
- **`index.ts`** — tool definitions + extension factory. Tiny by design.
- **`test/zai-client.test.ts`** — 42 unit tests covering every error path. Fetch is mocked, no network.
- **`test-integration.ts`** — live API smoke tests, run on demand.
- **`scripts/probe.ts`** — manual debugging tool. Prints raw HTTP requests/responses with the key redacted; useful for reporting issues to Z AI.

## License

MIT
