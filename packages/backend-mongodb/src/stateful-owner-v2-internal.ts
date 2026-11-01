import type {ClientSession} from 'mongodb';
import type {StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import type {StatefulCompletedReadV2, StatefulOwnerAdapterV2, StatefulOwnerLeaseV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import type {StatefulNativeSidecarsV1} from './stateful-effects.js';
import {requireState} from './stateful-contract.js';

type SnapshotCheck = (read: StatefulCompletedReadV2, expected: StatefulView, session: ClientSession) => Promise<void>;
export interface StatefulOwnedNativeSnapshotV1 {
    readonly session: ClientSession; readonly view: StatefulView;
    call<T>(work: () => Promise<T>): Promise<T>;
}
interface SnapshotBridge {readonly declarationDigest: string; createSession(): ClientSession; check: SnapshotCheck;
    withOwner?<T>(lease: StatefulOwnerLeaseV2, work: (scope: StatefulOwnedNativeSnapshotV1) => Promise<T>): Promise<T>}
// Native-internal bridge only: not an SDK port/export, DTO, or independently issued authority.
const snapshots = new WeakMap<StatefulOwnerAdapterV2, SnapshotBridge>();
const origins = new WeakMap<StatefulOwnerAdapterV2, StatefulOwnerAdapterV2>();
const sidecars = new WeakMap<StatefulOwnerAdapterV2, StatefulNativeSidecarsV1>();
const origin = (adapter: StatefulOwnerAdapterV2) => origins.get(adapter) ?? adapter;
/** A native facade forwards the very same capabilities; this never issues or copies a read/owner grant. */
export function registerStatefulOwnerNativeFacadeV1(facade: StatefulOwnerAdapterV2, base: StatefulOwnerAdapterV2): void {
    requireState(facade !== base && !origins.has(facade) && snapshots.has(origin(base)), 'Unknown or duplicate native owner facade');
    origins.set(facade, origin(base));
}
export function registerStatefulOwnerSidecarsV1(adapter: StatefulOwnerAdapterV2, hooks: StatefulNativeSidecarsV1): void {
    const selected = origin(adapter); requireState(snapshots.has(selected) && !sidecars.has(selected), 'Native sidecars already registered or owner is foreign');
    sidecars.set(selected, hooks);
}
export function statefulOwnerSidecarsV1(adapter: StatefulOwnerAdapterV2): StatefulNativeSidecarsV1 | undefined {return sidecars.get(origin(adapter));}
export function assertStatefulOwnerNativeDeclarationV1(adapter: StatefulOwnerAdapterV2, digest: string): void {
    requireState(snapshots.get(origin(adapter))?.declarationDigest === digest, 'Native attachment belongs to another actual owner declaration');
}
export async function withStatefulOwnerNativeSnapshotV1<T>(adapter: StatefulOwnerAdapterV2, lease: StatefulOwnerLeaseV2,
    work: (scope: StatefulOwnedNativeSnapshotV1) => Promise<T>): Promise<T> {
    const bridge = snapshots.get(origin(adapter)); requireState(bridge?.withOwner, 'Native owned snapshot is unavailable', 'stateful.unavailable');
    return bridge.withOwner(lease, work);
}
export function registerStatefulOwnerCompletedSnapshotV2(adapter: StatefulOwnerAdapterV2, bridge: SnapshotBridge): void {
    requireState(!snapshots.has(adapter), 'Native owner snapshot bridge already exists'); snapshots.set(adapter, bridge);
}
export function createStatefulOwnerCompletedSessionV2(adapter: StatefulOwnerAdapterV2): ClientSession {
    const bridge = snapshots.get(origin(adapter)); requireState(bridge, 'Native owner snapshot bridge is unavailable', 'stateful.unavailable');
    return bridge.createSession();
}
export async function assertStatefulOwnerCompletedSnapshotV2(adapter: StatefulOwnerAdapterV2,
    read: StatefulCompletedReadV2, expected: StatefulView, session: ClientSession): Promise<void> {
    const bridge = snapshots.get(origin(adapter)); requireState(bridge, 'Native owner snapshot bridge is unavailable', 'stateful.unavailable');
    await bridge.check(read, expected, session);
}
