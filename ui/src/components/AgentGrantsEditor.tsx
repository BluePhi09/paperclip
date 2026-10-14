import { useMemo, useState } from "react";
import { PERMISSION_KEYS, type PermissionKey, type PrincipalPermissionGrant } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

export type AgentGrantInput = {
  permissionKey: PermissionKey;
  scope: Record<string, unknown> | null;
};

export function formatGrantScope(scope: Record<string, unknown> | null | undefined): string {
  if (!scope || Object.keys(scope).length === 0) return "Company-wide";
  return JSON.stringify(scope);
}

function toInput(grant: Pick<PrincipalPermissionGrant, "permissionKey" | "scope">): AgentGrantInput {
  return { permissionKey: grant.permissionKey, scope: grant.scope ?? null };
}

/**
 * Lists an agent's explicit permission grants and lets a board operator remove
 * individual grants or add a company-wide grant for a known permission key.
 * Every change is sent as the full replacement set to
 * PATCH /companies/:companyId/members/:memberId/permissions.
 */
export function AgentGrantsEditor({
  grants,
  hasMembership,
  onReplace,
  pending = false,
  error = null,
}: {
  grants: Array<Pick<PrincipalPermissionGrant, "id" | "permissionKey" | "scope">>;
  hasMembership: boolean;
  onReplace: (next: AgentGrantInput[]) => void;
  pending?: boolean;
  error?: string | null;
}) {
  const sortedGrants = useMemo(
    () => [...grants].sort((a, b) => a.permissionKey.localeCompare(b.permissionKey)),
    [grants],
  );
  const grantedCompanyWide = useMemo(
    () => new Set(grants.filter((grant) => !grant.scope).map((grant) => grant.permissionKey)),
    [grants],
  );
  const addableKeys = PERMISSION_KEYS.filter((key) => !grantedCompanyWide.has(key));
  const [selectedKey, setSelectedKey] = useState<PermissionKey | "">("");

  const removeGrant = (grantId: string) => {
    onReplace(grants.filter((grant) => grant.id !== grantId).map(toInput));
  };

  const addGrant = () => {
    if (!selectedKey) return;
    onReplace([...grants.map(toInput), { permissionKey: selectedKey, scope: null }]);
    setSelectedKey("");
  };

  return (
    <div>
      <h3 className="text-sm font-medium mb-3">Permission grants</h3>
      <div className="border border-border rounded-lg p-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          Explicit grants stored for this agent. Changes replace the full set and are recorded in the activity log.
        </p>
        {!hasMembership ? (
          <p className="text-sm text-muted-foreground">This agent has no company membership, so it cannot hold grants.</p>
        ) : (
          <>
            {sortedGrants.length === 0 ? (
              <p className="text-sm text-muted-foreground">No explicit grants.</p>
            ) : (
              <ul className="divide-y divide-border" aria-label="Permission grants">
                {sortedGrants.map((grant) => (
                  <li key={grant.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                    <div className="min-w-0 space-y-1">
                      <div className="font-mono">{grant.permissionKey}</div>
                      <div className="text-xs text-muted-foreground break-all">{formatGrantScope(grant.scope)}</div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      aria-label={`Remove ${grant.permissionKey}`}
                      onClick={() => removeGrant(grant.id)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <select
                aria-label="Permission to grant"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                value={selectedKey}
                disabled={pending || addableKeys.length === 0}
                onChange={(event) => setSelectedKey(event.target.value as PermissionKey | "")}
              >
                <option value="">Select a permission…</option>
                {addableKeys.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
              <Button type="button" size="sm" disabled={pending || !selectedKey} onClick={addGrant}>
                Add grant
              </Button>
            </div>
          </>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
