import {createHash} from 'node:crypto';
import {actionHistoryImmutableJson} from './action-history-manifest.js';
import {currentProofConsumerScope, type ProofConsumerScope} from '../protocol/proof-consumer-scope.js';
import {assertFreshBundlePrepare, protocolImmutableJson, type FreshBundlePrepare,
    type ImmutableProtocolBundleStore} from '../protocol/immutable-bundle-store.js';

/** A process-local result of an acknowledged immutable write, not a record read. */
export interface FreshActionWrite {
    kind: 'confirmed-handoff' | 'attempt-disposition'; id: string;
    recordSha256: string; workSha256: string;
    classification: 'confirmed-handoff' | 'intentional-no-effect' | 'intentional-suppression'
        | 'source-incomplete' | 'contract-incomplete' | 'raw-incomplete';
}

const issued = new WeakMap<object, {scope: ProofConsumerScope; write: FreshActionWrite}>();
const sha = (value: unknown) => createHash('sha256').update(actionHistoryImmutableJson(value)).digest('hex');
function classify(kind: FreshActionWrite['kind'], record: {disposition?: unknown}): FreshActionWrite['classification'] {
    if (kind === 'confirmed-handoff') return 'confirmed-handoff';
    if (record.disposition === 'no-effects' || record.disposition === 'policy-excluded') return 'intentional-no-effect';
    if (record.disposition === 'operator-disabled') return 'intentional-suppression';
    if (record.disposition === 'source-unprocessable') return 'source-incomplete';
    if (record.disposition === 'contract-output-incomplete') return 'contract-incomplete';
    if (record.disposition === 'raw-incomplete-handoff') return 'raw-incomplete';
    throw new Error('Action write has no typed disposition classification');
}

export function issueFreshActionWrite<T extends object>(result: T, kind: FreshActionWrite['kind'], id: string,
                                                        record: {work: unknown; disposition?: unknown}, proof: FreshBundlePrepare,
                                                        store: ImmutableProtocolBundleStore): T {
    const envelope = {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(record)};
    const digest = createHash('sha256').update(protocolImmutableJson(envelope)).digest('hex');
    const scope = assertFreshBundlePrepare(store, proof, id, digest);
    if (scope) issued.set(result, {scope, write: {kind, id, recordSha256: sha(record),
        workSha256: sha(record.work), classification: classify(kind, record)}});
    return result;
}

/** Only the exact returned object, while its original attempt remains active, can cross the worker IPC seam. */
export function consumeFreshActionWrite(result: object): FreshActionWrite {
    const scope = currentProofConsumerScope(true)!, value = issued.get(result);
    if (!value || value.scope !== scope) throw new Error('Action write lacks a fresh result from this worker attempt');
    scope.assertActive(); issued.delete(result);
    return {...value.write};
}
