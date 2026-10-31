import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageCard, PageSection } from "@/components/layout/page-parts";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { runMeridianToolMutationOptions } from "@/lib/meridian/mutations";
import {
  type MeridianBot,
  type MeridianTool,
  meridianCatalogQueryOptions,
} from "@/lib/meridian/queries";
import { cn } from "@/lib/utils";

/**
 * The Meridian coworkers: pick a Bot, see the skills it holds, and run any of its tools by hand.
 */
export function LivePage() {
  const catalog = useQuery(meridianCatalogQueryOptions());
  const [botId, setBotId] = useState<string>();
  const bot = catalog.data?.bots.find((item) => item.id === botId) ?? catalog.data?.bots[0];

  return (
    <PageShell
      title="Live"
      width="full"
      description="Meridian's coworker Bots, the skills they hold, and the tools those skills give them."
    >
      {catalog.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : catalog.isError ? (
        <p className="text-sm text-destructive">{catalog.error.message}</p>
      ) : (
        <div className="flex flex-col gap-8">
          <p className="text-sm text-muted-foreground">
            Fast model {catalog.data.models.fast} · Deep model {catalog.data.models.deep} ·{" "}
            {catalog.data.models.configured
              ? "Model key configured"
              : "No model key configured"}
          </p>
          <PageSection title="Bots">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {catalog.data.bots.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setBotId(item.id)}
                  aria-pressed={item.id === bot?.id}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors hover:bg-muted",
                    item.id === bot?.id && "border-foreground bg-muted",
                  )}
                >
                  <div className="text-sm font-medium">{item.name}</div>
                  <div className="text-xs text-muted-foreground">{item.title}</div>
                </button>
              ))}
            </div>
          </PageSection>
          {bot ? <BotDetail bot={bot} catalog={catalog.data} /> : null}
        </div>
      )}
    </PageShell>
  );
}

function BotDetail({
  bot,
  catalog,
}: {
  bot: MeridianBot;
  catalog: { skills: { slug: string; title: string; summary: string }[]; tools: MeridianTool[] };
}) {
  return (
    <>
      <PageSection title={bot.name} description={bot.role}>
        <div className="flex flex-wrap gap-2">
          {bot.skills.map((slug) => {
            const skill = catalog.skills.find((item) => item.slug === slug);
            return skill ? (
              <span
                key={slug}
                title={skill.summary}
                className="rounded-md bg-muted px-2 py-1 text-xs"
              >
                {skill.title}
              </span>
            ) : null;
          })}
        </div>
      </PageSection>
      <PageSection title="Tools">
        <div className="flex flex-col gap-3">
          {bot.tools.map((name) => {
            const tool = catalog.tools.find((item) => item.name === name);
            return tool ? <ToolRunner key={`${bot.id}:${name}`} botId={bot.id} tool={tool} /> : null;
          })}
        </div>
      </PageSection>
    </>
  );
}

function ToolRunner({ botId, tool }: { botId: string; tool: MeridianTool }) {
  const fields = Object.entries(tool.parameters.properties ?? {});
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const run = useMutation(runMeridianToolMutationOptions());
  const missing = (tool.parameters.required ?? []).some((key) => !values[key]?.trim());

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const args: Record<string, unknown> = {};
    for (const [key, schema] of fields) {
      const value = values[key]?.trim();
      if (!value) continue;
      args[key] = schema.type === "number" ? Number(value) : value;
    }
    run.mutate({ botId, tool: tool.name, args, confirmed });
  };

  return (
    <PageCard>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <div>
          <div className="font-mono text-sm">{tool.name}</div>
          <div className="text-xs text-muted-foreground">{tool.description}</div>
        </div>
        {fields.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {fields.map(([key, schema]) => (
              <Input
                key={key}
                aria-label={key}
                placeholder={`${key}${schema.description ? ` (${schema.description})` : ""}`}
                value={values[key] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [key]: event.target.value }))
                }
              />
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          {tool.requiresApproval ? (
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(checked) => setConfirmed(checked === true)}
              />
              I approve sending this outside Meridian
            </label>
          ) : null}
          <Button
            type="submit"
            size="sm"
            disabled={run.isPending || missing || (tool.requiresApproval && !confirmed)}
            className="ml-auto"
          >
            {run.isPending ? "Running…" : "Run"}
          </Button>
        </div>
        {run.isError ? <p className="text-xs text-destructive">{run.error.message}</p> : null}
        {run.data ? (
          <div className="flex flex-col gap-1">
            <div
              className={cn("text-xs", run.data.ok ? "text-muted-foreground" : "text-destructive")}
            >
              {run.data.ok ? "Done" : "Failed"} in {run.data.ms} ms
            </div>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
              {formatResult(run.data.result)}
            </pre>
          </div>
        ) : null}
      </form>
    </PageCard>
  );
}

function formatResult(result: string) {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}
