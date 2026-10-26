# Development build

Follow the [shared 4.5 TypeScript toolchain policy](https://github.com/eosrio/hyperion-tools/blob/main/docs/architecture/hyperion-4.5-typescript-toolchain.md).

The 4.5 baseline is TypeScript **7.0.2** and Bun **1.4.4**. The compiler version
is pinned in `package.json`, and the Bun version is pinned in `.bun-version` and
read by CI. This Bun release embeds TypeScript 7.0.2, verified with
`bun -p process.versions.typescript`. The operator selected this checker baseline
in [the shared toolchain update](https://github.com/eosrio/hyperion-tools/issues/61).

Install Bun 1.4.4 for development, and use the committed `package-lock.json` for
the dependency tree, matching `.github/workflows/build.yml`:

```sh
npm ci
npm run typecheck
npm run build
npm test
```

`npm run typecheck` runs `bun check -p tsconfig.json` over the complete application
project. Use it for routine development feedback and the CI typecheck gate.
`npm run build` uses the pinned TypeScript 7 compiler to emit Node.js JavaScript
and source maps. `bun check` performs checking only and does not emit artifacts.

`npm test` selects `bun test ./tests/unit` explicitly. Keep the `./` prefix so
copied fixtures under `out/` are not discovered through a bare substring filter.

Hyperion 4.5 requires Node.js 24 or newer. The workflow runs this sequence on Node.js 24 and 26
for pushes and pull requests to `main`, `dev`, and `release/4.5`. Bun checks and runs the unit tests against
the npm-installed dependencies. `package-lock.json` is the canonical install
lockfile; the stale Bun install lockfile has been removed.

Keep the pinned dependency preparation scripts enabled, as in the Node 24/26 build jobs. The
source-pinned Wire provider verifies its Git revision and preparation receipt during installation.
The earlier Node 22 design-fixture job failed that verification while using `--ignore-scripts`, before any
Elasticsearch test ran; the ordinary Node 22 install and complete tests passed. The fixture follows
the ordinary install recipe rather than bypassing the provider's source checks. Build/test checks
remain separate from operator installation and live runtime qualification.

On npm versions that reject the locked Git dependencies with `EALLOWGIT`, use
the same invocation-scoped policy as the Node 24/26 CI jobs:

```sh
npm ci --allow-git=all
```

The root, Wire plugin and independently installed MongoDB adapter now share an exact
SDK revision. The adapter keeps its own committed dependency lock. Its retained-checkpoint
inspection requires the recovery contract already present in the root SDK revision. Transitive Git dependencies
require the invocation-scoped policy above; `--allow-git=root` previously rejected the
separate Wire SDK on npm 11.19.0 before any qualification test ran. Keep all Git
revisions pinned in the committed lockfile and preparation scripts enabled. Do
not change a global Git-dependency policy to run these checks.

The [portable projection checks](portable-projection.md) additionally build an
independent MongoDB adapter and exercise an owned database fixture. Those checks
have separate dependency locks and do not qualify the complete 4.5 state path.

## Node 24 minimum and CI transition

The operator selected Node 24 as the minimum for 4.5 in
[the coordinated runtime baseline](https://github.com/eosrio/hyperion-tools/issues/65).
The application and independent MongoDB adapter declare this floor in their package and lock
metadata. The worker/recovery qualification gates select native Node 24 or 26 and reject Bun and Node 22.
Existing Node 22 reports retain their original source/runtime identities. They do not establish
Node 26 acceptance. Production runtime upgrades and full release qualification remain separate.
Superseded PR validation runs are cancelled; push and manual runs keep distinct concurrency groups.

## Historical dependency-related type errors

On 2026-10-18, the unchanged `release/4.5` source at
`ebc4cab06e1d4695f5f4e446057c86f8c31f95fb` reproduced 40 TypeScript diagnostics
with a Bun 1.4.3 isolated dependency tree, but zero after a clean `npm ci` from
the committed npm lockfile. Both trees used TypeScript 6.0.3. `npm run build`
and all 128 unit tests passed with the clean npm dependency tree.

The failing installation had two distinct resolution problems:

- 34 Fastify diagnostics: plugin declarations resolved `fastify` from their
  physical Bun cache paths to the custom `types/fastify` augmentation instead of
  the installed Fastify declarations. Resolving to the installed declarations
  in an in-memory compiler probe removed those 34 diagnostics.
- Six cluster diagnostics: incompatible Node 20, 24, and 25 declaration versions
  were loaded together. Resolving Node type references to the installed root
  declarations in an in-memory probe removed those six diagnostics.

These findings describe that installation, not every Bun installation. Reproduce
errors with the clean npm lockfile build before attributing them to the source.
Do not mask them with casts or duplicate plugin declarations. Changing
`preserveSymlinks` removed the original Fastify errors in the failing tree but
introduced different transitive errors, so it is not the validated build path.
