# Development checks

Follow [the development build guide](docs/development-build.md).

- Use the pinned TypeScript 7.0.2 compiler and Bun 1.4.4 from `.bun-version`.
- Install dependencies from `package-lock.json` with `npm ci`. Bun runs the checker
  and unit tests against this dependency tree.
- Use `npm run typecheck` (`bun check -p tsconfig.json`) during development and in CI.
  Check the whole project so changes to shared types are checked in every caller.
- Use `npm run build` for the Node.js JavaScript and source-map artifacts emitted
  by TypeScript 7, and `npm test` for the existing unit suite.
- Keep generated build files out of commits. Update the npm lockfile when changing
  dependency versions, and validate on the CI Node.js 24/26 matrix.
- Node 24 is the minimum for Hyperion 4.5.
