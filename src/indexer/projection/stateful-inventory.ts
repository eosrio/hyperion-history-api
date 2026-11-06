import {createHash} from 'node:crypto';
import * as modules from 'node:module';
import {readFile, readdir, realpath} from 'node:fs/promises';
import {dirname, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

/** Code identity only, never source, completeness or serving authority. */
export async function statefulHookInventory(entrypoint: string): Promise<string> {
    if (typeof modules.findPackageJSON !== 'function') throw new Error('Stateful hook inventory requires the qualified native Node runtime');
    const entry = await realpath(entrypoint), packageFile = modules.findPackageJSON(pathToFileURL(entry));
    if (!packageFile) throw new Error('Stateful plugin has no installed package metadata');
    const packages = new Map<string, {name: string; version: string; files: Array<{path: string; sha256: string}>; dependencies: Array<{name: string; identity: string}>}>();
    let bytes = 0, members = 0;
    const visit = async (metadataPath: string): Promise<string> => {
        const metadata = await realpath(metadataPath), root = dirname(metadata);
        if (packages.has(root)) return root;
        const pkg = JSON.parse(await readFile(metadata, 'utf8'));
        if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new Error('Stateful dependency identity is incomplete');
        const node = {name: pkg.name, version: pkg.version, files: [] as Array<{path: string; sha256: string}>, dependencies: [] as Array<{name: string; identity: string}>};
        packages.set(root, node);
        const walk = async (directory: string) => {
            for (const file of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
                if (file.name === 'node_modules' || file.name === '.git') continue;
                const path = resolve(directory, file.name);
                if (file.isSymbolicLink()) throw new Error('Stateful executable inventory contains an unpinned symbolic link');
                if (file.isDirectory()) {await walk(path); continue;}
                if (!file.isFile() || !/\.(?:js|cjs|mjs|json|node|wasm|abi)$/.test(file.name)) continue;
                const content = await readFile(path); bytes += content.length;
                if (++members > 10_000 || bytes > 512 * 1024 * 1024) throw new Error('Stateful hook inventory exceeds the existing startup inventory budget');
                node.files.push({path: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(content).digest('hex')});
            }
        };
        await walk(root);
        const dependencies = {...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies};
        for (const name of Object.keys(dependencies).sort()) {
            let dependency: string | undefined;
            try {dependency = modules.findPackageJSON(name, pathToFileURL(metadata));}
            catch (error) {
                if (Object.hasOwn(pkg.optionalDependencies ?? {}, name) || pkg.peerDependenciesMeta?.[name]?.optional === true) continue;
                throw error;
            }
            if (!dependency) throw new Error('Stateful dependency is not installed: ' + name);
            node.dependencies.push({name, identity: await visit(dependency)});
        }
        return root;
    };
    const root = await visit(packageFile);
    // Paths are addressable locally but excluded from the portable artifact digest.
    const identities = new Map([...packages.keys()].map((path, index) => [path, index]));
    const graph = [...packages.values()].map(node => ({...node,
        dependencies: node.dependencies.map(edge => ({name: edge.name, identity: identities.get(edge.identity)}))}));
    const entryRelative = relative(root, entry).replaceAll('\\', '/');
    if (!packages.get(root)!.files.some(file => file.path === entryRelative)) throw new Error('Stateful entrypoint is outside its executable inventory');
    return createHash('sha256').update(protocolImmutableJson(['hyperion-stateful-hook-inventory-v2', entryRelative, graph])).digest('hex');
}
