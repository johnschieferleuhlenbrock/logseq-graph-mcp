# Release Checklist

This package is intended for public npm publication from a clean GitHub release.

## One-Time Setup

1. Choose the repository namespace.
2. Confirm `.github/CODEOWNERS` names the owning GitHub handle or team.
3. Enable branch protection for `main` with required PRs, linear history, no
   force pushes, and required CI checks.
4. Configure npm trusted publishing for the GitHub repository and the
   `.github/workflows/release.yml` workflow.
5. Confirm GitHub Actions CI and SBOM workflows pass on `main`.
6. Confirm CodeQL is either passing or intentionally skipped because the
   repository is still private without GitHub Advanced Security.
7. Run the release workflow manually with `dry_run=true`.

Do not add a long-lived npm token unless trusted publishing is unavailable.
When the GitHub repository is still private, npm can run a publish dry run, but
public provenance is only meaningful after the repository is public.

## Release Steps

1. Confirm the worktree is clean.
2. Run `npm run check`.
3. Run `npm audit`.
4. Run `npm run sbom`.
5. Review `npm pack --dry-run --json --ignore-scripts`.
6. Create a GitHub release for the package version.
7. Confirm the `Release` workflow publishes with npm provenance.

## Post-Release Smoke

```sh
npx logseq-graph-mcp --version
npx logseq-graph-mcp --help
```
