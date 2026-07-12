# Git Workflow

Use this module for repositories where agents may stage, commit, branch, or prepare release changes.

## Git Operations

- Do not stage, commit, branch, push, rebase, tag, or run release commands unless the user explicitly asks.
- Never run destructive git commands unless explicitly requested and the intent is unambiguous.
- Preserve user changes. Do not revert unrelated work.
- If branch policy exists, follow it; common defaults are branching from `develop` for PR workflows and keeping `main` protected for releases.

## Commits

- Use Conventional Commits when the project requires them: `type(scope): subject`.
- Keep subjects short, imperative, and specific.
- Commit lockfiles when they are part of reproducibility.
- Do not add AI-agent self-attribution:
  - no `Co-Authored-By:` trailer for the agent
  - no "Generated with ..." footer
  - no self-attribution in PR bodies or code comments
- If documentation-only commits are allowed to skip hooks, do so only when every staged file matches the documented docs-only rule.
- If any staged file is code or config, run the normal hook/gate path.

## Changelog And Tags

- Follow the local release policy.
- Some projects use `git log` plus Conventional Commits and tags as the changelog; do not add a `CHANGELOG.md` unless the project wants one.
- Version bumps, tags, and release notes must match the project lifecycle policy.
