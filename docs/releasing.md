# Releasing

A release is the npm package, plus the git tag and the GitHub release that the workflow creates after `npm publish`.
`portful@0.1.0` was published by hand. Every later version goes through `.github/workflows/publish.yml`.

## How a release runs

A push to `main` that changes `package.json` runs `publish.yml`.
Its `check` job reads the version and skips the run when the tag `v<version>` already exists, so a dependency bump releases nothing.
The `publish` job waits for approval of the GitHub Environment `publish`, then runs `npm ci`, `npm run build`, `npm run type-check`, `npm run archstrict`, `npm test`, and `npm publish`.
npm authenticates with the environment's OIDC token. The workflow reads no `NPM_TOKEN`.
After `npm publish` succeeds, the `release` job creates the tag `v<version>` and the GitHub release on the published commit, with that version's section of `CHANGELOG.md` as the notes.

## Owner setup, once

These are owner steps. Nothing in this repository performs them.

1. On npm, add a Trusted Publisher to `portful`: provider GitHub Actions, user `meganemura`, repository `portful`, workflow `publish.yml`, environment `publish`, and allow `npm publish`.
2. On GitHub, create the Environment `publish` with `meganemura` as a required reviewer, and allow deployments from the `main` branch.

## Publish a version

1. In one commit, set the version in `package.json` and `package-lock.json`, and move the notes under `## Unreleased` to a new `## <version> (YYYY-MM-DD)` heading. The release job extracts the section whose heading starts with `##`, the version, and a space.
2. Run `npm run type-check && npm test && npm run archstrict && npm run build`, then `npm pack --dry-run`.
3. Land the commit on `main` through the `queue` branch. Do not push a `v*` tag.
4. Approve the `publish` environment on the Publish run.
5. Confirm the version on npm, the tag, and the GitHub release.
