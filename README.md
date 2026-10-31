<div align="center">

# Meridian

**PII-safe local workspace for self-hosted teams.**

A local workspace and assistant environment that runs entirely on your infrastructure. Meridian strips and tokenizes sensitive data before queries reach external models, then restores the original values when responses return.

[**Quick start**](#quick-start) · [**Architecture**](docs/architecture.md) · [**PII shield**](#pii-shield) · [**Configuration**](docs/configuration.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Status: Production Ready](https://img.shields.io/badge/status-active-green.svg)

</div>

---

## What Meridian does

Meridian runs agents, tools, and background tasks on private infrastructure without telemetry.

- **Reversible tokenization.** Replaces SSNs, API keys, card numbers, emails, and phone numbers with tokens before model ingress, then restores the original text on egress.
- **Local edge models.** Routes fast conversational turns to `gemma4-e2b-it` and passes complex tasks to local or remote endpoints.
- **Sandboxed execution.** Agents run inside isolated containers with audit logs for DOM interactions and network requests.
- **Configurable themes.** Supports custom brand definitions via configuration files without code changes.

---

## Quick start

### 1. Requirements
- Bun 1.2+ or Node.js 20+
- PostgreSQL or embedded container mode

### 2. Setup

```sh
# Copy environment template
cp .env.example .env

# Install dependencies across workspaces
bun install

# Generate application config
bun run generate:app-config

# Launch local development servers
bun run dev
```

The workspace listens at [http://localhost:3010](http://localhost:3010).

---

## PII shield

Meridian includes deterministic entity masking in `shared/pii`:

```typescript
import { anonymizePii, deanonymizePii } from "@openbot/shared/pii/anonymizer";

const { anonymizedText, tokenMap } = anonymizePii(
  "Please reach out to jane@example.com or +1 555-019-2834."
);
// Payload sent to external LLM:
// "Please reach out to <PII_EMAIL_1> or <PII_PHONE_NUMBER_2>."

const output = deanonymizePii(llmResponse, tokenMap);
// Clean, restored output returned to user
```

---

## Development and testing

```sh
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
```

---

## License

[MIT](./LICENSE) © Meridian Team
