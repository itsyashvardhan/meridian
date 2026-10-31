import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP, Socket } from "node:net";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { MeridianEngine } from "../voice/meridian-engine";

export type ToolContext = { signal: AbortSignal; botId: string };

export type MeridianTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Outward-facing: the live session asks the person before it runs. */
  requiresApproval?: boolean;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
};

const MAX_RESULT_CHARS = 8_000;
const FETCH_TIMEOUT_MS = 12_000;

export function clampResult(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated ${text.length - MAX_RESULT_CHARS} chars]`
    : text;
}

function str(args: Record<string, unknown>, key: string, required = true) {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  if (required) throw new Error(`Missing argument "${key}".`);
  return undefined;
}

function timeoutSignal(signal: AbortSignal, ms = FETCH_TIMEOUT_MS) {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

// --- calculator: a small recursive-descent parser, never eval ---

const FUNCTIONS: Record<string, (...xs: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  ln: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

export function evaluateExpression(source: string): number {
  const tokens = source.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[a-z_]+\d*|[-+*/^%(),]/gi);
  if (!tokens || tokens.join("") !== source.replace(/\s+/g, "")) {
    throw new Error("Unsupported characters in expression.");
  }
  let index = 0;
  const peek = () => tokens[index];
  const take = (expected?: string) => {
    const token = tokens[index++];
    if (expected && token !== expected) throw new Error(`Expected "${expected}".`);
    if (token === undefined) throw new Error("Unexpected end of expression.");
    return token;
  };
  const primary = (): number => {
    const token = take();
    if (token === "(") {
      const value = sum();
      take(")");
      return value;
    }
    if (token === "-") return -power();
    if (token === "+") return power();
    if (/^\d/.test(token)) return Number(token);
    const lower = token.toLowerCase();
    if (lower === "pi") return Math.PI;
    if (lower === "e") return Math.E;
    const fn = FUNCTIONS[lower];
    if (!fn) throw new Error(`Unknown function "${token}".`);
    take("(");
    const args = [sum()];
    while (peek() === ",") {
      take(",");
      args.push(sum());
    }
    take(")");
    return fn(...args);
  };
  const power = (): number => {
    const base = primary();
    if (peek() === "^") {
      take("^");
      return base ** power();
    }
    return base;
  };
  const product = (): number => {
    let value = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take();
      const right = power();
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      value = take() === "+" ? value + product() : value - product();
    }
    return value;
  };
  const result = sum();
  if (index !== tokens.length) throw new Error("Unexpected trailing input.");
  return result;
}

// --- web ---

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(host) === 6) return host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80");
  return false;
}

export function assertPublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http and https URLs can be fetched.");
  if (isPrivateHost(url.hostname) && process.env.MERIDIAN_ALLOW_PRIVATE_FETCH !== "1")
    throw new Error("Private and loopback addresses are not fetched by web_fetch.");
  return url;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// --- github ---

async function github(path: string, signal: AbortSignal) {
  const token = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "meridian-live",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: timeoutSignal(signal),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body ? String(body.message) : "";
    throw new Error(`GitHub answered ${response.status}${message ? `: ${message}` : ""}.`);
  }
  return body;
}

function repoArg(args: Record<string, unknown>) {
  const repo = str(args, "repo")!;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like "owner/name".');
  return repo;
}

// --- database (read-only) ---

let sqlClient: ReturnType<typeof postgres> | null = null;
function database() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("No DATABASE_URL is configured for this workspace.");
  sqlClient ??= postgres(url, { max: 2, idle_timeout: 30, prepare: false });
  return sqlClient;
}

const READ_ONLY_SQL = /^\s*(select|with|explain|show|table|values)\b/i;

export function assertReadOnlySql(query: string): string {
  const trimmed = query.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) throw new Error("One statement at a time.");
  if (!READ_ONLY_SQL.test(trimmed))
    throw new Error("Only SELECT, WITH, EXPLAIN, SHOW, TABLE and VALUES are allowed.");
  if (/^\s*explain\b[\s\S]*\banalyze\b/i.test(trimmed))
    throw new Error("EXPLAIN ANALYZE executes the statement; use plain EXPLAIN.");
  return trimmed;
}

async function readOnly<T>(run: (sql: postgres.TransactionSql) => Promise<T>) {
  return database().begin("read only", async (sql) => {
    await sql`set local statement_timeout = 5000`;
    return run(sql);
  });
}

// --- memory: a JSON file next to the process, mirrored into the native store ---

type MemoryEntry = { key: string; content: string; botId: string; savedAt: string };
const memoryPath = () =>
  resolve(process.env.MERIDIAN_MEMORY_FILE ?? ".meridian/live-memory.json");

function loadMemory(): MemoryEntry[] {
  try {
    return JSON.parse(readFileSync(memoryPath(), "utf8")) as MemoryEntry[];
  } catch {
    return [];
  }
}

function storeMemory(entries: MemoryEntry[]) {
  mkdirSync(dirname(memoryPath()), { recursive: true });
  writeFileSync(memoryPath(), JSON.stringify(entries.slice(-500), null, 2));
}

// --- infra ---

function probePort(host: string, port: number, signal: AbortSignal) {
  return new Promise<{ open: boolean; latencyMs: number; error?: string }>((done) => {
    const started = performance.now();
    const socket = new Socket();
    const finish = (open: boolean, error?: string) => {
      socket.destroy();
      done({ open, latencyMs: Math.round(performance.now() - started), error });
    };
    socket.setTimeout(3_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => finish(false, error.message));
    signal.addEventListener("abort", () => finish(false, "aborted"), { once: true });
    socket.connect(port, host);
  });
}

export const MERIDIAN_TOOLS: readonly MeridianTool[] = [
  {
    name: "calculator",
    description:
      "Evaluate an arithmetic expression exactly. Supports + - * / ^ %, parentheses, pi, e, sqrt, abs, round, floor, ceil, ln, log10, exp, min, max, pow.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    async execute(args) {
      const expression = str(args, "expression")!;
      return { expression, result: evaluateExpression(expression) };
    },
  },
  {
    name: "current_time",
    description: "The current date and time, optionally in an IANA time zone.",
    parameters: {
      type: "object",
      properties: { timeZone: { type: "string", description: "e.g. Asia/Kolkata" } },
    },
    async execute(args) {
      const timeZone = str(args, "timeZone", false) ?? "UTC";
      const now = new Date();
      return {
        iso: now.toISOString(),
        local: now.toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "long" }),
        timeZone,
      };
    },
  },
  {
    name: "web_search",
    description: "Search the public web. Returns titles, URLs and snippets.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async execute(args, { signal }) {
      const query = str(args, "query")!;
      const response = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        { headers: { "User-Agent": "Mozilla/5.0 meridian-live" }, signal: timeoutSignal(signal) },
      );
      if (!response.ok) throw new Error(`Search answered ${response.status}.`);
      const html = await response.text();
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const pattern =
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      for (const match of html.matchAll(pattern)) {
        let url = match[1]!;
        const redirect = /[?&]uddg=([^&]+)/.exec(url);
        if (redirect) url = decodeURIComponent(redirect[1]!);
        results.push({ title: htmlToText(match[2]!), url, snippet: htmlToText(match[3]!) });
        if (results.length >= 6) break;
      }
      return { query, results };
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a public web page and return its readable text.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(args, { signal }) {
      const url = assertPublicUrl(str(args, "url")!);
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 meridian-live" },
        redirect: "follow",
        signal: timeoutSignal(signal),
      });
      assertPublicUrl(response.url || url.toString());
      const type = response.headers.get("content-type") ?? "";
      const body = (await response.text()).slice(0, 400_000);
      const text = type.includes("html") ? htmlToText(body) : body;
      return { url: response.url, status: response.status, text: text.slice(0, 6_000) };
    },
  },
  {
    name: "github_repo",
    description: "Describe a GitHub repository: stars, open issues, default branch, last push.",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "owner/name" } },
      required: ["repo"],
    },
    async execute(args, { signal }) {
      const repo = (await github(`/repos/${repoArg(args)}`, signal)) as Record<string, unknown>;
      return {
        fullName: repo.full_name,
        description: repo.description,
        stars: repo.stargazers_count,
        openIssues: repo.open_issues_count,
        defaultBranch: repo.default_branch,
        language: repo.language,
        pushedAt: repo.pushed_at,
        url: repo.html_url,
      };
    },
  },
  {
    name: "github_search_issues",
    description: "Search issues and pull requests in a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        query: { type: "string", description: "free text, labels, e.g. is:open label:bug" },
      },
      required: ["repo"],
    },
    async execute(args, { signal }) {
      const q = `repo:${repoArg(args)} ${str(args, "query", false) ?? "is:open"}`;
      const body = (await github(
        `/search/issues?per_page=10&q=${encodeURIComponent(q)}`,
        signal,
      )) as { total_count: number; items: Array<Record<string, unknown>> };
      return {
        total: body.total_count,
        items: body.items.map((item) => ({
          number: item.number,
          title: item.title,
          state: item.state,
          isPullRequest: Boolean(item.pull_request),
          labels: (item.labels as Array<{ name: string }>).map((label) => label.name),
          url: item.html_url,
        })),
      };
    },
  },
  {
    name: "github_list_pulls",
    description: "List pull requests in a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["repo"],
    },
    async execute(args, { signal }) {
      const state = str(args, "state", false) ?? "open";
      const pulls = (await github(
        `/repos/${repoArg(args)}/pulls?per_page=10&state=${encodeURIComponent(state)}`,
        signal,
      )) as Array<Record<string, unknown>>;
      return pulls.map((pull) => ({
        number: pull.number,
        title: pull.title,
        author: (pull.user as { login?: string } | null)?.login,
        draft: pull.draft,
        url: pull.html_url,
      }));
    },
  },
  {
    name: "github_list_branches",
    description: "List branches in a GitHub repository.",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "owner/name" } },
      required: ["repo"],
    },
    async execute(args, { signal }) {
      const branches = (await github(
        `/repos/${repoArg(args)}/branches?per_page=30`,
        signal,
      )) as Array<{ name: string; protected: boolean }>;
      return branches.map((branch) => ({ name: branch.name, protected: branch.protected }));
    },
  },
  {
    name: "slack_post",
    description: "Post a message to the team Slack channel. Asks the person to approve first.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(args, { signal }) {
      const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
      if (!webhook) throw new Error("No SLACK_WEBHOOK_URL is configured, so nothing was posted.");
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: str(args, "text") }),
        signal: timeoutSignal(signal),
      });
      if (!response.ok) throw new Error(`Slack answered ${response.status}.`);
      return { posted: true };
    },
  },
  {
    name: "db_list_tables",
    description: "List the workspace database's tables with estimated row counts.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return readOnly(
        (sql) => sql`
          select schemaname as schema, relname as table, n_live_tup as estimated_rows
          from pg_stat_user_tables order by schemaname, relname limit 200`,
      );
    },
  },
  {
    name: "db_query",
    description:
      "Run one read-only SQL statement (SELECT/WITH/EXPLAIN/SHOW) against the workspace database. At most 100 rows.",
    parameters: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    },
    async execute(args) {
      const query = assertReadOnlySql(str(args, "sql")!);
      const rows = await readOnly((sql) => sql.unsafe(query));
      return { rowCount: rows.length, rows: rows.slice(0, 100) };
    },
  },
  {
    name: "port_check",
    description: "Check whether a TCP port accepts connections.",
    parameters: {
      type: "object",
      properties: { host: { type: "string" }, port: { type: "number" } },
      required: ["host", "port"],
    },
    async execute(args, { signal }) {
      const host = str(args, "host")!;
      const port = Number(args.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
      return { host, port, ...(await probePort(host, port, signal)) };
    },
  },
  {
    name: "http_health",
    description: "GET an HTTP endpoint and report status code and latency.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(args, { signal }) {
      const url = new URL(str(args, "url")!);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Only http and https URLs can be checked.");
      const started = performance.now();
      const response = await fetch(url, { signal: timeoutSignal(signal, 5_000) });
      await response.body?.cancel();
      return {
        url: url.toString(),
        status: response.status,
        ok: response.ok,
        latencyMs: Math.round(performance.now() - started),
      };
    },
  },
  {
    name: "memory_save",
    description: "Remember a durable fact for later live sessions.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "short topic" },
        content: { type: "string" },
      },
      required: ["key", "content"],
    },
    async execute(args, { botId }) {
      const entry = {
        key: str(args, "key")!,
        content: str(args, "content")!,
        botId,
        savedAt: new Date().toISOString(),
      };
      storeMemory([...loadMemory().filter((item) => item.key !== entry.key), entry]);
      MeridianEngine.upsertMemory(`live-memory:${entry.key}`, entry.content);
      return { saved: entry.key };
    },
  },
  {
    name: "memory_recall",
    description: "Recall remembered facts matching a few keywords.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async execute(args) {
      const words = str(args, "query")!.toLowerCase().split(/\W+/).filter(Boolean);
      const scored = loadMemory()
        .map((entry) => {
          const haystack = `${entry.key} ${entry.content}`.toLowerCase();
          return { entry, score: words.filter((word) => haystack.includes(word)).length };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return scored.map(({ entry }) => entry);
    },
  },
];

export function toolsByName(names: string[]): MeridianTool[] {
  return names
    .map((name) => MERIDIAN_TOOLS.find((tool) => tool.name === name))
    .filter((tool): tool is MeridianTool => Boolean(tool));
}
