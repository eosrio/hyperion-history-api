import {createHash} from 'node:crypto';
import {readFile, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProtocolSelection, validateProtocolNativeActions, type ProtocolComponent,
    type ProtocolNativeActionRequirement, type ProtocolNativeActions, type ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import {createContractDecoder, type ContractDecoder} from './contract-cache.js';
import {installedRuntimeArtifacts} from '../helpers/runtime-artifacts.js';

export type ChainProtocolConfiguration =
    | {provider: 'antelope'}
    | {provider: 'extension'; package: string; profileId: string};

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const applyMethod = Reflect.apply;
// Host support cannot be supplied through operator configuration or retained history.
const nativeActionInterfaceVersions = Object.freeze([1]);

/** Inspect the first visible property without evaluating an optional capability accessor. */
function nativeCapability(provider: ProtocolProvider): unknown {
    for (let owner: object | null = provider; owner; owner = Object.getPrototypeOf(owner)) {
        const property = Object.getOwnPropertyDescriptor(owner, 'nativeActions');
        if (!property) continue;
        if (!Object.hasOwn(property, 'value')) throw new Error('Native actions must be a data property of the selected profile');
        return property.value;
    }
    return undefined;
}

/** Seal declared capability or absence, retaining original method receivers and contract codec. */
function providerSnapshot(provider: ProtocolProvider, requirement?: ProtocolNativeActionRequirement): ProtocolProvider {
    const capability = nativeCapability(provider);
    let nativeActions: ProtocolNativeActions | undefined;
    if (requirement) {
        const checked = validateProtocolNativeActions(capability, requirement);
        if (!checked.valid) throw new Error(`Native actions do not implement the selected profile: ${checked.errors.map(error => error.message).join('; ')}`);
        nativeActions = checked.nativeActions;
    } else if (capability !== undefined) throw new Error('Native actions are not supported by the selected profile');
    const createShipSession = provider.createShipSession, normalizeDelta = provider.normalizeDelta;
    const observeBlockAbi = provider.observeBlockAbi, verifyNativeGenesis = provider.verifyNativeGenesis;
    const snapshot: ProtocolProvider = {profileId: provider.profileId, contractCodec: provider.contractCodec,
        createShipSession: handshake => applyMethod(createShipSession, provider, [handshake]),
        normalizeDelta: (input, context) => applyMethod(normalizeDelta, provider, [input, context]),
        ...(nativeActions ? {nativeActions} : {})};
    if (observeBlockAbi) snapshot.observeBlockAbi = (input, source) => applyMethod(observeBlockAbi, provider, [input, source]);
    if (verifyNativeGenesis) snapshot.verifyNativeGenesis = (input, source) => applyMethod(verifyNativeGenesis, provider, [input, source]);
    return Object.freeze(snapshot);
}

/** Verify inert artifacts before any provider module or native addon is imported. */
async function installedComponent(packageRoot: string, module: string, runtime: 'node' | 'rust', version: string,
                                  requiredEntrypoint?: string): Promise<ProtocolComponent> {
    const manifestPath = fileURLToPath(import.meta.resolve(`${module}/protocol-${runtime}-artifact.json`));
    const bytes = await readFile(manifestPath);
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.schemaVersion !== 1 || manifest.sourceModified !== false || typeof manifest.sourceRevision !== 'string'
        || !/^[0-9a-f]{40}$/.test(manifest.sourceRevision) || !Array.isArray(manifest.files) || !manifest.files.length) {
        throw new Error(`Invalid ${runtime} protocol artifact manifest`);
    }
    const seen = new Set<string>();
    for (const entry of manifest.files) {
        if (typeof entry.path !== 'string' || entry.path.includes('\\') || isAbsolute(entry.path)
            || !/^[0-9a-f]{64}$/.test(entry.sha256) || seen.has(entry.path)) throw new Error('Invalid protocol artifact member');
        const path = await realpath(resolve(packageRoot, entry.path));
        const member = relative(packageRoot, path);
        if (member === '..' || member.startsWith(`..${sep}`) || isAbsolute(member)) throw new Error('Protocol artifact escapes package root');
        seen.add(entry.path);
        if (digest(await readFile(path)) !== entry.sha256) throw new Error(`Protocol artifact integrity mismatch: ${entry.path}`);
    }
    if (requiredEntrypoint && !seen.has(relative(packageRoot, await realpath(requiredEntrypoint)).split(sep).join('/'))) {
        throw new Error('Protocol executable is not covered by its artifact manifest');
    }
    return {id: manifest.id, runtime, version, sourceRevision: manifest.sourceRevision, sha256: digest(bytes)};
}

/** Immutable executable selection is made once per worker lifetime. */
export async function loadChainProtocol(configuration?: ChainProtocolConfiguration, engineering: {sourceEvidence?: boolean} = {}): Promise<{provider: ProtocolProvider; decoder: ContractDecoder; id: string; components?: readonly ProtocolComponent[]}> {
    if (configuration === undefined || configuration.provider === 'antelope') {
        if (configuration && Object.keys(configuration).some(key => key !== 'provider')) throw new Error('Invalid Antelope protocol configuration');
        let components: readonly ProtocolComponent[] | undefined;
        if (engineering.sourceEvidence === true) {
            const artifact = await installedRuntimeArtifacts(true);
            const host = await readJson(fileURLToPath(new URL('../../../package.json', import.meta.url)));
            components = Object.freeze([Object.freeze({id: 'hyperion-antelope-runtime', runtime: 'node' as const,
                version: host.version, sourceRevision: artifact.codeRevision, sha256: artifact.executableSha256})]);
        }
        const {createAntelopeProvider} = await import('./antelope.js');
        return {...await createAntelopeProvider(), id: 'antelope', ...(components ? {components} : {})};
    }
    if (configuration.provider !== 'extension' || typeof configuration.package !== 'string'
        || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(configuration.package)
        || typeof configuration.profileId !== 'string'
        || Object.keys(configuration).some(key => !['provider', 'package', 'profileId'].includes(key))) throw new Error('Invalid protocol extension configuration');
    const module = configuration.package;
    const descriptorPath = fileURLToPath(import.meta.resolve(`${module}/protocol-provider.json`));
    const packageRoot = await realpath(resolve(dirname(descriptorPath), '..'));
    const metadata = await readJson(resolve(packageRoot, 'package.json'));
    if (metadata.name !== module) throw new Error('Protocol package identity mismatch');
    const descriptor = await readJson(descriptorPath);
    const executablePath = fileURLToPath(import.meta.resolve(`${module}/provider`));
    const components = await Promise.all((['node', 'rust'] as const).map(runtime => installedComponent(packageRoot, module, runtime, metadata.version,
        runtime === 'node' ? executablePath : undefined)));
    const host = await readJson(fileURLToPath(new URL('../../../package.json', import.meta.url)));
    const sdk = await readJson(fileURLToPath(new URL('../package.json', import.meta.resolve('@eosrio/hyperion-sdk'))));
    const selection = validateProtocolSelection(descriptor, {profileId: configuration.profileId,
        environment: {hyperion: host.version, sdk: sdk.version}, components, nativeActionInterfaceVersions});
    if (!selection.valid) throw new Error(`Protocol selection rejected: ${selection.errors.map(error => `${error.path}: ${error.message}`).join('; ')}`);
    // All profiles, source pins and Node/Rust source artifacts are validated first.
    const executable = await import(`${module}/provider`);
    const provider: ProtocolProvider = executable.createProtocolProvider(configuration.profileId);
    if (!provider || provider.profileId !== configuration.profileId || typeof provider.createShipSession !== 'function'
        || typeof provider.normalizeDelta !== 'function' || !provider.contractCodec
        || !['decodeAbi', 'encodeAbi', 'decodeValue', 'encodeValue'].every(method => typeof provider.contractCodec[method] === 'function')) {
        throw new Error('Protocol provider does not implement the selected interface');
    }
    const selectedProvider = providerSnapshot(provider, selection.profile.nativeActions);
    return {provider: selectedProvider, decoder: createContractDecoder(selectedProvider.contractCodec), id: selection.descriptor.manifest.package,
        components: selection.profile.components};
}
