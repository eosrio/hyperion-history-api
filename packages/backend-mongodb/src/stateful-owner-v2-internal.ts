import type {ClientSession} from 'mongodb';
import type {StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import type {StatefulCompletedReadV2, StatefulOwnerAdapterV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {requireState} from './stateful-contract.js';

type SnapshotCheck = (read: StatefulCompletedReadV2, expected: StatefulView, session: ClientSession) => Promise<void>;
interface SnapshotBridge {createSession(): ClientSession; check: SnapshotCheck}
// Native-internal bridge only: not an SDK port/export, DTO, or independently issued authority.
const snapshots = new WeakMap<StatefulOwnerAdapterV2, SnapshotBridge>();
export function registerStatefulOwnerCompletedSnapshotV2(adapter: StatefulOwnerAdapterV2, bridge: SnapshotBridge): void {
    requireState(!snapshots.has(adapter), 'Native owner snapshot bridge already exists'); snapshots.set(adapter, bridge);
}
export function createStatefulOwnerCompletedSessionV2(adapter: StatefulOwnerAdapterV2): ClientSession {
    const bridge = snapshots.get(adapter); requireState(bridge, 'Native owner snapshot bridge is unavailable', 'stateful.unavailable');
    return bridge.createSession();
}
export async function assertStatefulOwnerCompletedSnapshotV2(adapter: StatefulOwnerAdapterV2,
    read: StatefulCompletedReadV2, expected: StatefulView, session: ClientSession): Promise<void> {
    const bridge = snapshots.get(adapter); requireState(bridge, 'Native owner snapshot bridge is unavailable', 'stateful.unavailable');
    await bridge.check(read, expected, session);
}
