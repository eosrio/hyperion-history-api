/** Installation may preserve either supported transport; repository and full revision stay exact. */
export function isPinnedGitSource(resolved, repository, revision) {
    return typeof resolved === 'string' && ['hyperion-wire-plugin', 'hyperion-sdk'].includes(repository)
        && typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision)
        && [`git+https://github.com/eosrio/${repository}.git#${revision}`,
            `git+ssh://git@github.com/eosrio/${repository}.git#${revision}`].includes(resolved);
}
