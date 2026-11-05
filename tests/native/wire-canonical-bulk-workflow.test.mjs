import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../.github/workflows/wire-canonical-bulk.yml',import.meta.url),'utf8');
test('coupled bulk workflow runs both Node majors on the release and parent routes after source admission',()=>{
 assert.match(source,/branches: \["release\/4\.5", "codex\/wire-release-integration"\]/);
 assert.match(source,/node: \["24\.22\.1", "26\.4\.0"\]/);
 assert.match(source,/runs-on: ubuntu-24\.04/);
 for(const line of ['npm ci --prefix packages/backend-mongodb','npm ci --allow-git=all','bun check -p packages/backend-mongodb/tsconfig.json','npm run typecheck','npm run build','source-check.mjs','--admit-wire34-cbfb','bun test tests/unit/protocol-abi-proof.test.ts','node tests/unit/wire-canonical-bulk-regression.mjs normal','node tests/unit/wire-historical-bulk-regression.mjs normal','node tests/unit/wire-historical-bulk-regression.mjs disabled']) assert.ok(source.includes(line),line);
 assert.ok(source.indexOf('--admit-wire34-cbfb')<source.indexOf('bun test tests/unit/protocol-abi-proof.test.ts'));
 assert.doesNotMatch(source,/continue-on-error/);
});
