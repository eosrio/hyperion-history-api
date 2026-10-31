import test from 'node:test';
import assert from 'node:assert/strict';
import {isPinnedGitSource} from '../unit/pinned-git-source.mjs';

const revision = 'd'.repeat(40), repository = 'hyperion-wire-plugin';
const pinned = `git+https://github.com/eosrio/${repository}.git#${revision}`;

test('installed Git source admits only exact HTTPS/SSH spellings of the pinned repository and full revision', () => {
    for (const repository of ['hyperion-wire-plugin', 'hyperion-sdk']) {
        for (const prefix of ['git+https://github.com/', 'git+ssh://git@github.com/']) {
            assert.equal(isPinnedGitSource(`${prefix}eosrio/${repository}.git#${revision}`, repository, revision), true);
        }
    }
});

test('installed Git source refuses wrong repository, owner, host, revision and fragment forms', () => {
    for (const value of [pinned.replace(repository, 'hyperion-sdk'), pinned.replace('/eosrio/', '/another/'),
        pinned.replace('github.com', 'github.com.invalid'), pinned.replace('github.com', 'other.invalid'),
        pinned.replace(revision, 'e'.repeat(40)), pinned.replace('#' + revision, ''), pinned + '#ignored',
        pinned + '?ignored=1', pinned.slice(0, -1), pinned + '\n',
        `git+ssh://other@github.com/eosrio/${repository}.git#${revision}`]) {
        assert.equal(isPinnedGitSource(value, repository, revision), false, value);
    }
});

test('invalid expected pins and non-string resolved values cannot authorize an installation', () => {
    assert.equal(isPinnedGitSource(pinned, repository, 'd'), false);
    assert.equal(isPinnedGitSource(pinned, 'another-package', revision), false);
    assert.equal(isPinnedGitSource(new String(pinned), repository, revision), false);
});
