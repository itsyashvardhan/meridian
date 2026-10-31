import { createFileRoute } from "@tanstack/react-router";
import { LivePage } from "@/components/meridian/live-page";

/** Meridian's coworker Bots, their skills, and their tools. Reached from the sidebar's Live entry. */
export const Route = createFileRoute("/_authed/_app/live")({
  component: LivePage,
});
