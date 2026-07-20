# Review And TODO Management

Use this module for repositories that maintain review findings, technical debt, or audit work in `TODO.md`.

## TODO.md Is The Ledger

- The root `TODO.md` is the single source of truth for technical debt, security findings, audit results, and project tasks.
- Never create duplicate TODO ledgers in subdirectories.
- Whenever scanning, reviewing, auditing, or looking for issues, record findings in `TODO.md`; do not report them only in chat.
- Remove completed items entirely once implemented, tested, and merged. Do not keep struck-through rows or "shipped" sections.
- Use `git log` as the durable record of completed work.
- Keep open-but-deferred items only in an "Open - parked" section with a why-not-now note.
- Keep deliberately rejected audit picks in a dedicated section so future reviews do not re-pick them.

## Table Format

Use the table shape already used by the project. Common reusable schemas are:

```md
id | status | effort | description | notes
id | status | impact | effort | description | notes
id | status | severity | effort | description | notes
| ID | Sev | Status | Esforco | Descricao | Observacoes |
```

- If the table has `impact`, use `H` / `M` / `L` or the local vocabulary.
- If the table has `severity`, keep it in its own column, not buried in prose.
- Keep open findings in one table when severity and category already have their own columns. Do not create separate Critical/High/Medium/Low tables or headings.
- Start the ledger directly with its findings. Do not add a scan/methodology introduction, verification legend, baseline or gate report, analyzer narrative, or open-item count preamble; put durable evidence in each row's notes and report transient scan/gate results outside the ledger.
- Do not add "clean categories", "no findings", or equivalent sections. An absent finding already means the reviewed area produced no actionable item.
- For Portuguese tables, common severity values are `Critico`, `Alto`, `Medio`, `Baixo`, or `-` only when genuinely unclassifiable.
- Keep Markdown table rows as one logical row on one physical line when the project uses long TODO rows. Do not introduce prose wrapping that breaks row integrity.
- If the project has an open-item summary, recompute it whenever rows are added, removed, or reclassified. Derive counts mechanically from the rows and exclude statuses the project defines as closed, rejected, invalid, vendor, false-positive, or not-applicable.
- Use only the local status vocabulary. Do not invent new statuses.
- If the project keeps refused or won't-fix rows as tombstones, preserve the rationale so future audits do not re-add them.

## Review Categories

Use only categories relevant to the project, but prefer stable category names so future audits compose well:

- adaptability
- accessibility
- API contract & compatibility
- architecture / modularity / SOLID
- backup / restore integrity
- business / design patterns / DDD
- caching strategy
- CLI / option integrity
- code complexity
- code duplication
- composition
- concurrency
- configuration discoverability
- data governance
- data structure
- decoupling
- dependency
- design thinking
- discovery & validation
- documentation
- ingestion / format coverage
- legacy / deprecation
- machine learning
- memory and CPU management
- multithreading
- observability
- OKR
- PDCA
- performance
- platform
- prioritization
- plugin extensibility
- process & delivery governance
- product engineering
- product analytics & metrics
- product-market fit
- product refinement
- product strategy
- prompt-template integrity
- purpose
- reliability / correctness
- release & deploy engineering
- retrieval quality
- robustness / recovery
- scalability
- security
- software lifecycle management
- state machine integrity
- test coverage
- UI / UX
- unsafe / memory safety
- vectorization
- watchdog
- wiring gaps
- unused functions / methods

## Special Categories

- Wiring gaps: modules, helpers, config knobs, or advertised features that exist and pass tests but have no real production call site. A feature is shipped only when the dispatcher or runtime path invokes it.
- Unused functions / methods: public-shaped callables with no production caller, no tests, and no plugin use. Record whether to keep, inline, or delete.
- Legacy / deprecation: back-compat shims and legacy branches whose original callers are gone. If still live, record the caller so future audits do not remove it accidentally.

## Major Changes

For structural or broad changes:

- Rescan the affected project area, and the whole project when the change crosses boundaries.
- Update all relevant TODO tables before reporting findings.
- Verify that new findings are actionable and categorized.

## Implementation Workflow

- When implementing rows from `TODO.md`, treat each row as a mini-contract: understand the finding, implement the fix, add or update tests, run the relevant checks, and remove or update the row in the same change.
- Definition of ready: the row has enough context, expected outcome, and any required decision owner to act on it.
- Definition of done: implementation, tests, docs, and TODO cleanup land together.
