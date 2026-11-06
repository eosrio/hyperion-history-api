import {createMongoDbStatefulCompleteKindAdapterV1} from '@eosrio/hyperion-backend-mongodb/stateful-owner-complete-kind-v1';
import type {MongoDbStatefulOwnerAdapterOptionsV2} from '@eosrio/hyperion-backend-mongodb/stateful-owner-v2';
import type {StatefulCompleteKindAdapterV1, StatefulCompleteKindLimitsV1, StatefulCompletedReadV2,
    StatefulOwnerAdapterV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import type {StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';

export async function configuredComplete(options: MongoDbStatefulOwnerAdapterOptionsV2): Promise<StatefulCompleteKindAdapterV1> {
    const totals = {readAttempts: 8, responseRecords: 4, responseBytes: 65536} satisfies StatefulCompleteKindLimitsV1;
    return createMongoDbStatefulCompleteKindAdapterV1(options, totals);
}
function ports(adapter: StatefulCompleteKindAdapterV1, old: StatefulOwnerAdapterV2, read: StatefulCompletedReadV2, view: StatefulView) {
    const totals = adapter.completeKindCapabilities.limits;
    void adapter.readCompletedKey(read, view, {kind: 'declared', key: 'known'}, totals);
    void adapter.readCompletedKind(read, view, 'declared', totals);
    // @ts-expect-error a get-only native adapter does not implement the new counted operation
    old.readCompletedKind(read, view, 'declared', totals);
    // @ts-expect-error native completed capabilities cannot be made from metadata
    const forged: StatefulCompletedReadV2 = {};
    void forged;
}
void ports;
