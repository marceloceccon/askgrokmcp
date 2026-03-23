# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by opening a security advisory on GitHub:

- [GitHub Security Advisories](https://github.com/marceloceccon/askgrokmcp/security/advisories)

Do not open public issues for undisclosed vulnerabilities.

## Scope

This project handles:

- xAI API authentication via `XAI_API_KEY`
- Local file writes for generated images (constrained by `SAFE_WRITE_BASE_DIR`)
- MCP tool requests over stdio

## Security best practices

- Use least-privilege API keys.
- Keep `SAFE_WRITE_BASE_DIR` restricted to a controlled directory.
- Leave `LOG_REQUEST_PAYLOADS` disabled unless required for debugging.
