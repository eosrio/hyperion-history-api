import {createHash} from 'node:crypto';
import type {StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import type {StatefulOwnerRecoveryV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

/** Shared inert request identity; importing an API host need not import the mutable projection controller. */
export interface StatefulOwnerExpectation {
    readonly declarationDigest: string;
    readonly owner: NonNullable<StatefulOwnerRecoveryV2['owner']>;
    readonly view: StatefulView;
}
export const statefulOwnerExpectationDigest = (expected: StatefulOwnerExpectation): string => createHash('sha256')
    .update(protocolImmutableJson(['hyperion-stateful-owner-request-v2', expected.declarationDigest, expected.owner, expected.view])).digest('hex');
