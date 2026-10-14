# Fork-Patches (BluePhi09/paperclip)

Der Fork ist upstream `paperclipai/paperclip` plus diese Patch-Liste. Eigene Features kommen als Plugin.
Jede Zeile: Zweck, Fork-PR, upstream-Stand, Löschbedingung. Ein Patch, dessen Löschbedingung erfüllt ist, wird beim nächsten Upstream-Sync entfernt.

Pflege: Pax (wöchentlicher Sync). Stand: 2026-10-13.

## Regeln

1. Upstream-Sync zuerst; kein Feature-Merge, solange der Sync-PR offen und rot ist.
2. Kleine Fixes immer auch upstream einreichen (Entwurf als Dokument `upstream-pr`, öffnen tut Philipp).
3. Fork-Migrationen immer über der höchsten upstream-Nummer, beim Sync neu nummerieren.
4. Fork-Änderungen in God-Files (`heartbeat.ts`, `routes/issues.ts`, `tool-access.ts`, `chat-channels.ts`) minimal halten.

## Patches

| Bereich | Zweck | Fork-PR / Commit | upstream | Löschbedingung |
|---|---|---|---|---|
| k8s-Plugin | Login-PTY, Lease-Expiry-Attestation, Hard-Stop | Basis #13995/#14001, `2e01c1797` ff. | PRs offen | upstream merged #13995/#14001 |
| k8s-Plugin | Per-Lease-Egress, Operator-Hosts, Provider-Domains | `4335daa7c` ff. | Teil von #14001 | wie oben |
| k8s-Plugin | Label `paperclip.io/agent-id` = echte Agent-ID | #14 | einreichen | upstream fix |
| k8s-Plugin | Sandbox-Volumes konfigurierbar (`/tmp` 8Gi), `defaultResources` im Schema | #24 | einreichen | upstream fix; ersetzt nebula `vendor/0006` |
| k8s-Plugin | Gepinnte Runtime-Images (Codex/Claude) | `af23c80be`, `14f69f1cb` | – | eine Image-Quelle in Fork-CI (Phase 1) |
| Bridge | Run-gebundene Secret-Routen | #4, #5 | einreichen | Bridge-Allowlist aus Grants (Phase 2) oder nativer Runner |
| Bridge | Secret-Proposal-Routen | #16 | – | wie oben |
| Bridge | Environments list/read/PATCH für `environments:manage` | #17 | – | wie oben |
| Bridge | Instructions-Bundle-Datei; Schreiben nur Milo/Atlas (hart codierte UUIDs) | #20 | – | **entfernen** in Phase 2 (Allowlist aus Grants) |
| Tool-Gateway | Outbound-MCP-Connector (`packages/mcp-connector`) | `b9f1c0b51` ff. | upstream hat eigenen Connector? prüfen | upstream-Äquivalent |
| Tool-Gateway | Cache-Hints `tools/list` | #13 | einreichen | upstream fix |
| Tool-Gateway | Connection-Health bei Tool-Timeout erhalten | #15 | einreichen | upstream fix |
| Tool-Gateway | Gateway-Rejections als HTTP-Fehler in Reviews | #19 | einreichen | upstream fix |
| Tool-Gateway | Board-Approval schließt Bestätigungskarte | #27 | einreichen | upstream fix |
| Interactions | Tool-Action-Karten aus Supersede-Sweep, verwaiste Approvals schließen | #26 (Draft) | einreichen | upstream fix |
| Interactions | Bis zu 64 Antworten pro Fragekarte | #12 | – | behalten bis Sammelkarte anders gelöst |
| Server | Cross-Issue-Cap am ausgecheckten Issue (Timer-Runs) | #25 (Draft) | upstream #15090 offen | upstream merged #15090 |
| Server | Cross-Issue-Limit per Env | Port von upstream #15320 | offen | upstream merged #15320 |
| Server | Rollen-Default-Grants beim Schreiben erhalten | Port von upstream #15917 | offen | upstream merged #15917 |
| Server/UI | Board bearbeitet Agent-Grants (PATCH /members/:id/permissions für Agent-Principals, nur Board; Grant-Editor auf Agent-Seite) | Port von upstream #6358 + Fork-Erweiterung | #6358 offen | upstream merged #6358 + Grant-Editor-UI |
| Server | Wakeup/Release in offener Transaktion | upstream #14257 | offen | upstream merged #14257 |
| Server | Adapter-Runtime für Environment-Tests | `de852e0cf` | einreichen | upstream fix |
| AI-Connections | Modell-Discovery über AI-Gateways, archivierte Accounts ausblenden | `3b71215c5`, `175bd6929` | einreichen | upstream fix |
| Decisions | Audiences, Briefs, native Agent-Diskussion | #7, #8 | – | **behalten** (Entscheidung 13.10.2026), mittelfristig als Plugin prüfen |
| Environments | Run-Acquisitions reservieren, gemessene Runtime-Identität | #9 | – | **behalten** (Entscheidung 13.10.2026) |
| DB (Altlast) | Governance-Tabellen aus Migrationen 0336/0337 + Append-only-Trigger bleiben (Schema in `packages/db/src/schema/governance_verification.ts`, Lösch-Guard in `company-deletion.ts`, `session_replication_role` in Test-Cleanup) | #11 (Feature entfernt) | – | eigene, bewusst destruktive Drop-Migration nach Philipps OK |
| CI | Fork-Workflows, GHCR lowercase, Integrations-Image mit k8s-Plugin | #18, #21, `65b8ffcf1` | – | dauerhaft (Fork-Infrastruktur) |
| CI | `ci / policy` grün im Fork (lokaler pr-trusted, Sync-Lockfile) | #28 | – | dauerhaft |
| E2B | Self-Hosted-Env an Worker durchreichen | #3 | einreichen | upstream fix |

## Entfernt

| Bereich | Zweck | Fork-PR | Entfernt |
|---|---|---|---|
| Evidence | Evidence-Packs, Ausführung an reviewte Evidenz gebunden | #10 | 15.10.2026 (Entscheidung 13.10.2026); keine Tabellen, nur JSON-Feld `executionPolicy.evidencePack` (wird jetzt ignoriert/verworfen) |
| Governance | Governance-Verification-Service | #11 | 15.10.2026 (Entscheidung 13.10.2026); Tabellen bleiben, siehe Zeile „DB (Altlast)“ |
