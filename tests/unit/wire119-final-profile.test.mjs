import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const root = fileURLToPath(new URL('../../', import.meta.url));
const profile = JSON.parse(readFileSync(root + 'docs/qualification/wire-final-observer-source-profile.json'));
const hash = b => createHash('sha256').update(b).digest('hex');
const verify = (name, bytes) => assert.equal(hash(bytes), profile.sourceSha256[name], 'observer source bytes');
test('distinct observation profile binds the exact two source files and unchanged runtime admission', () => {
    assert.equal(profile.profile, 'wire119-final-observer-source-v1');
    assert.equal(profile.baseCommit, '0d6d11ffc5857d1745ab9343a748537a4e4cb805');
    assert.equal(profile.wireRevision, 'e691f4471c6e5fdbe001e6709e88d48d33d8bf4c');
    assert.equal(profile.sdkRevision, '7412889a14c84342551fd864ea3ebfcf28849385');
    assert.equal(profile.productionEmissionProfile, 'stateful-owner-v2-7412889-e691f44-complete-kind-engineering');
    assert.equal(profile.retainedResponseFixtureSha256, '62f5e838a9f4dd937c925bc22a6651bffc295b0bc33f3876f7296a1a8b6d7d10');
    assert.equal(hash(readFileSync(root + 'tests/unit/wire119-final-state-responses.json')), profile.retainedResponseFixtureSha256);
    assert.equal(Object.keys(profile.sourceSha256).length, 2);
    for (const name of Object.keys(profile.sourceSha256)) {
        const bytes = readFileSync(root + name); verify(name, bytes);
        assert.throws(() => verify(name, Buffer.concat([bytes, Buffer.from('x')])), /observer source bytes/);
    }
});
