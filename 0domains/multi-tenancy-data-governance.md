# Multi-Tenancy And Data Governance

Use this module for multi-user, tenant-isolated, privacy-sensitive, or compliance-aware systems.

## Tenant Isolation

- Resolve tenant context at the infrastructure boundary: request middleware, job wrapper, command wrapper, or equivalent.
- Domain services and repositories should not hand-roll tenant schema names or ad hoc predicates when infrastructure can scope the unit of work.
- Cross-tenant invisibility must be tested with representative denied and allowed paths.
- Maintenance commands and scheduled jobs must be tenant-scoped or explicitly control-schema-only.
- Tenant store failures should fail closed.

## Data Governance

- Data governance covers lifecycle and compliance of data at rest; it is distinct from security access-control.
- Do not commit PII, secrets, private absolute paths, corpus contents, provider tokens, decrypted content, tenant identifiers, or sensitive generated datasets.
- Use CI or pre-commit guards where practical.
- Define retention, TTL, purge paths, export redaction, and data minimization.
- Preserve provenance, license, and attribution from indexed/imported content through user-visible passages when required.
- Deleted personal data must expire from backups according to the project's erasure policy.

## Egress And Consent

- No silent network calls on the default path for local-first or privacy-first products.
- Remote providers, cloud inference, sharing, sync, export, or external sending should pass through an explicit preview/confirmation gate.
- Egress previews should enumerate what leaves the device/account and where it goes.
- Audit confirmed egress actions with redacted payloads.

## Key And Secret Custody

- Document where encryption keys, recovery keys, provider credentials, and vault secrets live.
- Losing a required key should have a documented consequence and recovery story.
- Never log decrypted content, secrets, or key material.
