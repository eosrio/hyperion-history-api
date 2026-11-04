import test from 'node:test';
import assert from 'node:assert/strict';
import {assertQualifiedGitLockSource as verify} from './qualified-git-lock.mjs';
const revision = 'e691f4471c6e5fdbe001e6709e88d48d33d8bf4c', name = 'hyperion-wire-plugin';
test('only the exact named GitHub repository and complete revision admit either npm transport', () => {
    for (const prefix of ['git+https://github.com/', 'git+ssh://git@github.com/']) verify(prefix + 'eosrio/' + name + '.git#' + revision, name, revision);
    for (const value of ['git+https://other.example/eosrio/' + name + '.git#' + revision,
        'git+https://github.com/other/' + name + '.git#' + revision,
        'git+https://github.com/eosrio/hyperion-sdk.git#' + revision,
        'git+https://github.com/eosrio/' + name + '.git#' + 'a'.repeat(40),
        'git+https://github.com/eosrio/' + name + '.git#e691f44']) assert.throws(() => verify(value, name, revision));
    assert.throws(() => verify('', name, 'e691f44'));
});
