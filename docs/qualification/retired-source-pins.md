# Retired source pins

Earlier 4.5 engineering cohorts recorded exact bytes and SHA-256 digests for sources, compiled
output, the SDK and MongoDB/BSON packages. Those inventories were enforced by source admission,
by the backend engineering selectors and by workflows that checked each other.

They no longer gate changes. Any edit, including a test fixture, failed most of CI, and the
inventories had no generator. A failed pin showed that bytes changed, not that behaviour broke.

## What changed

- `tests/unit/wire34-cbfb-source-admission.mjs` selects the profile and checks the runtime. It no
  longer compares recorded bytes or digests.
- The backend engineering selectors check the explicit profile and declaration, not `dist` bytes.
- Pin-only tests left the required `build` job. `historical-*-admission` jobs and the `wire34-cbfb`,
  `atomic-managed-wire34-cbfb`, `indexed-schema-native`, `indexed-schema-finite` and
  `royalty-native-custody` workflows run only through `workflow_dispatch`.

## What stays

- The manifests and profiles remain as historical evidence of what those cohorts recorded. They
  describe those cohorts, not current code, and are not a statement of release qualification.
- Manual pin workflows are expected to fail on current code until they are reworked or removed.
- Behaviour is covered by the functional suites, including the retained Wire 1..1480 workload and
  its 180 second deadline.
