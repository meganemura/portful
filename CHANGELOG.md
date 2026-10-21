# Changelog

The format follows Keep a Changelog, and the versions follow SemVer.

## Unreleased

- CI runs the typecheck, the tests, the module-boundary check with archstrict, and the switch flow as a nukadoko scenario against the built CLI, on Node 24 and 26.
- The README links the Japanese README at its end, and its version badge carries the npm logo.
- A version bump that lands on `main` now publishes the npm package. `publish.yml` runs on a push to `main` that changes `package.json`, publishes when no `v<version>` tag exists yet, and then creates that tag and the GitHub release. Nobody pushes a `v*` tag by hand.

## 0.1.0 (2026-08-22)

- First release.
