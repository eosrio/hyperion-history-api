# Development build

Use the committed `package-lock.json` for the build and unit-test dependency tree,
matching `.github/workflows/build.yml`:

```sh
npm ci --ignore-scripts
npm run build
bun test tests/unit
```

The workflow runs this sequence on Node.js 22 and 24 for pushes and pull requests
to `main`, `dev`, and `release/4.5`. The build compiles all application TypeScript;
Bun runs the unit tests against the npm-installed dependencies.

`--ignore-scripts` matches CI and skips dependency lifecycle scripts, including
native setup. This is a build/test recipe, not a replacement for an operator's
runtime installation procedure or live service qualification.

On npm versions that reject the explicitly declared Git dependency with
`EALLOWGIT`, allow only direct Git dependencies for this invocation:

```sh
npm ci --ignore-scripts --allow-git=root
```

Do not change a global Git-dependency policy to run these checks.

## Diagnosing dependency-related type errors

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
