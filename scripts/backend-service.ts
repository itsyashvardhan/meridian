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

console.log(`[Meridian Backend & WebSocket Service] running permanently on port ${SERVER_PORT}`);

// Keep process alive indefinitely
setInterval(() => {}, 1000 << 16);
