import { useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";

export function SlackOAuthConnectStep({ endpoint }: { endpoint: ChatEndpoint }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const connect = useMutation({
    mutationFn: () => chatEndpointsApi.startSlackBotOAuth(endpoint.id),
    onSuccess: ({ authorizationUrl }) => {
      const url = new URL(authorizationUrl);
      if (url.origin !== "https://slack.com" || url.pathname !== "/oauth/v2/authorize") {
        throw new Error("Paperclip returned an unexpected authorization destination");
      }
      window.location.assign(url.href);
    },
  });
  return <SlackOAuthConsent endpoint={endpoint} pending={connect.isPending}
    failed={connect.isError || params.get("slackOauth") === "failed"}
    onConnect={() => connect.mutate()} onExit={() => navigate("/apps")} />;
}

export function SlackOAuthConsent({ endpoint, pending = false, failed = false, onConnect, onExit }: {
  endpoint: Pick<ChatEndpoint, "assignedAgentName" | "setup">;
  pending?: boolean;
  failed?: boolean;
  onConnect: () => void;
  onExit: () => void;
}) {
  const status = endpoint.setup?.slackOAuth;
  return <div className="space-y-5">
    <div className="space-y-2">
      <h1 className="text-xl font-bold">Connect {endpoint.assignedAgentName} to Slack</h1>
      <p className="text-sm text-muted-foreground">Approve installation in Slack, then return here to verify delivery. Your installing Slack identity will be linked to the Paperclip account you are signed into. No access token to copy.</p>
    </div>
    {!status?.configured && <div role="status" className="space-y-2 rounded-lg border border-border bg-muted p-4">
      <p className="text-sm font-semibold">One-time developer setup needed</p>
      <p className="text-sm">Register a separate internal Slack app and configure the pilot before connecting. Enter secrets in the instance environment, never in a task or chat.</p>
      <ul className="list-disc pl-5 text-sm">{status?.missing.map(key => <li key={key}><code>{key}</code></li>)}</ul>
    </div>}
    {status?.callbackUrl && <div className="space-y-2 text-sm">
      <p>Add this Redirect URL in the Slack app’s OAuth &amp; Permissions settings:</p>
      <code className="block break-all rounded-md bg-muted p-3">{status.callbackUrl}</code>
    </div>}
    <details className="space-y-2 text-sm">
      <summary className="cursor-pointer font-medium">DM-only permissions</summary>
      <p>This separate app can receive messages sent to the bot, reply, identify the sender, and handle its connection command. It cannot read public or private channel history or transfer files. Reading #papercuts on your behalf requires a separate consent step, not yet available in this milestone.</p>
      <ul className="list-disc pl-5">{status?.scopes.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul>
    </details>
    {failed && <p role="alert" className="text-sm text-destructive">
      Slack setup did not complete. Check the app, workspace, redirect URL, and current Paperclip sign-in, then try again. Rotating bot tokens are not yet supported; do not change your organization’s security policy.
    </p>}
    <div className="flex items-center justify-between gap-3">
      <Button variant="ghost" className="text-muted-foreground" onClick={onExit}>Save &amp; exit</Button>
      <Button disabled={!status?.configured || pending} onClick={onConnect}>
        {pending ? "Opening Slack…" : "Connect Slack"}
      </Button>
    </div>
  </div>;
}
