# Contributing

Thanks for your interest in improving `askgrokmcp`.

## Development setup

1. Clone the repository.
2. Install dependencies:

```bash
npm install
```

3. Run a quick syntax check:

```bash
node --check grok-mcp.mjs
```

## Code guidelines

- Keep changes small and focused.
- Preserve MCP stdio safety: never log to stdout.
- Prefer configuration via environment variables for runtime behavior.
- Update `README.md` when adding or changing user-facing behavior.

## Pull requests

- Use clear commit messages describing the intent.
- Include a concise description of what changed and why.
- Mention manual verification steps you ran locally.
