import assert from 'node:assert/strict';
export function assertQualifiedGitLockSource(actual, name, revision) {
    assert.ok(['hyperion-wire-plugin', 'hyperion-sdk'].includes(name));
    assert.match(revision, /^[a-f0-9]{40}$/);
    assert.ok(['git+https://github.com/', 'git+ssh://git@github.com/'].some(prefix =>
        actual === prefix + 'eosrio/' + name + '.git#' + revision), 'exact admitted GitHub repository and full revision required');
}
