# Security Policy

## Supported versions

Only the latest published minor release of each `@agentlensjs/*` package receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/YoungDan-hero/agentlens/security/advisories/new) — do **not** open a public issue for security problems.

You can expect an initial response within 72 hours. Once a fix is released, the advisory will be published with credit to the reporter (unless you prefer to stay anonymous).

## Scope notes

AgentLens is a development-time tool. Its security posture is documented in the [Privacy & data safety](./README.md#privacy--data-safety) section of the README: the daemon binds to loopback only, rejects WebSocket handshakes from non-local origins, never captures request headers or form values, and redacts sensitive URL parameters and body fields inside the browser before anything is transmitted.
