import { spawn } from "node:child_process";

const SERVER_PORT = Number(process.env.SERVER_PORT || 3001);

const devUser = {
  id: "dev-local-user",
  name: "Meridian Engineer",
  email: "dev@meridian.local",
  role: "admin",
  image: null,
  onboarding: null,
};

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

    if (url.pathname === "/api/channels") {
      return new Response(JSON.stringify({ channels: [] }), { headers });
    }

    if (url.pathname === "/api/agents" || url.pathname === "/api/bots") {
      return new Response(JSON.stringify({ agents: [] }), { headers });
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
