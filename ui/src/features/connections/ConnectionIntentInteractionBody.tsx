import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Plug,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { ConnectionIntentInteraction } from "@paperclipai/shared";
import { connectionIntentsApi } from "@/api/connection-intents";
import { AiConnectionCredentialStep } from "@/components/ai-connections/AiConnectionCredentialStep";
import { AI_PROVIDERS } from "@/components/ai-connections/model";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ConnectionSetupFlow,
  type ConnectionSetupCompletion,
  type ConnectionSetupFlowProps,
} from "./ConnectionSetupFlow";

export interface ConnectionIntentInteractionBodyProps {
  interaction: ConnectionIntentInteraction;
  currentUserId?: string | null;
  addresseeLabel: string;
  renderSetup?: (props: ConnectionSetupFlowProps) => ReactNode;
}

export function ConnectionIntentInteractionBody({
  interaction,
  currentUserId,
  addresseeLabel,
  renderSetup,
}: ConnectionIntentInteractionBodyProps) {
  const [open, setOpen] = useState(false);
  const focusTargetRef = useRef<HTMLDivElement>(null);
  const setupGeneration = useRef(0);
  const generation = setupGeneration.current;
  const closeSetup = () => {
    setupGeneration.current += 1;
    setOpen(false);
  };
  const queryClient = useQueryClient();
  const isAddressee = Boolean(
    currentUserId && interaction.addresseeUserId === currentUserId,
  );
  const isPending = interaction.status === "pending";
  const isAi = interaction.payload.purpose === "ai";
  const isSlackRead = interaction.payload.capabilityProfile === "slack-public-read-v1";
  const focusTargetId = `connection-intent-focus-target-${interaction.id}`;

  const invalidateTask = async (
    updatedInteraction?: ConnectionIntentInteraction,
  ) => {
    if (updatedInteraction) {
      queryClient.setQueriesData<ConnectionIntentInteraction[]>(
        { queryKey: ["issues", "interactions"] },
        (current) =>
          current?.map((candidate) =>
            candidate.id === updatedInteraction.id
              ? updatedInteraction
              : candidate,
          ),
      );
    }
    await Promise.all([
      // Task routes may key these caches by either UUID or human identifier.
      // Prefix invalidation reaches the mounted task without requiring that
      // routing identity to leak into the reusable interaction card.
      queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
      queryClient.invalidateQueries({ queryKey: ["issues", "detail"] }),
    ]);
  };
  const returnFocusToCard = () => {
    // Completing an intent can move it from the composer takeover to the
    // durable timeline. That replaces this component instance, so its ref can
    // be cleared before focus restoration runs. Retry for a few paint frames
    // and resolve the stable interaction-specific target from the new host.
    const focusCurrentTarget = (remainingAttempts: number) => {
      window.requestAnimationFrame(() => {
        const target =
          document.getElementById(focusTargetId) ?? focusTargetRef.current;
        target?.focus();
        if (remainingAttempts > 1) {
          focusCurrentTarget(remainingAttempts - 1);
        }
      });
    };
    focusCurrentTarget(3);
  };

  const setupQuery = useQuery({
    queryKey: ["connection-intent", interaction.id, "setup-options"],
    queryFn: () => connectionIntentsApi.setupOptions(interaction.id),
    enabled: isAddressee && isPending && !isSlackRead,
    refetchInterval: isPending && (open || interaction.payload.phase === "authorizing") ? 2_000 : false,
  });

  useEffect(() => {
    const current = setupQuery.data?.interaction;
    if (current && current.status !== "pending" && isPending) {
      void invalidateTask(current);
      setOpen(false);
      returnFocusToCard();
    }
  }, [setupQuery.data?.interaction, isPending]);

  const completeMutation = useMutation({
    mutationFn: (connectionId: string) =>
      connectionIntentsApi.complete(interaction.id, connectionId),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const declineMutation = useMutation({
    mutationFn: () => connectionIntentsApi.decline(interaction.id),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const phaseMutation = useMutation({
    mutationFn: (phase: ConnectionIntentInteraction["payload"]["phase"]) =>
      connectionIntentsApi.setPhase(interaction.id, phase),
    onSuccess: invalidateTask,
  });
  const slackReadMutation = useMutation({
    mutationFn: () => connectionIntentsApi.startSlackRead(interaction.id),
    onSuccess: async (result) => {
      if (result.status === "CONNECTED") { await invalidateTask(); return; }
      const target = new URL(result.authorizationUrl);
      if (target.origin !== "https://slack.com" || target.pathname !== "/oauth/v2_user/authorize") throw new Error("Unexpected authorization address. Return to this task and try again.");
      window.location.assign(target.href);
    },
  });
  const beginSlackRead = slackReadMutation.mutate;
  useEffect(() => {
    if (!isSlackRead || !isAddressee || !isPending) return;
    const current = new URL(window.location.href);
    const handoffSuffix = `/connect-slack-read/${interaction.id}`;
    const pathHandoff = current.pathname.endsWith(handoffSuffix);
    if (!pathHandoff && current.searchParams.get("connectSlackRead") !== interaction.id) return;
    // Consume a Slack button navigation once, before starting the request.
    // Refresh/back/cancel must not silently start another authorization flow.
    current.searchParams.delete("connectSlackRead");
    if (pathHandoff) current.pathname = current.pathname.slice(0, -handoffSuffix.length);
    window.history.replaceState(window.history.state, "", current.href);
    beginSlackRead();
  }, [isSlackRead, isAddressee, isPending, interaction.id, beginSlackRead]);
  const mutatePhase = phaseMutation.mutate;
  const handlePhaseChange = useCallback(
    (phase: ConnectionIntentInteraction["payload"]["phase"]) =>
      mutatePhase(phase),
    [mutatePhase],
  );

  const finishNewConnection = async (completion: ConnectionSetupCompletion) => {
    // A completed credential save survives cancellation, but an abandoned form
    // must not accept the task request (even if a new form has since opened).
    if (isAi && generation !== setupGeneration.current) {
      await setupQuery.refetch();
      return;
    }
    if (completion.resolvedByCallback) {
      // A browser message cannot establish authorization. Read the durable result.
      const verified = await setupQuery.refetch();
      if (verified.data?.interaction.status !== "accepted") return;
      await invalidateTask(verified.data.interaction);
      setOpen(false);
      returnFocusToCard();
      return;
    }
    completeMutation.mutate(completion.connectionId);
  };

  const setupProps: ConnectionSetupFlowProps | null = setupQuery.data ? {
    host: "dialog",
    serviceSlug: interaction.payload.serviceSlug.startsWith("connection:") ? undefined : interaction.payload.serviceSlug,
    configuredConnection: interaction.payload.serviceSlug.startsWith("connection:") ? setupQuery.data.existingConnections[0] : undefined,
    requestedAgentId: setupQuery.data.requestedAgentId,
    aiConnection: setupQuery.data.aiConnection,
    interactionId: interaction.id,
    existingConnections: setupQuery.data.existingConnections,
    onUseExisting: async (connectionId) => { await completeMutation.mutateAsync(connectionId); },
    onComplete: (completion) => { void finishNewConnection(completion); },
    onOAuthDeclined: () => declineMutation.mutate(),
    onPhaseChange: handlePhaseChange,
    onCancel: () => { closeSetup(); returnFocusToCard(); },
  } : null;

  const resultOutcome = interaction.result?.outcome;
  const status =
    interaction.status === "accepted"
      ? {
          icon: CheckCircle2,
          title: `${interaction.payload.serviceName} connected`,
          body: isAi ? "This agent can now use the connection." : `${interaction.payload.requestingAgentName} can use this connection on the continuation run.`,
        }
      : interaction.status === "rejected"
        ? {
            icon: XCircle,
            title: "Connection declined",
            body: isAi ? "The task still needs a working AI connection before it can run." : `${interaction.payload.requestingAgentName} was notified and can continue without it.`,
          }
        : interaction.status === "expired"
          ? {
              icon: Clock,
              title:
                resultOutcome === "superseded"
                  ? "Request superseded"
                  : "Connection request expired",
              body:
                resultOutcome === "superseded"
                  ? "This request was replaced. Use the latest connection card instead."
                  : "This request is no longer active.",
            }
          : null;
  const StatusIcon = status?.icon;

  if (status && StatusIcon) {
    return (
      <div
        id={focusTargetId}
        ref={focusTargetRef}
        tabIndex={-1}
        data-testid="connection-intent-focus-target"
      >
        <div
          className="flex items-start gap-3"
          data-testid="connection-intent-terminal"
        >
          <StatusIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">{status.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{status.body}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAddressee) {
    return (
      <div
        id={focusTargetId}
        ref={focusTargetRef}
        tabIndex={-1}
        data-testid="connection-intent-focus-target"
      >
        <div
          className="flex items-start gap-3"
          data-testid="connection-intent-waiting"
        >
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">
              Waiting for {addresseeLabel}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Only the addressed person can choose an identity or authorize this
              connection.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const needsRetry = interaction.payload.phase === "needs_retry";
  const authorizing = interaction.payload.phase === "authorizing";

  if (isSlackRead) return <div id={focusTargetId} ref={focusTargetRef} tabIndex={-1} data-testid="slack-read-consent">
    <p className="font-medium text-foreground">Connect Slack to review papercuts</p>
    <p className="mt-1 text-sm text-muted-foreground">
      Slack grants your personal identity public-channel metadata and history access. Paperclip restricts this pilot to channel {interaction.payload.sourceChannelId}, the last seven days, and at most 200 messages.
      The CEO will suggest up to three fixes with source links. It will not implement them. Your original request continues after authorization.
    </p>
    <div className="mt-4 flex items-center justify-between gap-2">
      <Button variant="ghost" disabled={slackReadMutation.isPending || declineMutation.isPending} onClick={() => declineMutation.mutate()}>Not now</Button>
      <Button disabled={slackReadMutation.isPending || declineMutation.isPending} onClick={() => beginSlackRead()}>
        {slackReadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
        {slackReadMutation.isPending ? "Connecting…" : needsRetry || authorizing ? "Continue connecting Slack" : "Connect Slack"}
      </Button>
    </div>
    {slackReadMutation.isError || declineMutation.isError ? <p className="mt-3 text-sm text-destructive" role="alert">
      {(slackReadMutation.error ?? declineMutation.error)?.message ?? "Couldn’t connect Slack. Try again from this task."}
    </p> : null}
  </div>;

  const repair = setupQuery.data?.aiRepair;
  const selectedReady = repair && setupQuery.data?.existingConnections.some((connection) => connection.id === repair.connection.id);
  const setupContent = setupQuery.isLoading ? (
                <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading
                  connection options…
                </div>
              ) : setupQuery.isError ? (
                <div className="py-8 text-center">
                  <p className="font-medium text-foreground">
                    Couldn’t load connection setup
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {setupQuery.error instanceof Error
                      ? setupQuery.error.message
                      : "Try again."}
                  </p>
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={() => setupQuery.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              ) : setupProps ? (
                renderSetup ? renderSetup(setupProps) : <ConnectionSetupFlow {...setupProps} />
              ) : null;
  const inlineContent = setupQuery.isLoading || setupQuery.isError ? setupContent
    : selectedReady ? <div className="space-y-3">
        <p className="text-sm">{repair.connection.name} is ready.</p>
        <Button disabled={completeMutation.isPending} onClick={() => completeMutation.mutate(repair.connection.id)}>
          {completeMutation.isPending ? "Continuing…" : "Continue task"}
        </Button>
      </div>
    : repair ? repair.canReconnect ? <AiConnectionCredentialStep
        companyId={interaction.companyId}
        provider={repair.connection.provider}
        initialMethod={repair.connection.method}
        fixedMethod
        connectionId={repair.connection.id}
        name={repair.connection.name}
        ownership={repair.connection.ownership}
        agentIds={[interaction.payload.requestingAgentId]}
        allAgents={false}
        onComplete={(result) => { void finishNewConnection(result); }}
        onCancel={() => { closeSetup(); returnFocusToCard(); }}
      /> : <p role="status" className="text-sm text-muted-foreground">
        {repair.connection.ownership === "personal" ? `${repair.connection.ownerName ?? "The account owner"} must reconnect ${repair.connection.name}.` : `The account owner must reconnect ${repair.connection.name}.`}
        {" "}You can continue here once it is restored.
      </p>
    : setupQuery.data?.aiConnection && setupQuery.data.aiConnection.mode !== "responsible_user"
      ? <p role="status" className="text-sm text-muted-foreground">The selected account is no longer available to you. Ask its owner to restore access, or choose an available AI connection in the agent’s settings.</p>
      : setupQuery.data?.aiConnection ? <AiConnectionCredentialStep
          companyId={interaction.companyId}
          provider={setupQuery.data.aiConnection.provider}
          name={`My ${AI_PROVIDERS[setupQuery.data.aiConnection.provider].name} account`}
          ownership="personal"
          agentIds={[interaction.payload.requestingAgentId]}
          allAgents={false}
          onComplete={(result) => { void finishNewConnection(result); }}
          onCancel={() => { closeSetup(); returnFocusToCard(); }}
        /> : setupContent;

  return (
    <div
      id={focusTargetId}
      ref={focusTargetRef}
      tabIndex={-1}
      data-testid="connection-intent-focus-target"
    >
      <div data-testid="connection-intent-actions">
        <div className="flex items-start gap-3">
          <AppLogo
            name={interaction.payload.serviceName}
            logoUrl={interaction.payload.serviceLogoUrl}
            darkLogoUrl={interaction.payload.serviceDarkLogoUrl}
            size={40}
          />
          <div>
            <p className="font-medium text-foreground">
              {isAi ? "AI connection needs attention" : `${interaction.payload.requestingAgentName} needs ${interaction.payload.serviceName}`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {interaction.payload.purpose === "ai"
                ? "This task can’t run until the agent has a valid AI connection. Connect here and the task will resume automatically."
                : "Connect your identity or reuse an eligible connection. Access is added only for this agent."}
            </p>
          </div>
        </div>

        {needsRetry ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-destructive">
            <RotateCcw className="h-4 w-4" />
            Authorization didn’t finish. Your previous choices are safe; try
            again.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {!isAi && <Button
            type="button"
            variant="ghost"
            disabled={declineMutation.isPending || completeMutation.isPending || authorizing}
            onClick={() => declineMutation.mutate()}
          >
            Not now
          </Button>}
          {isAi ? <Button type="button" disabled={completeMutation.isPending} onClick={() => open ? closeSetup() : setOpen(true)}>
            <Plug className="h-4 w-4" />{open ? "Close setup" : "Fix connection"}
          </Button> : <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button type="button">
                {authorizing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {authorizing
                  ? "Continue setup"
                  : needsRetry
                    ? "Try again"
                    : setupQuery.data?.existingConnections.length ? "Connect / Use existing" : "Connect"}
              </Button>
            </DialogTrigger>
            <DialogContent
              className="!max-w-(--pct-90) max-h-(--sz-85vh) w-full overflow-y-auto sm:max-w-5xl"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                focusTargetRef.current?.focus();
              }}
            >
              <DialogHeader className="sr-only">
                <DialogTitle>
                  Connect {interaction.payload.serviceName}
                </DialogTitle>
                <DialogDescription>
                  Complete connection setup without leaving this task.
                </DialogDescription>
              </DialogHeader>
              {setupContent}
            </DialogContent>
          </Dialog>}
        </div>
        {isAi && open ? <div className="mt-4 border-t border-border pt-4" data-testid="ai-connection-inline-repair">{inlineContent}</div> : null}

        {completeMutation.isError ||
        declineMutation.isError ||
        phaseMutation.isError ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {(completeMutation.error ??
              declineMutation.error ??
              phaseMutation.error) instanceof Error
              ? (
                  completeMutation.error ??
                  declineMutation.error ??
                  phaseMutation.error
                )?.message
              : "Couldn’t update this connection request."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
