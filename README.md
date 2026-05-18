# Z AI Extension for pi-agent

A pi-agent extension that integrates Z AI's web search, web reader, and GitHub reader services.

## Features

- **Web Search Prime** - Search the web with recency filters and domain filtering
- **Web Reader** - Fetch and read web pages as markdown or plain text
- **GitHub Reader** - Search docs/issues/commits, read files, and explore repo structures on GitHub

## Installation

This extension is already installed in `.pi/extensions/zai/`. Ensure your `~/.pi/agent/auth.json` contains your ZAI API key:

```json
{
  "zai": {
    "key": "your-zai-api-key-here"
  }
}
```

## Usage

Start pi-agent with the extension:

```bash
pi -e ./.pi/extensions/zai/index.ts
```

The extension will auto-load from `.pi/extensions/` and register 5 new tools:

1. `zai_web_search` - Search the web
2. `zai_web_reader` - Read web page content
3. `zai_github_search` - Search GitHub repos
4. `zai_github_read_file` - Read files from GitHub
5. `zai_github_structure` - Explore GitHub repo structure

## Development

Install dependencies and run linting with bun and oxlint:

```bash
cd .pi/extensions/zai
bun install
bun run lint
bun run typecheck
```

## API Documentation

The extension uses Z AI's direct HTTP API with JSON-RPC 2.0 over SSE. For full API details, see the [Z AI Web API Documentation](https://api.z.ai/docs).

## License

MIT