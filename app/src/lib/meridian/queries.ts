import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type MeridianBot = {
  id: string;
  name: string;
  title: string;
  role: string;
  skills: string[];
  tools: string[];
};

export type MeridianSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  tools: string[];
};

export type MeridianTool = {
  name: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
  requiresApproval: boolean;
};

export type MeridianCatalog = {
  bots: MeridianBot[];
  skills: MeridianSkill[];
  tools: MeridianTool[];
  models: { fast: string; deep: string; configured: boolean };
};

export type ToolRun = { ok: boolean; result: string; ms: number };

export const meridianCatalogQueryOptions = () =>
  queryOptions({
    queryKey: ["meridian", "catalog"],
    queryFn: async () =>
      (await client("/api/meridian/catalog", {
        fallback: "Couldn't load the Meridian catalogue.",
      }).then((response) => response.json())) as MeridianCatalog,
  });
