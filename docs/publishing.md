# Publishing Packages

GitHub Actions publishes the packages in `packages/*` to the public npm
registry. The private root workspace is never published.

## One-time setup

1. Create or claim the npm `pulsecortex` scope. Every package currently uses
   the `@pulsecortex/*` scope, so the npm account that owns that scope must be
   the publisher.
2. Create an npm **automation token** with publish access. Do not commit it or
   put it in a workflow file.
3. In the GitHub repository, create an environment named `npm`, add the token
   as an environment secret named `NPM_TOKEN`, and require a reviewer for that
   environment if releases need approval.

The workflow uses npm provenance and minimum GitHub permissions. The token is
available only to the publishing job.

## Release a version

All workspace manifests must have the same version as the release tag. Update
the root `package.json` and every `packages/*/package.json`, commit that change,
then create and push an annotated tag:

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

The workflow runs only for a pushed `v*` tag. It checks that every package
version matches the tag, runs typecheck/tests/build, and then runs:

```bash
pnpm publish -r --access public --provenance --no-git-checks
```

The command rewrites `workspace:*` dependencies in the tarballs and publishes
packages in dependency order. Check the job log before retrying a partial
release.

Published npm versions cannot be overwritten. Rerunning a failed workflow
retries the exact commit and tag that triggered it; after changing a package,
commit the change, update every workspace version, and push a new tag (for
example `v0.1.2`) to publish the new tarballs.

To preview a release locally without changing the registry, run the validation
and build steps, then inspect tarballs with `pnpm pack` from an individual
package directory. Never use a personal password or a long-lived token in a
command argument or committed file.

## Install published packages

Verify that the application packages are public:

```bash
npm view @pulsecortex/cli version
npm view @pulsecortex/daemon version
```

Install the CLI and daemon globally at the same version. See the
[README quick start](../README.md#quick-start-from-npm) for setup:

```bash
npm install --global @pulsecortex/cli@latest @pulsecortex/daemon@latest
pulsectl --help
pulsectl init
```

Both packages are required; `pulsectl` locates the daemon as an adjacent global
package. Upgrade them together to avoid incompatible internal contracts:

```bash
npm install --global @pulsecortex/cli@latest @pulsecortex/daemon@latest
```

Published library packages can be installed independently in another project:

```bash
npm install @pulsecortex/domain
```

Public packages from npmjs.org do not require a project `.npmrc` or an access
token. A `404` from `npm view` means that package/version is not yet public or
the configured npm registry is not `https://registry.npmjs.org/`.

## GitHub Packages

GitHub Packages uses the `npm.pkg.github.com` registry and requires package
names scoped to the owning GitHub user or organization. The current
`@pulsecortex/*` names are prepared for npm's `pulsecortex` scope; rename the
scope and use a separate registry workflow only if GitHub Packages is the
intended distribution target.
