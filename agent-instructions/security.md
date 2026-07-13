# Security

Use this module for security-sensitive changes or projects exposed to untrusted input.

## Threat Model First

Before implementation, identify:

- external inputs
- trust boundaries
- attack surfaces
- privilege boundaries
- data flows
- attacker-controlled fields

For security-sensitive features, perform a mini-STRIDE pass: spoofing, tampering, repudiation, information disclosure, denial of service, and elevation of privilege.

Use OWASP Top 10, API Top 10, ASVS, ISO 27001 Annex A, NIST CSF, PASTA, or attack trees when the project asks for named lenses. Cite the lens per finding when recording audit rows.

## Input Validation

- Validate every external input for type, size, format, range, and encoding.
- Reject malformed, oversized, or dangerous input early.
- Never trust user input, environment variables, network payloads, file contents, or indexed documents.
- Prefer allowlists over blocklists.

## Sanitization And Encoding

- Encode output by context:
  - HTML: escape HTML.
  - SQL: parameterized queries only.
  - Shell: avoid shell interpolation.
  - URLs: encode parameters.
  - Logs: sanitize control characters and secrets.
- Use hardened parsers and libraries where possible.
- Avoid regex/manual parsing for security-critical structured inputs when a real parser exists.

## Safe APIs

- Avoid `eval`, unsafe deserialization, dynamic SQL, shell interpolation, unsafe reflection, and raw memory operations where safe alternatives exist.
- Use prepared statements, typed APIs, safe parsers, CSPRNGs, and audited cryptographic libraries.
- Never roll your own cryptography.
- Use constant-time comparisons for secrets.

## Secrets

- Never hardcode secrets, API keys, tokens, private paths, or sensitive data.
- Do not log, serialize, expose, or include secrets in errors.
- Prefer secret managers or environment injection.

## Auth And Privilege

- Authentication is not authorization; check authorization explicitly.
- Never rely on client-side authorization.
- Use least privilege for filesystem, database, network, cloud, and service permissions.
- Prefer deny-by-default behavior.

## Error Handling

- Do not leak stack traces, SQL queries, private file paths, tokens, or sensitive internals to users.
- Return safe user-facing errors.
- Log internal detail securely where appropriate.

## Dependency Risk

- Before adding dependencies, check maintenance, CVEs, reputation, update cadence, and transitive risk.
- Prefer mature dependencies.
- Pin or bound risky dependencies according to the project policy.

## Security-Sensitive Changes

When touching RLS policies, edge functions, storage buckets, auth boundaries, secrets handling, or data access rules:

- Read the project security testing docs if present.
- Add or update sibling security/e2e specs.
- Test both allowed and denied paths.

## Web And Local-App Checklist

- XSS: every stored-value-to-DOM sink is sanitized or escaped.
- SQL injection: no raw/interpolated SQL; use parameters or typed query builders.
- Prompt injection: fence and sanitize untrusted prompt slots before LLM calls.
- CORS: never reflect arbitrary origins for sensitive endpoints.
- Rate limiting: protect unauthenticated and cost-heavy endpoints.
- Security headers: use CSP, HSTS, X-Frame-Options or frame-ancestors, Referrer-Policy, and Permissions-Policy where applicable.
- CSRF: verify the auth model; cookie-auth state-changing requests need CSRF protection.
- Local IPC: validate payloads and restrict privileged operations to authorized channels.
