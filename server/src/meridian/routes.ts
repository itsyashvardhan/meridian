import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import { MERIDIAN_BOTS, MERIDIAN_SKILLS, toolNamesFor } from "./catalog";
import { modelConfigFromEnv } from "./model";
import { clampResult, MERIDIAN_TOOLS } from "./tools";

const TOOL_TIMEOUT_MS = 20_000;

/**
 * `/api/meridian`: the bot and skill catalogue, and running one of a bot's tools by hand. A bot may
 * only run the tools its skills name, and an outward-facing tool runs only with `confirmed: true`.
 */
export function createMeridianRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/catalog", (context) => {
    context.header("Cache-Control", "no-store");
    const models = modelConfigFromEnv();
    return context.json({
      bots: MERIDIAN_BOTS.map((bot) => ({
        ...bot,
        tools: toolNamesFor(bot),
      })),
      skills: MERIDIAN_SKILLS,
      tools: MERIDIAN_TOOLS.map(({ name, description, parameters, requiresApproval }) => ({
        name,
        description,
        parameters,
        requiresApproval: Boolean(requiresApproval),
      })),
      models: {
        fast: models["gemma4-e2b"].model,
        deep: models["gemma4-e4b"].model,
        configured: Boolean(models["gemma4-e2b"].apiKey),
      },
    });
  });

  app.post(
    "/tools/:name",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (context) => context.json({ error: "That request is too large." }, 413),
    }),
    async (context) => {
      context.header("Cache-Control", "no-store");
      // A cross-origin form cannot send JSON without a preflight this route never grants.
      if (context.req.header("content-type")?.split(";")[0]?.trim() !== "application/json")
        return context.json({ error: "A JSON request is required." }, 415);
      const body = (await context.req.json().catch(() => null)) as {
        botId?: unknown;
        args?: unknown;
        confirmed?: unknown;
      } | null;
      if (!body || typeof body.botId !== "string")
        return context.json({ error: "Choose a Bot first." }, 400);
      const bot = MERIDIAN_BOTS.find((item) => item.id === body.botId);
      if (!bot) return context.json({ error: "There is no such Bot." }, 404);
      const name = context.req.param("name");
      const tool = MERIDIAN_TOOLS.find((item) => item.name === name);
      if (!tool || !toolNamesFor(bot).includes(name))
        return context.json({ error: `${bot.name} can't use that tool.` }, 403);
      if (tool.requiresApproval && body.confirmed !== true)
        return context.json(
          { error: "This tool sends something outside Meridian. Confirm to run it.", needsApproval: true },
          409,
        );
      const args =
        body.args && typeof body.args === "object" && !Array.isArray(body.args)
          ? (body.args as Record<string, unknown>)
          : {};
      const started = performance.now();
      try {
        const result = await tool.execute(args, {
          botId: bot.id,
          signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
        });
        return context.json({
          ok: true,
          result: clampResult(result),
          ms: Math.round(performance.now() - started),
        });
      } catch (error) {
        return context.json({
          ok: false,
          result: error instanceof Error ? error.message : "The tool failed.",
          ms: Math.round(performance.now() - started),
        });
      }
    },
  );

  return app;
}
