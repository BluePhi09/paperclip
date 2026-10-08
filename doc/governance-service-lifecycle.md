# Governance service lifecycle — local, incomplete integration

This is a bounded implementation contract, not a production-ready DSM connector.
The trusted productive invocation issuer and the external Synology MCP
integration remain open. Do not replace the existing DSM account or keys based on this slice.

## Owner API

All paths below are under `/api/companies/:companyId/governance/services`.
They require an explicit Board session, active owner membership in this company,
and (for existing services) the same owner as the service. Implicit local Board,
agent keys and generic Board keys are not owner authority. The native app mounts
these routes behind its Board mutation guard. Membership and service eligibility
are checked again under database row locks in the mutation transaction.

- `POST /`: strict `{ "nasTarget": "opaque-target" }`; returns the service (201).
  Target identifiers contain 1–80 ASCII letters, digits, dots, underscores or
  hyphens. A target identifier is not proof of a discovered NAS endpoint.
- `DELETE /:serviceId`: revoke (204), idempotent. No deletion or reactivation.
- `POST /:serviceId/credentials`: strict `{ "expiresAt": "ISO-8601 UTC" }`;
  lifetime must be positive and at most 24 hours at the locked database clock.
  Returns `{ id, expiresAt, token }` once (201), with `Cache-Control: no-store`.
- `GET /:serviceId/credentials`: redacted metadata only; no token or token hash.
- `DELETE /:serviceId/credentials/:credentialId`: revoke (204), idempotent;
  unknown/cross-service credentials return 404. Service revocation independently
  disables all its credentials for new dispatch authority.

Each effective create/issue/revoke writes a content-free Activity entry in the
same transaction. Actions are `governance.service_created`,
`governance.service_revoked`, `governance.credential_issued`, and
`governance.credential_revoked`. Attribution is the authenticated service owner;
credential events include only the credential ID. Audit failure rolls back the
resource mutation. This uses the existing Activity retention semantics, not the
append-only dispatch ledger.

## Invocation retry and renewal

`recordInvocation` is an internal function, not an HTTP registration endpoint.
Its future productive caller must independently bind real request arguments,
company, requester, executor run, NAS target and register semantics. The literal
issuer string is not a trust mechanism.

The company/operation hash is unique. Identical unconsumed retries with identical
approval/document/service binding return the existing invocation. Conflicting
bindings or a consumed invocation return 409. An expired unused invocation may
be renewed for 30 seconds; its unused verification is deleted, so its old ID can
never consume the renewed authorization. A subsequent Verify rechecks evidence.
No consumed invocation is renewed, even when its result is unknown.

## Dispatch and outcome authority are separate

The terminal machine boundary precedes legacy actor resolution and independent
MCP/auth ingress. A `pcgov_` bearer never becomes a Board or agent actor and is
rejected on unrelated routes. Verify and Consume require a current credential,
non-revoked service and current company owner under transaction locks. Consume
rechecks evidence and expiration after acquiring evidence locks. Intent and
single dispatch claim commit together. A matching retry returns the existing ID
with `dispatchAllowed: false`; it does not authorize redispatch.

Only `POST /api/governance/dsm/v1/dispatches/:dispatchId/events` accepts a retired
credential for outcome completion. It requires the original dispatch credential,
company, service, invocation and an immutable committed intent. A replacement
credential cannot adopt the dispatch. The window closes 24 hours after intent
creation, checked with the database clock after locking. Expiration/revocation
of the original credential or service does not erase this narrowly scoped
completion right; it never restores Verify/Consume permission.

Allowed outcome claims are `succeeded/none`, `failed/provider_failed`, and
`unknown/outcome_unknown`, with an idempotency key and optional SHA-256 artifact
digest. No free text is accepted. One terminal claim is allowed; identical
retries return its ID, contradictory retries fail. These are machine-reported
claims, not independently verified provider effects. Late/manual reconciliation
or adoption by another credential is not implemented.

## Register authorization (deny by default)

The `dsm-register` document bound to an operation (by id and revision) must be
locked, linked to the same issue, and contain a versioned JSON body:

```json
{ "version": 1, "entries": [ { "entryId": "...", "effectClass": "NE", "api": "...",
  "method": "...", "apiVersion": 1, "targetIds": ["..."] } ] }
```

Verify allows an operation only if one entry matches its entry id, effect class,
API, method, API version, and every operation target id is listed. A missing,
malformed, unversioned or non-matching register denies with `register_invalid`
or `register_unauthorized`; no intent is written.

## Open decisions (conservative defaults in this change)

- Invocations can only be created by internal code (`recordInvocation`); there is
  no HTTP issuer, so nothing can dispatch in production until one is built.
- Company deletion is blocked once a governance service exists (foreign keys and
  the append-only ledger). Audit history is never deleted silently.
- The external Synology MCP source has not been found; no provider API names are
  invented. The register content must come from that source.
- Migration numbers 0311/0312 must be re-checked if another branch adds migrations.
