/** Builtin Antelope capability controls; constructed trace/row cases grant no source authority. */
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {registerHooks} from 'node:module';

const mode = process.argv[2]; assert(['components', 'facts', 'source-mode', 'master-source'].includes(mode));
assert(!process.versions.bun && [24, 26].includes(Number(process.versions.node.split('.')[0])));
registerHooks({resolve(specifier, context, next) {
    assert(!specifier.includes('hyperion-wire-plugin'), 'Builtin source evidence must not import Wire');
    return next(specifier, context);
}});
const directory = mkdtempSync(join(tmpdir(), 'hyperion-antelope-source-capability-')), previous = process.cwd(), config = process.env.CONFIG_JSON;
try {
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'antelope-source-capability'}, indexer: {}}));
    writeFileSync(join(directory, 'config/connections.json'), '{}');
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    const {loadChainProtocol} = await import('../../build/indexer/protocol/selection.js');
    const selected = await loadChainProtocol(undefined, {sourceEvidence: true});
    assert.equal(selected.id, 'antelope'); assert.equal(selected.provider.profileId, 'antelope-default-v1');
    if (mode === 'components') {
        assert(selected.components?.length > 0, 'Builtin source profile requires actual installed component identity');
        const {installedRuntimeArtifacts} = await import('../../build/indexer/helpers/runtime-artifacts.js');
        const actual = await installedRuntimeArtifacts(true);
        assert.deepEqual(selected.components, [{id: 'hyperion-antelope-runtime', runtime: 'node',
            version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version,
            sourceRevision: actual.codeRevision, sha256: actual.executableSha256}]);
        assert(Object.isFrozen(selected.components)); assert(Object.isFrozen(selected.components[0]));
        assert.equal((await loadChainProtocol()).components, undefined, 'Classic selection must retain its existing default');
        await assert.rejects(loadChainProtocol({provider: 'antelope', components: selected.components}), /Invalid Antelope protocol configuration/);
    } else if (mode === 'source-mode') {
        const {HyperionWorker} = await import('../../build/indexer/workers/hyperionWorker.js');
        const worker = (id, admission, live) => {
            const value = Object.assign(Object.create(HyperionWorker.prototype), {protocolId: id,
                protocol: {profileId: id === 'antelope' ? 'antelope-default-v1' : 'wire-engineering'}, conf: {indexer: {live_reader: live}}});
            Object.defineProperty(value, 'actionSourceAdmissionEnabled', {get: () => admission}); return value;
        };
        assert.equal(worker('antelope', false, true).usesProtocolSourceBindings, false);
        assert.equal(worker('antelope', true, false).usesProtocolSourceBindings, false);
        const active = worker('antelope', true, true);
        assert.equal(active.usesProtocolSourceBindings, true);
        active.conf.indexer.live_reader = false;
        assert.equal(active.usesProtocolSourceBindings, true, 'Live source mode is fixed until a controlled worker restart');
        assert.equal(worker('wire', false, false).usesProtocolSourceBindings, true);
        assert.equal(active.usesExtensionProtocol, false, 'Shared source lifecycle must not select extension decoding');
    } else if (mode === 'master-source') {
        const [{HyperionMaster}, {frontierMemoryClient}] = await Promise.all([
            import('../../build/indexer/modules/master.js'), import('./protocol-frontier-memory.mjs')]);
        for (const [enabled, live] of [[false, true], [true, false], [true, true]]) {
            const memory = frontierMemoryClient(1), chain = 'antelope-source-capability', chainId = 'a'.repeat(64);
            const master = Object.assign(Object.create(HyperionMaster.prototype), {engineering: {exactActionSequenceStorage: enabled},
                chain, conf: {settings: {es_replicas: 1}, indexer: {live_reader: live}}, esClient: memory.client,
                manager: {conn: {chains: {[chain]: {chain_id: chainId}}}}});
            try {
                await master.initializeProtocolAbiCoordinator();
                if (enabled && live) {
                    assert(master.protocolAbiCoordinator, 'Engineering live Antelope must initialize its original coordinator');
                    assert.deepEqual(master.protocolAbiCoordinator.options.profile,
                        {id: selected.id, profileId: selected.provider.profileId, components: selected.components});
                    assert.equal(master.protocolAbiCoordinator.options.nativeActionInterfaceVersion, undefined);
                } else assert.equal(master.protocolAbiCoordinator, undefined, 'Default/bulk master must not acquire live source ownership');
            } finally {clearInterval(master.protocolAbiDrainTimer);}
        }
    } else {
        assert.equal(typeof selected.provider.observeBlockAbi, 'function', 'Builtin provider has no ABI observation hook');
        const fixture = JSON.parse(readFileSync(new URL('../fixtures/antelope-worker/source.json', import.meta.url)));
        const schema = JSON.parse(readFileSync(new URL('../fixtures/antelope-worker/ship.abi.json', import.meta.url)));
        const session = selected.provider.createShipSession(schema);
        try {
            const res = session.decodeResult(Buffer.from(fixture.frames.handoff.hex, 'hex'))[1];
            const traces = session.decodeTraces(Buffer.from(res.traces, 'hex')); assert(Array.isArray(traces));
            const source = Object.fromEntries(['chainId', 'blockNum', 'blockId', 'previousBlockId'].map(key => [key, fixture.source[key]]));
            const observe = input => selected.provider.observeBlockAbi(input, source);
            const facts = observe({traces, accountRows: []});
            assert.deepEqual(facts, {schemaVersion: 1, actionInputs: [{transactionId: fixture.source.transactionId,
                actionOrdinal: 1, receiver: 'counter', account: 'counter', name: 'setvalue', rawHex: fixture.contract.actionHex,
                globalSequence: '9007199254740995', receiptAbiSequence: '3', inputActionOrdinal: 1}], deployments: [], finalStates: []});
            const grouped = structuredClone(traces), first = grouped[0][1].action_traces[0];
            const notification = structuredClone(first), inline = structuredClone(first);
            notification[1].action_ordinal = 2; notification[1].creator_action_ordinal = 1; notification[1].receiver = 'alice';
            notification[1].receipt[1].receiver = 'alice'; notification[1].receipt[1].global_sequence = '9007199254740996';
            inline[1].action_ordinal = 3; inline[1].creator_action_ordinal = 1; inline[1].receipt[1].global_sequence = '9007199254740997';
            grouped[0][1].action_traces = [inline, notification, first];
            assert.deepEqual(observe({traces: grouped, accountRows: []}).actionInputs.map(x => [x.actionOrdinal, x.inputActionOrdinal]), [[1, 1], [2, 1], [3, 3]]);
            const wrong = structuredClone(grouped); wrong[0][1].action_traces[1][1].act.data = 'ff';
            assert.throws(() => observe({traces: wrong, accountRows: []}), /Notification/);
            const nameBytes = text => {
                const alphabet = '.12345abcdefghijklmnopqrstuvwxyz'; let value = 0n;
                for (let index = 0; index < 12; index++) value = (value << 5n) | BigInt(index < text.length ? alphabet.indexOf(text[index]) : 0);
                const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value << 4n); return bytes;
            };
            const native = structuredClone(traces), action = native[0][1].action_traces[0][1];
            action.receiver = action.receipt[1].receiver = action.act.account = 'eosio'; action.act.name = 'setabi';
            // Independent native name/vector bytes: noncanonical length one and ignored trailing data.
            action.act.data = Buffer.concat([nameBytes('counter'), Buffer.from('8100ffdead', 'hex')]).toString('hex');
            assert.deepEqual(observe({traces: native, accountRows: []}).deployments, [{account: 'counter', abiHex: 'ff',
                action: {transactionId: fixture.source.transactionId, actionOrdinal: 1}, globalSequence: '9007199254740995', effect: 'native-before-receipt'}]);
            for (const prefix of ['8180808080', '8180808010']) {
                action.act.data = Buffer.concat([nameBytes('counter'), Buffer.from(prefix + 'ffdead', 'hex')]).toString('hex');
                assert.equal(observe({traces: native, accountRows: []}).deployments[0].abiHex, 'ff', 'Leap consumes at most five prefix bytes and retains low uint32 bits');
            }
            for (const truncated of ['80', '8100', '81808080']) {
                action.act.data = Buffer.concat([nameBytes('counter'), Buffer.from(truncated, 'hex')]).toString('hex');
                assert.throws(() => observe({traces: native, accountRows: []}), /Truncated/);
            }
            action.act.data = Buffer.concat([nameBytes('counter'), Buffer.from('00dead', 'hex')]).toString('hex');
            assert.equal(observe({traces: native, accountRows: []}).deployments[0].abiHex, '');
            const copy = structuredClone(native[0][1].action_traces[0]);
            copy[1].action_ordinal = 2; copy[1].creator_action_ordinal = 1;
            copy[1].receiver = copy[1].receipt[1].receiver = 'alice'; copy[1].receipt[1].global_sequence = '9007199254740996';
            native[0][1].action_traces.push(copy);
            assert.equal(observe({traces: native, accountRows: []}).deployments.length, 1, 'Notifications cannot redeploy a native ABI');
            for (const mutate of [
                value => {value[0][1].except = {message: 'failed'};},
                value => {value[0][1].action_traces[0][1].receipt[1].global_sequence = 9007199254740995;},
                value => {value[0][1].action_traces[0][1].receipt[1].abi_sequence = 4294967296;},
                value => {value[0][1].action_traces[0][1].receipt[1].receiver = 'alice';},
                value => {value[0][1].action_traces[0][1].creator_action_ordinal = 1;},
                value => {value[0][1].action_traces[0][1].context_free = true;}
            ]) {const invalid = structuredClone(native); mutate(invalid); assert.throws(() => observe({traces: invalid, accountRows: []}));}
            const row = {ordinal: 7, present: false, raw: Buffer.concat([Buffer.from([0]), nameBytes('counter'), Buffer.alloc(4), Buffer.from('01ff', 'hex')]),
                value: ['account_v0', {name: 'counter', creation_date: '2000-01-01T00:00:00.000', abi: 'ff'}]};
            assert.deepEqual(observe({traces: [], accountRows: [row]}).finalStates, [{account: 'counter', present: false, abiHex: 'ff', deltaOrdinal: 7}]);
            const badRow = {...row, value: ['account_v0', {...row.value[1], abi: 'fe'}]};
            assert.throws(() => observe({traces: [], accountRows: [badRow]}), /raw bytes/);
            for (const input of [{accountRows: []}, {traces: []}, {traces: null, accountRows: []}])
                assert.throws(() => observe(input), /Missing/);
            assert.deepEqual(observe({traces: [], accountRows: []}), {schemaVersion: 1, actionInputs: [], deployments: [], finalStates: []});
            let accessed = false; const evil = {accountRows: []}; Object.defineProperty(evil, 'traces', {enumerable: true, get() {accessed = true; return [];}});
            assert.throws(() => observe(evil)); assert.equal(accessed, false);
        } finally {session.close();}
    }
    console.log(JSON.stringify({passed: true, mode, runtime: process.version, builtinAntelope: true,
        constructedControls: true, sourceAuthority: false, capacityAuthority: false, releaseQualified: false}));
} finally {
    process.chdir(previous); if (config === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = config;
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, {recursive: true, force: true});
}
