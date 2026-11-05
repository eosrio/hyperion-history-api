import assert from 'node:assert/strict';
assert.ok(!process.versions.bun && /^(24|26)\./.test(process.versions.node), 'Native fixture requires Node.js 24 or 26');
