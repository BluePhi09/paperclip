import type {
  ConnectionIntentInteraction,
  ConnectionIntentSetupOptions,
} from "@paperclipai/shared";
import { api } from "./client";

export const connectionIntentsApi = {
  startSlackRead: (interactionId: string) => api.post<
    { status: "AUTH_REQUIRED"; authorizationUrl: string } | { status: "CONNECTED"; connectionId: string }
  >(`/connection-intents/${interactionId}/slack-read`, {}),
  setupOptions: (interactionId: string) =>
    api.get<ConnectionIntentSetupOptions>(
      `/connection-intents/${interactionId}/setup-options`,
    ),
  setPhase: (
    interactionId: string,
    phase: ConnectionIntentInteraction["payload"]["phase"],
  ) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/phase`,
      { phase },
    ),
  complete: (interactionId: string, connectionId: string) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/complete`,
      { connectionId },
    ),
  decline: (interactionId: string, reason?: string) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/decline`,
      reason ? { reason } : {},
    ),
};
