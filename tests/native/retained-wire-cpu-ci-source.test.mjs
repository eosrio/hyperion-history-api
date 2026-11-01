import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('retained Wire CPU capture preserves the test and fail-fast sequence', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8');
  const section = workflow.split('      - name: Check retained Wire managed state and historical source authority')[1]
    .split('      - name: Check Fastify request admission')[0];
  assert.match(section, /mkdir "\$RUNNER_TEMP\/retained-wire-cpu"/);
  assert.match(section, /HYPERION_RETAINED_WIRE_STAGES=1 node --cpu-prof --cpu-prof-dir="\$RUNNER_TEMP\/retained-wire-cpu" --test tests\/unit\/wire-managed-state-v2-native\.mjs\n          node --test tests\/unit\/protocol-abi-history-native\.mjs/);
  assert.match(section, /name: Retain retained Wire CPU samples\n        if: always\(\)/);
  assert.match(section, /if-no-files-found: warn/);
  assert.doesNotMatch(section, /--cpu-prof-name|continue-on-error|test-timeout|\|\| true/);
});
