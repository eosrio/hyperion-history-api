import type {Client} from '@elastic/elasticsearch';
import {captureStatefulOwnerCandidateV2, type StatefulCandidateStoreV2, type StatefulCandidateV2,
    type StatefulOwnerDeclarationV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {ImmutableProtocolBundleReadError, ImmutableProtocolBundleStore} from '../protocol/immutable-bundle-store.js';

/** Fixed candidate custody uses the existing immutable bundle algorithm, never another progress journal. */
export function createStatefulCandidateCustodyV2(client: Client, chain: string, replicas: number,
    declaration: StatefulOwnerDeclarationV2): StatefulCandidateStoreV2 {
    const maximumBytes = declaration.projection.limits.candidateBytes, chunkBytes = Math.min(512 * 1024, maximumBytes);
    const store = new ImmutableProtocolBundleStore(client, chain, replicas, 'stateful-candidate-v2', 'stateful-candidates-v2',
        {chunkBytes, maximumBytes, maximumChunks: Math.ceil(maximumBytes / chunkBytes)});
    const address = (digest: string, sourceDigest: string) => {
        if (digest !== declaration.digest || !/^[0-9a-f]{64}$/.test(sourceDigest)) throw new Error('Candidate custody declaration/source differs');
        return `h45statecandidate2:${digest}:${sourceDigest}`;
    };
    const load = async (digest: string, sourceDigest: string): Promise<StatefulCandidateV2 | null> => {
        const id = address(digest, sourceDigest);
        try {
            const candidate = await captureStatefulOwnerCandidateV2(declaration, await store.read(id));
            if (candidate.source.digest !== sourceDigest) throw new Error('Candidate custody source hash differs');
            return candidate;
        } catch (error) {
            if (error instanceof ImmutableProtocolBundleReadError && error.code === 'missing') return null;
            throw error; // Partial/unknown/corrupt custody cannot authorize another reducer run.
        }
    };
    return {
        load,
        async retain(input: StatefulCandidateV2) {
            const candidate = await captureStatefulOwnerCandidateV2(declaration, input);
            await store.prepare(address(candidate.declarationDigest, candidate.source.digest), candidate);
            const readback = await load(candidate.declarationDigest, candidate.source.digest);
            if (!readback || readback.digest !== candidate.digest) throw new Error('Candidate custody acknowledgement is unresolved');
        },
    };
}
