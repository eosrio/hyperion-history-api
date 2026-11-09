import type {Client} from '@elastic/elasticsearch';
import {captureStatefulOwnerCandidateV2, type StatefulCandidateStoreV2, type StatefulCandidateV2,
    type StatefulOwnerDeclarationV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {boundedCanonicalJson} from '../helpers/bounded-json.js';
import {ImmutableProtocolBundleReadError, ImmutableProtocolBundleStore} from '../protocol/immutable-bundle-store.js';

/**
 * Candidate custody that the owner can bound. Block views address each candidate by its height, so whole
 * height ranges can be removed once no recovery path can read them. The plain load/retain keep the original
 * source-addressed layout for direct SDK callers, and are never pruned.
 */
export interface StatefulCandidateCustodyV2 extends StatefulCandidateStoreV2 {
    /** Custody for one selected block. A pending source may still name a candidate kept before block addressing. */
    block(blockNum: number, pendingSourceDigest: string | null): StatefulCandidateStoreV2;
    /** Removes candidates of blocks strictly below `floor`. Incomplete means more remain; call again. */
    pruneBelow(floor: number): Promise<{readonly deleted: number; readonly complete: boolean}>;
    /** Removes every candidate of blocks strictly above `blockNum`, including ones written moments ago. */
    purgeAbove(blockNum: number): Promise<void>;
}

const height = (blockNum: number) => {
    if (!Number.isSafeInteger(blockNum) || blockNum < 0) throw new Error('Candidate custody height is invalid');
    return String(blockNum).padStart(16, '0');
};
/** Bounds each retention request; at two documents per candidate one call clears 2048 blocks. */
const maximumDocumentsPerRetentionCall = 4096;

/** Fixed candidate custody uses the existing immutable bundle algorithm, never another progress journal. */
export function createStatefulCandidateCustodyV2(client: Client, chain: string, replicas: number,
    declaration: StatefulOwnerDeclarationV2): StatefulCandidateCustodyV2 {
    const maximumBytes = declaration.projection.limits.candidateBytes, chunkBytes = Math.min(512 * 1024, maximumBytes);
    const canonicalCandidate = (value: unknown) => boundedCanonicalJson(value, {maximumBytes, numberPolicy: 'finite', errorPrefix: 'Candidate custody'});
    const store = new ImmutableProtocolBundleStore(client, chain, replicas, 'stateful-candidate-v2', 'stateful-candidates-v2',
        {chunkBytes, maximumBytes, maximumChunks: Math.ceil(maximumBytes / chunkBytes)});
    const checked = (digest: string, sourceDigest: string) => {
        if (digest !== declaration.digest || !/^[0-9a-f]{64}$/.test(sourceDigest)) throw new Error('Candidate custody declaration/source differs');
    };
    const legacy = (digest: string, sourceDigest: string) => {checked(digest, sourceDigest); return `h45statecandidate2:${digest}:${sourceDigest}`;};
    const prefix = `h45statecustody2:${declaration.digest}:`;
    const addressed = (blockNum: number, digest: string, sourceDigest: string) => {checked(digest, sourceDigest); return prefix + height(blockNum) + ':' + sourceDigest;};
    const read = async (id: string, sourceDigest: string): Promise<StatefulCandidateV2 | null> => {
        try {
            const bytes = await store.readCandidateBytes(id);
            const value: unknown = JSON.parse(bytes.toString('utf8'));
            const candidate = await captureStatefulOwnerCandidateV2(declaration, value);
            if (!Buffer.from(canonicalCandidate(candidate)).equals(bytes)) throw new Error('Candidate custody is noncanonical');
            if (candidate.source.digest !== sourceDigest) throw new Error('Candidate custody source hash differs');
            return candidate;
        } catch (error) {
            if (error instanceof ImmutableProtocolBundleReadError && error.code === 'missing') return null;
            throw error; // Partial/unknown/corrupt custody cannot authorize another reducer run.
        }
    };
    const write = async (input: StatefulCandidateV2, address: (candidate: StatefulCandidateV2) => string,
        readback: (candidate: StatefulCandidateV2) => Promise<StatefulCandidateV2 | null>) => {
        const candidate = await captureStatefulOwnerCandidateV2(declaration, input);
        const id = address(candidate);
        const payload = Buffer.from(canonicalCandidate(candidate));
        if (payload.length > maximumBytes) throw new Error('Candidate custody exceeds raw byte bound');
        await store.prepareCandidateBytes(id, payload);
        const stored = await readback(candidate);
        if (!stored || stored.digest !== candidate.digest) throw new Error('Candidate custody acknowledgement is unresolved');
    };
    const load = (digest: string, sourceDigest: string) => read(legacy(digest, sourceDigest), sourceDigest);
    return {
        load,
        retain: input => write(input, candidate => legacy(candidate.declarationDigest, candidate.source.digest),
            candidate => load(candidate.declarationDigest, candidate.source.digest)),
        block(blockNum, pendingSourceDigest) {
            height(blockNum);
            const blockLoad = async (digest: string, sourceDigest: string) => {
                const current = await read(addressed(blockNum, digest, sourceDigest), sourceDigest);
                // Only a durable pending intent needs its exact original; any other miss may reduce again.
                return current ?? (sourceDigest === pendingSourceDigest ? load(digest, sourceDigest) : null);
            };
            return {
                load: blockLoad,
                retain: input => write(input, candidate => {
                    if (candidate.source.source.block.blockNum !== blockNum) throw new Error('Candidate custody block differs');
                    return addressed(blockNum, candidate.declarationDigest, candidate.source.digest);
                }, candidate => read(addressed(blockNum, candidate.declarationDigest, candidate.source.digest), candidate.source.digest)),
            };
        },
        async pruneBelow(floor) {
            if (floor < 1) return {deleted: 0, complete: true};
            return store.deleteCandidateRange(prefix, prefix + height(floor), {refresh: false, maximumDocuments: maximumDocumentsPerRetentionCall});
        },
        async purgeAbove(blockNum) {
            const from = prefix + height(blockNum + 1);
            for (let call = 0; call < 64; call++) {
                const result = await store.deleteCandidateRange(from, prefix + '~', {refresh: call === 0, maximumDocuments: maximumDocumentsPerRetentionCall});
                if (result.complete) return;
            }
            throw new Error('Candidate custody purge did not complete');
        },
    };
}
