import { mutationOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ToolRun } from "./queries";

export const runMeridianToolMutationOptions = () =>
  mutationOptions({
    mutationKey: ["meridian", "run-tool"],
    mutationFn: async (input: {
      botId: string;
      tool: string;
      args: Record<string, unknown>;
      confirmed: boolean;
    }) =>
      (await client(`/api/meridian/tools/${encodeURIComponent(input.tool)}`, {
        method: "POST",
        body: { botId: input.botId, args: input.args, confirmed: input.confirmed },
        fallback: "Couldn't run that tool.",
      }).then((response) => response.json())) as ToolRun,
  });
