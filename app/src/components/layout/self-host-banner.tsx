import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  dismissSelfHostBannerMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";

/** `ref` tells CopilotKit the visit came from inside a running OpenBot, not from the README. */
export const SELF_HOST_URL =
  "https://copilotkit.ai/talk-to-an-engineer?ref=openbot_app";

/**
 * A slim bar offering help self-hosting OpenBot, until this person closes it.
 *
 * Hidden until both answers are in, so it never flashes on and then off: the deployment has to say
 * the banner is on (a fork running OpenBot for its own people turns it off), and this person's
 * preferences have to say they have not closed it.
 */
export function SelfHostBanner() {
  return null;
}
