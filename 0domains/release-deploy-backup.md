# Release, Deploy, Backup, And Lifecycle

Use this module for release engineering, production gates, backups, restore, packaging, and software lifecycle management.

## Release Engineering

- A release is safe only when the path from green CI to a healthy upgraded install is engineered.
- Document upgrade ordering for code, schema, generated assets, and built frontend artifacts.
- Prefer expand-contract or parallel-change migrations for compatibility-sensitive schema changes.
- Use backup-before-migrate gates where data loss is possible.
- Smoke tests should exercise production-like configuration, not bypass modes.
- CI should fail closed and mirror deployment reality.
- Use pinned actions/base images and reproducible builds from committed lockfiles.

## Production Gates

- Track "safe on localhost, change before production" items as open work until resolved.
- Production gates should bind into a release checklist rather than live only as scattered TODO rows.
- First-run/bootstrap ceremonies should be defined and guarded against accidental reruns.

## Backup And Restore

- Backups are not complete until restore has been tested.
- Use the 3-2-1 rule where appropriate.
- Define RPO and RTO.
- Support PITR when the data store and risk profile warrant it.
- Ensure backup artifacts include everything required and exclude decrypted plaintext or unnecessary sensitive data.
- Restore should round-trip core entities and derived state losslessly or document what rebuilds.
- Retention must account for privacy deletion requirements.
- Encryption-key custody is part of backup integrity.

## Software Lifecycle Management

- Declare supported versions and upgrade windows.
- Define security-patch response windows.
- Track dependency/runtime EOL and upgrade cadence.
- Document deprecation policy, migration guides, `@deprecated` to removal windows, and feature-flag retirement.
- Use SemVer, Keep a Changelog, Conventional Commits, tags, or the local release standard consistently.
- Supply-chain provenance may include SBOMs, build attestations, SLSA posture, and dependency automation.
- Track delivery metrics such as deployment frequency, lead time, MTTR, and change-fail rate when useful.
