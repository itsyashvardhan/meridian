import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { parse } from "yaml";
import { createMeridianRoutes } from "../server/src/meridian/routes";

const SERVER_PORT = Number(process.env.SERVER_PORT || 3001);

const devUser = {
  id: "dev-local-user",
  name: "Meridian Engineer",
  email: "dev@meridian.local",
  role: "admin",
  image: null,
  onboarding: null,
};

function loadPrebuiltBots() {
  const bots: any[] = [
    {
      id: "general-assistant",
      name: "General Assistant",
      title: "Everyday Work",
      roleDescription: "Help with everyday work using clear, concise, and accurate answers.",
      avatarSeed: "general-assistant",
      visibility: "public",
      endpoint: null,
      builtIn: true,
      hasAuth: false,
      hasCallbackToken: true,
      hidden: false,
      pinned: true,
      assignedToMe: false,
      systemOwned: true,
      canManage: true,
      mine: false,
      isolated: false,
      isolationActive: false,
      isolationOffReason: null,
    },
    {
      id: "knowledge",
      name: "Knowledge",
      title: "Company Knowledge",
      roleDescription: "Help answer company knowledge questions and cite sources when available.",
      avatarSeed: "knowledge",
      visibility: "public",
      endpoint: null,
      builtIn: true,
      hasAuth: false,
      hasCallbackToken: true,
      hidden: false,
      pinned: true,
      assignedToMe: false,
      systemOwned: true,
      canManage: true,
      mine: false,
      isolated: false,
      isolationActive: false,
      isolationOffReason: null,
    },
  ];

  try {
    const catalogDir = path.resolve(process.cwd(), "examples/fintech/catalog");
    if (fs.existsSync(catalogDir)) {
      const files = fs.readdirSync(catalogDir).filter((f) => f.endsWith(".yaml"));
      for (const file of files) {
        const doc = parse(fs.readFileSync(path.join(catalogDir, file), "utf8"));
        if (doc && doc.id && !bots.some((b) => b.id === doc.id)) {
          bots.push({
            id: doc.id,
            name: doc.name || doc.id,
            title: doc.title || "",
            roleDescription: doc.role_description || "",
            avatarSeed: doc.avatar_seed || doc.id,
            visibility: "public",
            endpoint: null,
            builtIn: true,
            hasAuth: false,
            hasCallbackToken: true,
            hidden: false,
            pinned: false,
            assignedToMe: false,
            systemOwned: true,
            canManage: true,
            mine: false,
            isolated: false,
            isolationActive: false,
            isolationOffReason: null,
          });
        }
      }
    }
  } catch (err) {
    console.error("Failed loading catalog prebuilt bots:", err);
  }

  return bots;
}

const prebuiltBots = loadPrebuiltBots();

// The real Meridian catalogue and tool routes, behind a stand-in for the session guard.
const meridianRoutes = new Hono().route(
  "/api/meridian",
  createMeridianRoutes(async (context, next) => {
    context.set("actor", devUser as never);
    await next();
  }),
);

const server = Bun.serve({
  port: SERVER_PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade handling for /api/channels/events and others
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const upgraded = server.upgrade(req, {
        data: {
          url: req.url,
          path: url.pathname,
          createdAt: Date.now(),
        },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-meridian-engine",
        },
      });
    }

    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    if (url.pathname.startsWith("/api/meridian/")) {
      return meridianRoutes.fetch(req);
    }

    if (url.pathname === "/api/me") {
      return new Response(JSON.stringify({ user: devUser }), { headers });
    }

    if (url.pathname === "/api/me/profile") {
      return new Response(JSON.stringify({ profile: devUser }), { headers });
    }

    if (url.pathname === "/api/admin/enterprise/me") {
      return new Response(
        JSON.stringify({
          capabilities: {
            isolatedComputers: true,
          },
          enforced: false,
        }),
        { headers }
      );
    }

    if (url.pathname === "/api/agents/capabilities") {
      return new Response(
        JSON.stringify({
          capabilities: {
            builtInAvailable: true,
            isolationAvailable: true,
          },
        }),
        { headers }
      );
    }

    if (url.pathname === "/api/copilotkit/info" || url.pathname === "/api/copilotkit/x/info") {
      return new Response(
        JSON.stringify({
          actions: {},
          agents: {},
          actionsMap: {},
          agentStates: {},
        }),
        { headers }
      );
    }

    if (url.pathname === "/api/bots/attention") {
      return new Response(JSON.stringify({ bots: [] }), { headers });
    }

    if (url.pathname === "/api/settings/preferences") {
      return new Response(
        JSON.stringify({
          preferences: {
            theme: "dark",
            skin: "meridian",
          },
        }),
        { headers }
      );
    }

    if (url.pathname === "/api/admin/status" || url.pathname === "/api/admin/enterprise") {
      return new Response(JSON.stringify({ status: "healthy", engine: "meridian" }), { headers });
    }

    if (url.pathname === "/api/voice/config") {
      return new Response(JSON.stringify({ transport: "webrtc", provider: "openflow-realtime" }), { headers });
    }

    if (url.pathname === "/api/plugins/giveable") {
      return new Response(JSON.stringify({ apps: [] }), { headers });
    }

    if (url.pathname === "/api/plugins/connections") {
      return new Response(JSON.stringify({ connections: [] }), { headers });
    }

    if (url.pathname === "/api/plugins") {
      return new Response(
        JSON.stringify({
          catalogue: [],
          servers: [],
          skills: [],
          botsMayCallBack: false,
          redirectUri: null,
          composioConfigured: false,
        }),
        { headers }
      );
    }

    if (url.pathname === "/api/identity/links") {
      return new Response(JSON.stringify({ links: [] }), { headers });
    }

    if (url.pathname === "/api/identity/providers") {
      return new Response(JSON.stringify({ providers: [] }), { headers });
    }

    if (url.pathname === "/api/recorder/connections") {
      return new Response(JSON.stringify({ connections: [], extensionIds: [] }), { headers });
    }

    if (url.pathname === "/api/delivery") {
      return new Response(
        JSON.stringify({
          bindings: [],
          devices: [],
          deliveries: [],
          available: { slack: false, teams: false, sms: false, push: false },
        }),
        { headers }
      );
    }

    if (url.pathname === "/api/channels") {
      return new Response(JSON.stringify({ channels: [] }), { headers });
    }

    if (url.pathname === "/api/passwords") {
      return new Response(JSON.stringify({ passwordManager: true, logins: [] }), { headers });
    }

    if (url.pathname === "/api/components") {
      return new Response(JSON.stringify({ components: [] }), { headers });
    }

    if (url.pathname === "/api/audit" || url.pathname === "/api/admin/audit") {
      return new Response(JSON.stringify({ events: [], rows: [] }), { headers });
    }

    if (url.pathname === "/api/enterprise/model-usage") {
      return new Response(JSON.stringify({ summary: [] }), { headers });
    }

    if (url.pathname === "/api/enterprise/actions") {
      return new Response(JSON.stringify([]), { headers });
    }

    if (url.pathname === "/api/computers") {
      return new Response(JSON.stringify({ computers: [] }), { headers });
    }

    if (url.pathname.startsWith("/api/computers/") && url.pathname.endsWith("/control")) {
      return new Response(JSON.stringify({ active: false, status: "idle" }), { headers });
    }

    if (url.pathname === "/api/skills" || url.pathname === "/api/admin/skills") {
      return new Response(JSON.stringify({ skills: [] }), { headers });
    }

    if (url.pathname === "/api/agents" || url.pathname === "/api/bots") {
      return new Response(JSON.stringify({ agents: prebuiltBots }), { headers });
    }

    if (url.pathname.startsWith("/api/agents/") || url.pathname.startsWith("/api/bots/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const agentId = decodeURIComponent(parts[2] || "");
      const found = prebuiltBots.find((b) => b.id === agentId);
      if (found) {
        if (parts[3] === "lifecycle") {
          return new Response(
            JSON.stringify({
              lifecycle: {
                state: "ready",
                agentId: found.id,
                hasActiveConversation: false,
                lastSeenAt: new Date().toISOString(),
              },
            }),
            { headers }
          );
        }
        if (parts[3] === "activity") {
          return new Response(JSON.stringify({ activity: [] }), { headers });
        }
        return new Response(JSON.stringify({ agent: found }), { headers });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers });
  },

  websocket: {
    open(ws) {
      console.log(`[Meridian WS] Connection opened on ${ws.data?.path || "socket"}`);
      ws.send(JSON.stringify({ type: "channel.events.ready", payload: { channels: [] } }));
    },
    message(ws, message) {
      try {
        const data = typeof message === "string" ? JSON.parse(message) : {};
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          return;
        }
        ws.send(JSON.stringify({ type: "ack", echo: data }));
      } catch {
        ws.send(JSON.stringify({ type: "ack", raw: String(message) }));
      }
    },
    close(ws) {
      console.log(`[Meridian WS] Connection closed on ${ws.data?.path || "socket"}`);
    },
  },
});

console.log(
  `[Meridian Backend & WebSocket Service] listening on http://127.0.0.1:${SERVER_PORT} and ws://127.0.0.1:${SERVER_PORT}`
);

// Start Vite App Frontend
const viteProcess = spawn("bun", ["--bun", "run", "--filter", "app", "dev"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.on("SIGINT", () => {
  server.stop();
  viteProcess.kill();
  process.exit(0);
});
