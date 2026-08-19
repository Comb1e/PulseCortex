# Publishing packages

PulseCortex publishes the packages in `packages/*` to the public npm registry
from GitHub Actions. The repository itself remains private in the package
manager, so the root workspace is never published.

## One-time setup

1. Create or claim the npm `pulsecortex` scope. Every package currently uses
   the `@pulsecortex/*` scope, so the npm account that owns that scope must be
   the publisher.
2. Create an npm **automation token** with publish access. Do not commit it or
   put it in a workflow file.
3. In the GitHub repository, create an environment named `npm`, add the token
   as an environment secret named `NPM_TOKEN`, and require a reviewer for that
   environment if releases need approval.

The workflow uses npm provenance and the minimum GitHub permissions needed for
the build and attestation. The token is only available to the publishing job.

## Release a version

All workspace manifests must have the same version as the release tag. Update
the root `package.json` and every `packages/*/package.json`, commit that change,
then create and push an annotated tag:

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

The `publish` workflow is intentionally triggered only by a pushed `v*` tag.
It installs from the lockfile, checks that every version matches the tag, runs
typecheck/tests/build, and then runs:

```bash
pnpm publish -r --access public --provenance --no-git-checks
```

The command rewrites `workspace:*` dependencies to the released versions in
the tarballs and publishes packages in dependency order. A failed or cancelled
run can be retried from the Actions page; npm will skip packages that already
exist at that exact version only when the publish command supports it, so check
the job log before retrying a partially completed release.

To preview a release locally without changing the registry, run the validation
and build steps, then inspect tarballs with `pnpm pack` from an individual
package directory. Never use a personal password or a long-lived token in a
command argument or committed file.

## GitHub Packages

GitHub Packages uses the `npm.pkg.github.com` registry and requires package
names scoped to the owning GitHub user or organization. The current
`@pulsecortex/*` names are prepared for npm's `pulsecortex` scope; rename the
scope and use a separate registry workflow only if GitHub Packages is the
intended distribution target.
