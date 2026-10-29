import {createHash} from 'node:crypto';
import {STATEFUL_RECOVERY_LIMITS} from '@eosrio/hyperion-sdk/projection-stateful';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import type {PortableStateConfiguration} from './config.js';

/** Explicit version2 opt-in. Existing scalar configuration and backend selection remain unchanged. */
export interface StatefulOwnerConfigurationV2 {
    readonly interfaceVersion: 2;
    readonly sourceInputVersion: 2;
    readonly backend: {readonly kind: 'mongodb'; readonly id: string; readonly database: string};
    readonly recovery: {readonly bytes: number; readonly blocks?: number; readonly maxBlockBytes?: number; readonly receipts?: number};
    readonly api: {readonly timeoutMs: number; readonly maximumPendingProbes: number};
    readonly maximumFramesPerDrain?: number;
    readonly generation?: string;
    readonly operationTimeoutMS?: number;
    readonly transactionTimeoutMS?: number;
}
export interface ResolvedStatefulOwnerConfigurationV2 {
    readonly interfaceVersion: 2; readonly sourceInputVersion: 2;
    readonly backend: StatefulOwnerConfigurationV2['backend'];
    readonly recovery: {readonly bytes: number; readonly blocks: number; readonly maxBlockBytes: number; readonly receipts: number};
    readonly api: StatefulOwnerConfigurationV2['api'];
    readonly maximumFramesPerDrain: number; readonly operationTimeoutMS: number; readonly transactionTimeoutMS: number;
    readonly generation: string;
    readonly configDigest: string;
}
function requireConfig(value: unknown, message: string): asserts value {if (!value) throw new Error(message);}
function record(value: any, required: string[], optional: string[] = []): asserts value is Record<string, any> {
    requireConfig(value && typeof value === 'object' && !Array.isArray(value)
        && required.every(key => Object.hasOwn(value, key))
        && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Invalid stateful owner configuration fields');
}
function bounded(value: unknown, maximum: number, label: string): number {
    requireConfig(Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum, `Invalid stateful ${label}`);
    return Number(value);
}
export function resolveStatefulOwnerConfigurationV2(input: unknown,
    portable?: PortableStateConfiguration): ResolvedStatefulOwnerConfigurationV2 | undefined {
    if (input === undefined) return undefined;
    const value = JSON.parse(protocolImmutableJson(input, 64 * 1024));
    record(value, ['interfaceVersion', 'sourceInputVersion', 'backend', 'recovery', 'api'],
        ['maximumFramesPerDrain', 'operationTimeoutMS', 'transactionTimeoutMS', 'generation']);
    requireConfig(value.interfaceVersion === 2 && value.sourceInputVersion === 2, 'Stateful owner/source version2 must be explicitly selected');
    record(value.backend, ['kind', 'id', 'database']);
    requireConfig(value.backend.kind === 'mongodb' && typeof value.backend.id === 'string' && value.backend.id.isWellFormed()
        && value.backend.id.length > 0 && Buffer.byteLength(value.backend.id) <= 256
        && typeof value.backend.database === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(value.backend.database), 'Invalid stateful MongoDB backend');
    if (portable) requireConfig(protocolImmutableJson(portable.backend) === protocolImmutableJson(value.backend),
        'Scalar and stateful projections must use the same per-chain backend');
    record(value.recovery, ['bytes'], ['blocks', 'maxBlockBytes', 'receipts']);
    const bytes = bounded(value.recovery.bytes, STATEFUL_RECOVERY_LIMITS.retainedBytes, 'recovery byte budget');
    const blocks = bounded(value.recovery.blocks ?? 256, STATEFUL_RECOVERY_LIMITS.retainedBlocks, 'recovery blocks');
    const recovery = Object.freeze({bytes, blocks,
        maxBlockBytes: bounded(value.recovery.maxBlockBytes ?? Math.min(bytes, 8 * 1024 * 1024), bytes, 'recovery block bytes'),
        receipts: bounded(value.recovery.receipts ?? blocks, STATEFUL_RECOVERY_LIMITS.retainedBlocks, 'receipt retention')});
    record(value.api, ['timeoutMs', 'maximumPendingProbes']);
    const api = Object.freeze({timeoutMs: bounded(value.api.timeoutMs, 60_000, 'request timeout'),
        maximumPendingProbes: bounded(value.api.maximumPendingProbes, 4096, 'control probe budget')});
    const generation = value.generation ?? 'initial';
    requireConfig(typeof generation === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(generation), 'Invalid explicit stateful generation');
    const resolved = {interfaceVersion: 2 as const, sourceInputVersion: 2 as const, backend: Object.freeze({...value.backend}) as StatefulOwnerConfigurationV2['backend'],
        recovery, api, generation, maximumFramesPerDrain: bounded(value.maximumFramesPerDrain ?? 8, 32, 'drain quantum'),
        operationTimeoutMS: bounded(value.operationTimeoutMS ?? 5000, 30_000, 'native operation timeout'),
        transactionTimeoutMS: bounded(value.transactionTimeoutMS ?? 30_000, 60_000, 'native transaction timeout')};
    requireConfig(resolved.operationTimeoutMS <= resolved.transactionTimeoutMS, 'Stateful operation timeout exceeds transaction timeout');
    return Object.freeze({...resolved, configDigest: createHash('sha256').update(protocolImmutableJson(['hyperion-stateful-owner-config-v2', resolved])).digest('hex')});
}
