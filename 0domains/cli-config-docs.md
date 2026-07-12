# CLI, Configuration, And Documentation

Use this module for projects with command-line tools, configuration files, public APIs, and operator docs.

## CLI Integrity

- CLI declarations, help text, defaults, aliases, exit codes, and actual behavior must match.
- No dead flags: every declared option should be consumed or forwarded.
- No contradictory help text.
- Defaults in help, config, docs, and runtime code must agree.
- Legacy aliases must stay in sync with unified command groups.
- Error messages should be actionable and include the next step when possible.

## Configuration Discoverability

- Every new configuration knob needs:
  - default value
  - description/docstring
  - typed accessor
  - validation
  - test fixture
  - example or commented config entry when appropriate
- Avoid raw nested dictionary reads when typed accessors exist.
- Make disabled-by-default behavior discoverable.
- Hardcoded model names, dimensions, locale, paths, magic numbers, or provider names should become config only when they are real operator choices.

## Documentation

- README, docs, examples, CLI help, and public API docs must describe actual behavior.
- Quick-start commands should work as written.
- Advertised formats, knobs, flags, providers, and features must exist in code.
- Do not restate generated constants, function signatures, or binding shapes in hand-written docs when generated API docs exist; link to the generated source instead.
- Document every shipped feature an operator touches.
- Correct stale scope notes when changing behavior.
- For architecture docs, link to ADRs or canonical decision records for why; avoid duplicating decision rationale in multiple places.
- Avoid fixed counts for evolving indexes such as migrations, ADRs, specs, or TODO items.

## Data Governance In Docs And Config

- Do not commit personal data, secrets, private absolute paths, corpus contents, API keys, or sensitive generated datasets.
- Provide retention, TTL, purge, minimization, redaction, and provenance guidance when the app stores operator data, retrieved passages, answers, logs, or indexed content.
- Preserve license and attribution requirements for indexed content through displayed passages when required.

## Product Engineering

- Shipped defaults should match documented defaults.
- First-run failures should have a remediation path.
- Operator-facing scoreboards or metrics should reflect key objectives when the project uses OKRs or evaluation gates.
- PDCA loops should be wired: measured improvement should feed runtime parameters through a real adoption path, not manual copy-paste.

## Packaging And Publishing

- Published package contents should be intentional; use a `files` allowlist or ignore file where appropriate.
- Keep package metadata accurate: description, keywords, license, repository, homepage, bugs, bin, and engines.
- Type declarations are part of the public contract for TypeScript consumers.
- Release gates should include tests, audit, package contents, install reproducibility, and smoke checks.
