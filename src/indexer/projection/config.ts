import {createHash} from 'node:crypto';
import {ProjectionContractError, validateProjectionBinding, validateProjectionDefinition,
    type ProjectionBinding, type ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

export interface PortableStateConfiguration {
    readonly backend: {readonly kind: 'mongodb'; readonly id: string; readonly database: string};
    readonly projections: readonly ProjectionDefinition[];
}
export interface ResolvedPortableStateConfiguration extends PortableStateConfiguration {
    readonly configDigest: string;
}

function invalid(message: string): never {throw new ProjectionContractError('projection.invalid-contract', message);}
const hash = (value: unknown) => createHash('sha256').update(protocolImmutableJson(value)).digest('hex');
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

/** Explicit definitions are the allowed contract/table scope. Configuration grants no source readiness. */
export function resolvePortableStateConfiguration(input: unknown, chainId: string): ResolvedPortableStateConfiguration | undefined {
    if (input === undefined) return undefined;
    if (!/^[0-9a-f]{64}$/.test(chainId)) invalid('Portable state requires the configured chain identity');
    let value: any;
    try {value = JSON.parse(protocolImmutableJson(input, 4 * 1024 * 1024));}
    catch {invalid('Portable state configuration must be bounded plain JSON');}
    if (!value || Array.isArray(value) || !keys(value, ['backend', 'projections'])
        || !value.backend || Array.isArray(value.backend) || !keys(value.backend, ['kind', 'id', 'database'])
        || value.backend.kind !== 'mongodb' || typeof value.backend.id !== 'string' || !value.backend.id.length
        || Buffer.byteLength(value.backend.id) > 256 || !value.backend.id.isWellFormed()
        || typeof value.backend.database !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(value.backend.database)
        || !Array.isArray(value.projections) || !value.projections.length || value.projections.length > 32) {
        invalid('Portable state requires one MongoDB backend and 1 to 32 explicit projections');
    }
    const seen = new Set<string>();
    const projections = value.projections.map((inputDefinition: unknown) => {
        const result = validateProjectionDefinition(inputDefinition);
        if (!result.valid) invalid(result.errors.map(error => `${error.path}: ${error.message}`).join('; '));
        if (seen.has(result.value.id)) invalid('Portable projection IDs must be unique within the chain');
        seen.add(result.value.id);
        return result.value;
    }).sort((a: ProjectionDefinition, b: ProjectionDefinition) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const backend = Object.freeze({kind: 'mongodb' as const, id: value.backend.id as string, database: value.backend.database as string});
    const configuration = {backend, projections: Object.freeze(projections)};
    return Object.freeze({...configuration, configDigest: hash(['hyperion-portable-state-config-v1', chainId, configuration])});
}

/** Stable instance identity survives restart; it is separate from the canonical source-owner generation. */
export function portableStateBinding(configuration: ResolvedPortableStateConfiguration,
                                     definition: ProjectionDefinition, chainId: string): ProjectionBinding {
    const generation = hash(['hyperion-portable-state-instance-v1', chainId, configuration.backend, definition]);
    const result = validateProjectionBinding(definition, {chainId, backendId: configuration.backend.id,
        projectionId: definition.id, mappingRevision: definition.mappingRevision, abiDeployment: definition.source.abiDeployment,
        abiSha256: definition.source.abiSha256, generation});
    if (!result.valid) invalid(result.errors.map(error => `${error.path}: ${error.message}`).join('; '));
    return result.value;
}
