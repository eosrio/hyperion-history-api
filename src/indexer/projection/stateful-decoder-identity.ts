import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile, realpath} from 'node:fs/promises';
import {builtinModules} from 'node:module';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {actionHistoryImmutableJson} from '../history/action-history-manifest.js';
import {artifactTree} from '../helpers/runtime-artifacts.js';

/**
 * Compiled modules, relative to the build root, that decode, normalize and admit stateful source
 * inputs. Their static import closure is the host code that projected state depends on.
 */
export const STATEFUL_DECODER_ENTRY_MODULES: readonly string[] = Object.freeze([
    'indexer/projection/stateful-source.js', 'indexer/projection/source.js']);
/**
 * Packages pinned with the decoder even when the closure does not import them: the SDK defines the
 * source contract and the native codec decodes Antelope contracts. An absent pinned package is skipped.
 */
export const STATEFUL_DECODER_PINNED_PACKAGES: readonly string[] = Object.freeze(['@eosrio/hyperion-sdk', '@eosrio/node-abieos']);

export interface StatefulDecoderIdentity {
    readonly schemaVersion: 1;
    /** Digest of the decoder modules, the packages they import and the pinned packages. */
    readonly sha256: string;
    readonly modules: readonly {path: string; sha256: string}[];
    readonly packages: readonly {name: string; version: string; members: number; sha256: string}[];
}
export interface StatefulDecoderIdentityOptions {
    /** Build root holding the compiled entry modules. Defaults to this installation's build tree. */
    readonly executableRoot?: string;
    readonly entries?: readonly string[];
    readonly pinnedPackages?: readonly string[];
    /** Root directory of an installed package, or undefined when it is not installed. */
    readonly resolvePackageRoot?: (name: string) => Promise<string | undefined>;
}

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const builtins = new Set(builtinModules);
const staticFrom = /^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*(['"])([^'"\n]+)\1/gm;
const sideEffect = /^[ \t]*import[ \t]*(['"])([^'"\n]+)\1/gm;
const dynamic = /\bimport[ \t]*\(/g;

/** Module specifiers a compiled ES module loads: static imports and re-exports, plus literal dynamic imports. */
export function statefulDecoderSpecifiers(text: string, file = 'module'): string[] {
    const found: string[] = [];
    for (const match of text.matchAll(staticFrom)) found.push(match[2]);
    for (const match of text.matchAll(sideEffect)) found.push(match[2]);
    for (const match of text.matchAll(dynamic)) {
        const lineStart = text.lastIndexOf('\n', match.index) + 1, lineEnd = text.indexOf('\n', match.index);
        const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trimStart();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        const literal = /^\s*(['"])([^'"\n]+)\1\s*\)/.exec(text.slice(match.index + match[0].length));
        // A computed specifier can load code this closure cannot see, so the identity refuses it.
        if (!literal) throw new Error(`Stateful decoder module ${file} has a computed dynamic import`);
        found.push(literal[2]);
    }
    return found;
}

function packageName(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
async function installedPackageRoot(name: string): Promise<string | undefined> {
    let resolved: string;
    try {resolved = fileURLToPath(import.meta.resolve(name));} catch {return undefined;}
    for (let directory = dirname(resolved); ; directory = dirname(directory)) {
        const manifest = join(directory, 'package.json');
        if (existsSync(manifest)) {
            try {if (JSON.parse(await readFile(manifest, 'utf8')).name === name) return await realpath(directory);} catch {}
        }
        if (dirname(directory) === directory) return undefined;
    }
}

/**
 * Identity of the code that turns original source into stateful inputs. It replaces the whole
 * executable digest in the codec and normalizer revisions, so a release that leaves every decoder
 * module and package unchanged keeps existing projected state, while any change to them still
 * requires a new generation. Fails closed when the closure cannot be resolved completely.
 */
export async function statefulDecoderIdentity(options: StatefulDecoderIdentityOptions = {}): Promise<StatefulDecoderIdentity> {
    const root = await realpath(options.executableRoot ?? fileURLToPath(new URL('../../', import.meta.url)));
    const entries = options.entries ?? STATEFUL_DECODER_ENTRY_MODULES, pinned = options.pinnedPackages ?? STATEFUL_DECODER_PINNED_PACKAGES;
    const resolvePackage = options.resolvePackageRoot ?? installedPackageRoot;
    const modules = new Map<string, string>(), imported = new Set<string>();
    const pending = entries.map(entry => resolve(root, entry));
    while (pending.length) {
        const file = pending.pop()!, path = relative(root, file).split(sep).join('/');
        if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error(`Stateful decoder module ${file} is outside the build root`);
        if (modules.has(path)) continue;
        let bytes: Buffer;
        try {bytes = await readFile(file);} catch {throw new Error(`Stateful decoder module ${path} is missing`);}
        modules.set(path, sha(bytes));
        for (const specifier of statefulDecoderSpecifiers(bytes.toString('utf8'), path)) {
            if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
            else if (specifier.startsWith('node:') || builtins.has(specifier) || builtins.has(packageName(specifier))) continue;
            else if (specifier.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) throw new Error(`Stateful decoder module ${path} imports ${specifier} by location`);
            else imported.add(packageName(specifier));
        }
    }
    const packages: {name: string; version: string; members: number; sha256: string}[] = [];
    for (const name of [...new Set([...imported, ...pinned])].sort()) {
        const packageRoot = await resolvePackage(name);
        if (!packageRoot) {
            if (!imported.has(name)) continue;
            throw new Error(`Stateful decoder package ${name} cannot be resolved`);
        }
        const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
        if (manifest.name !== name) throw new Error(`Stateful decoder package ${name} resolved to ${manifest.name}`);
        const members = await artifactTree(packageRoot);
        packages.push({name, version: String(manifest.version), members: members.length, sha256: sha(actionHistoryImmutableJson(members))});
    }
    const moduleList = [...modules].map(([path, digest]) => ({path, sha256: digest})).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return Object.freeze({schemaVersion: 1 as const, modules: Object.freeze(moduleList), packages: Object.freeze(packages),
        sha256: sha(actionHistoryImmutableJson({kind: 'hyperion-stateful-decoder-v1', modules: moduleList, packages}))});
}

let installed: Promise<StatefulDecoderIdentity> | undefined;
/** The installed build's decoder identity, computed once per process. */
export function installedStatefulDecoderIdentity(): Promise<StatefulDecoderIdentity> {
    installed ??= statefulDecoderIdentity().catch(error => {installed = undefined; throw error;});
    return installed;
}
