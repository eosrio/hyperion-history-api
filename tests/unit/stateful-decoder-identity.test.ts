import {afterEach, describe, expect, it} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {STATEFUL_DECODER_ENTRY_MODULES, statefulDecoderIdentity, statefulDecoderSpecifiers}
    from '../../src/indexer/projection/stateful-decoder-identity.js';

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'decoder-identity-')); roots.push(root);
    const write = (path: string, text: string) => {mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), text);};
    write('build/a/entry.js', [
        "import { createHash } from 'node:crypto';",
        "import fs from 'fs';",
        "import {",
        "    helper,",
        "    other",
        "} from './dep.js';",
        "import { value } from 'pkg-one/sub';",
        "import './side.js';",
        "export * from './re.js';",
        "/**",
        " * Loaded lazily, e.g. import(name) in a doc comment does not count.",
        " */",
        "// import(alsoIgnored)",
        "export async function load() { return import('./lazy.js'); }",
        ''].join('\n'));
    for (const name of ['dep', 'side', 're', 'lazy']) write(`build/a/${name}.js`, `export const ${name} = 1;\n`);
    write('build/unrelated.js', 'export const unrelated = 1;\n');
    write('packages/pkg-one/package.json', JSON.stringify({name: 'pkg-one', version: '1.2.3'}));
    write('packages/pkg-one/sub.js', 'export const value = 1;\n');
    write('packages/pinned-present/package.json', JSON.stringify({name: 'pinned-present', version: '9.0.0'}));
    write('packages/pinned-present/index.js', 'export {};\n');
    const options = {executableRoot: join(root, 'build'), entries: ['a/entry.js'], pinnedPackages: ['pinned-present', 'pinned-absent'],
        resolvePackageRoot: async (name: string) => existsSync(join(root, 'packages', name)) ? join(root, 'packages', name) : undefined};
    return {root, write, options};
}

describe('stateful decoder identity', () => {
    it('reads static, re-export, side-effect and literal dynamic specifiers, ignoring comments', () => {
        const text = "import {\n a\n} from './a.js';\nexport * as ns from \"pkg\";\nimport 'side';\n// import(x)\n * import(y)\nconst m = await import( './lazy.js' );\n";
        expect(statefulDecoderSpecifiers(text).sort()).toEqual(['./a.js', './lazy.js', 'pkg', 'side']);
        expect(() => statefulDecoderSpecifiers("const m = await import(name);\n", 'x.js')).toThrow('x.js has a computed dynamic import');
        expect(() => statefulDecoderSpecifiers('const m = await import(`./${name}.js`);\n')).toThrow('computed dynamic import');
    });

    it('covers the import closure and the packages it uses, skipping builtins and absent pinned packages', async () => {
        const {options} = fixture(), identity = await statefulDecoderIdentity(options);
        expect(identity.modules.map(module => module.path)).toEqual(['a/dep.js', 'a/entry.js', 'a/lazy.js', 'a/re.js', 'a/side.js']);
        expect(identity.packages.map(({name, version, members}) => ({name, version, members})))
            .toEqual([{name: 'pinned-present', version: '9.0.0', members: 2}, {name: 'pkg-one', version: '1.2.3', members: 2}]);
        expect(identity.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes only when the decoder closure or its packages change', async () => {
        const {write, options} = fixture(), base = (await statefulDecoderIdentity(options)).sha256;
        write('build/unrelated.js', 'export const unrelated = 2;\n');
        expect((await statefulDecoderIdentity(options)).sha256).toBe(base);
        write('build/a/lazy.js', 'export const lazy = 2;\n');
        const module = (await statefulDecoderIdentity(options)).sha256;
        expect(module).not.toBe(base);
        write('packages/pkg-one/sub.js', 'export const value = 2;\n');
        expect((await statefulDecoderIdentity(options)).sha256).not.toBe(module);
    });

    it('fails closed on anything the closure cannot pin', async () => {
        const missing = fixture();
        missing.write('build/a/dep.js', "import './gone.js';\n");
        await expect(statefulDecoderIdentity(missing.options)).rejects.toThrow('Stateful decoder module a/gone.js is missing');
        const outside = fixture();
        outside.write('build/a/dep.js', "import '../../packages/pkg-one/sub.js';\n");
        await expect(statefulDecoderIdentity(outside.options)).rejects.toThrow('is outside the build root');
        const unresolved = fixture();
        unresolved.write('build/a/dep.js', "import x from 'not-installed';\n");
        await expect(statefulDecoderIdentity(unresolved.options)).rejects.toThrow('Stateful decoder package not-installed cannot be resolved');
        const computed = fixture();
        computed.write('build/a/dep.js', 'export const load = name => import(name);\n');
        await expect(statefulDecoderIdentity(computed.options)).rejects.toThrow('a/dep.js has a computed dynamic import');
        const located = fixture();
        located.write('build/a/dep.js', "import 'file:///etc/x.js';\n");
        await expect(statefulDecoderIdentity(located.options)).rejects.toThrow('imports file:///etc/x.js by location');
    });

    const build = fileURLToPath(new URL('../../build/', import.meta.url));
    it.skipIf(!existsSync(join(build, STATEFUL_DECODER_ENTRY_MODULES[0])))('resolves the real build closure without API, worker or CLI modules', async () => {
        const identity = await statefulDecoderIdentity({executableRoot: build});
        const paths = identity.modules.map(module => module.path);
        for (const entry of STATEFUL_DECODER_ENTRY_MODULES) expect(paths).toContain(entry);
        expect(paths.filter(path => /^(?:api|cli)\/|^indexer\/(?:workers|modules)\//.test(path))).toEqual([]);
        expect(identity.packages.map(item => item.name)).toContain('@eosrio/hyperion-sdk');
    });
});
