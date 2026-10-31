<div align="center">

# Meridian

**PII-safe local workspace for everyone.**

An enterprise-grade, privacy-first local workspace and AI assistant environment running entirely on your infrastructure. Meridian strips and tokenizes PII reversibly before sending queries to reasoning models, keeping data within your compliance boundaries while providing full agent orchestration.

[**Quick Start**](#quick-start) · [**Architecture**](#architecture) · [**PII Shield**](#pii-shield) · [**Configuration**](docs/configuration.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Status: Production Ready](https://img.shields.io/badge/status-active-green.svg)

</div>

---

## What is Meridian?

Meridian provides a secure, self-hosted workspace with built-in multi-agent orchestration and an agnostic PII layer. Every coworker, agent, and tool runs with least-privilege boundary access, persistent sandboxes, and zero external telemetry leakage.

- **PII-Safe Middleware**: Automatically redacts and tokenizes sensitive entities (SSNs, API keys, card numbers, emails, phone numbers) before model ingress, reversibly restoring them on output.
- **Local-First & Edge Reasoning**: Seamlessly powered by `gemma4-e2b-it` alongside custom OpenAI-, Anthropic-, and Google-compatible endpoints.
- **Isolated Execution & Real Browsers**: Every coworker operates inside designated containers with audit logging for every DOM and network action.
- **Customizable Experience**: Supports multiple interface frames and themes while preserving core enterprise controls and brand configurations.

---

## Quick Start

### 1. Requirements
- [Bun](https://bun.sh/) (v1.2+) or Node.js (v20+)
- PostgreSQL (or embedded container mode)

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

The Meridian workspace is accessible by default at [http://localhost:3010](http://localhost:3010).

---

## PII Shield

Meridian ships with an agnostic PII layer in `shared/pii` providing zero-latency deterministic tokenization:

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

## Development & Testing

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
