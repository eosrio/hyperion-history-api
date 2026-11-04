import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join, dirname, basename} from 'node:path';
import {prepared} from './portable-state-source-fixture.mjs';
import {statefulHostFixture} from './stateful-host-fixture.mjs';
import {limits} from '../../packages/backend-mongodb/tests/stateful-fixture.mjs';
import {PROJECTION_ID} from '../fixtures/wire-managed-state-v2/plugin/build/index.js';
import {admitCoordinatedNativeSourceOptions, STATEFUL_SDK49_SOURCE_PROFILE} from './stateful-engineering-source-admission.mjs';

// The historical runtime is qualified here only in this exact, independently installed SDK graph.
admitCoordinatedNativeSourceOptions({engineeringSourceProfile: STATEFUL_SDK49_SOURCE_PROFILE});

const load = path => import(new URL('../../build/indexer/protocol/' + path, import.meta.url));
const {ProtocolAbiCoordinator} = await load('abi-coordinator.js');
const {ProtocolAbiProofReader, protocolAbiCertificateForControl} = await load('abi-proof.js');
const {historicalAddressIdentity, historicalRootCertificate, resolveProtocolAbiHistory} = await load('abi-history.js');
const history = () => ({interfaceVersion: 1, maxCommitsPerDrain: 2, maxCommitBytesPerDrain: 1048576, maxMillisecondsPerDrain: 1000});
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(join(root, 'out'), {recursive: true});
const parent = realpathSync(join(root, 'out')), owned = mkdtempSync(join(parent, 'wire-history-'));
const destination = join(owned, 'verified'), fixture = join(root, 'tests/fixtures/portable-state-worker');
const preparedBytes = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
    [join(fixture, 'prepare.py'), destination], {encoding: 'utf8', timeout: 30000, windowsHide: true}));
assert.equal(preparedBytes.archiveSha256, '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json')));
const read = path => {
    const expected = manifest.members.find(row => row.path === 'source/' + path), bytes = readFileSync(join(destination, 'source', path));
    assert.equal(bytes.length, expected.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256); return bytes;
};
const frames = Array.from({length: 8}, (_, n) => read('block-' + String(n + 1).padStart(6, '0') + '.bin'));
const retained = {frames, schemaJson: read('schema.json').toString(),
    capture: {chainId: manifest.source.chainId, profileId: 'wire-sysio-6508c9e8-native-engineering-v1'}};
after(() => {assert.equal(dirname(owned), parent); assert.ok(basename(owned).startsWith('wire-history-')); rmSync(owned, {recursive: true, force: true});});
const setup = (extra = {}) => prepared({}, 4, undefined, {...retained, historicalCertificates: history(), maxAncestryBlocks: 1, ...extra});
const reader = p => new ProtocolAbiProofReader({chainId: p.options.chainId, profile: p.options.profile,
    store: p.store.asReadOnly(), maxAncestryBlocks: 1, historicalCertificates: true});
const unavailable = error => ['historical_source_unavailable', 'certificate_unavailable', 'authority_changed',
    'authority_unavailable', 'projection_source_unavailable', 'proof_cancelled', 'invalid_proof', 'retained_data_unavailable'].includes(error.code);

async function reopen(p, newOwner, budget = history()) {
    const before = await p.coordinator.inspect(), commit = await p.store.readCommit(before.head.commitId);
    const coordinator = newOwner ? new ProtocolAbiCoordinator({chainId: p.options.chainId, profile: p.options.profile,
        ownerId: newOwner, store: p.store, bindings: p.bindings, observations: p.observations,
        verifyNativeGenesis: p.options.provider.verifyNativeGenesis?.bind(p.options.provider), historicalCertificates: budget}) : p.coordinator;
    if (newOwner) await coordinator.start();
    const session = 'history-reopen-' + (newOwner ?? 'same-owner');
    const opened = await coordinator.openSource(p.contextId, session);
    const frame = frames[before.head.blockNum], schemaJson = retained.schemaJson;
    const ship = p.options.provider.createShipSession(JSON.parse(schemaJson));
    const decoded = ship.decodeResult(frame)[1];
    const source = {chainId: p.options.chainId, blockNum: decoded.this_block.block_num,
        blockId: decoded.this_block.block_id, previousBlockId: decoded.prev_block.block_id};
    const {protocolAbiCaptureDigest} = await load('abi-observation-store.js');
    const sections = {kind:'unattested-ship-result-sections-v1',schemaJson,
        blockHex:decoded.block,tracesHex:decoded.traces,deltasHex:decoded.deltas};
    const captureSha256 = protocolAbiCaptureDigest(source, sections);
    const selected = await p.bindings.prepareSelection({schemaVersion:1,contextId:p.contextId,readerSessionId:session,
        readerRole:'live',assignmentId:null,source,frameSha256:createHash('sha256').update(frame).digest('hex'),captureSha256,
        head:{blockNum:decoded.head.block_num,blockId:decoded.head.block_id},
        irreversible:{blockNum:decoded.last_irreversible.block_num,blockId:decoded.last_irreversible.block_id}});
    let observation;
    try {
        const accountRows = []; let ordinal = 0;
        for (const [, delta] of ship.decodeDeltas(Buffer.from(decoded.deltas,'hex'))) for (const row of delta.rows) {
            if (delta.name === 'account') {
                const raw = Buffer.from(row.data,'hex'); accountRows.push({ordinal,present:row.present===1,raw,value:ship.decodeRow('account',raw)});
            }
            ordinal++;
        }
        observation = {status:'observed',facts:p.options.provider.observeBlockAbi({
            traces:ship.decodeTraces(Buffer.from(decoded.traces,'hex')),accountRows},source)};
    } finally {ship.close?.();}
    const original = await p.observations.prepare({schemaVersion:1,protocol:p.options.profile,
        source:{...source,inputSha256:captureSha256},capture:sections,observation});
    await p.bindings.prepareObservationLink({schemaVersion: 1, selectionId: selected.id,
        observationId: original.id, observationDigest:original.digest});
    assert.equal((await coordinator.admit(selected.id, opened.generation)).status, 'accepted'); await coordinator.drain();
    return coordinator;
}

test('opt-in exact historical lookup opens original genesis with bounded GETs and no search', async () => {
    const p = await setup(); p.memory.calls.length = 0;
    const proof = await p.source.open(p.positions[0]);
    assert.equal(proof.source.blockNum, 1);
    assert.equal(p.memory.calls.some(call => call.method === 'search'), false);
    assert.ok(p.memory.calls.length < 2048, 'Fixed pointer/root/authority reads must stay bounded');
    const packet = await p.source.originalBlock(1, async target => assert.equal(target.block.blockNum, 1));
    assert.equal(packet.observation.observation.status, 'native-genesis');
    assert.equal(packet.observation.capture.tracesHex, null);
    await p.source.revalidate(proof);
});

test('default opening keeps the narrow window and a prepared locator cannot activate historical coverage', async () => {
    const p = await prepared({}, 4, undefined, {maxAncestryBlocks: 1});
    await assert.rejects(p.source.open(p.positions[0]), error => error.code === 'ancestry_unavailable');
    const control = await p.coordinator.inspect();
    assert.equal(control.historical, undefined);
    assert.equal(p.memory.calls.some(call=>call.request.id?.startsWith('h45abihist1:')),false);
    const oldCertificate=protocolAbiCertificateForControl(control);
    assert.deepEqual(await p.store.readCertificate(p.store.certificateId(oldCertificate)),oldCertificate);
    assert.equal(Object.hasOwn(oldCertificate,'historical'),false,'Existing settled certificate bytes keep their original shape');
    let commit = await p.store.readCommit(control.head.commitId), id = control.head.commitId;
    while (commit.source.blockNum !== 1) {id = commit.previousCommitId; commit = await p.store.readCommit(id);}
    const head = {blockNum: 1, blockId: commit.source.blockId, commitId: id, stateRootId: commit.stateRootId,
        lastGlobalSequence: commit.lastGlobalSequence, coverageStart: commit.coverageStart};
    const value = protocolAbiCertificateForControl({...control, head});
    await p.store.prepareCertificate(value); await p.store.prepareHistoricalCertificateAddress(value);
    await assert.rejects(reader(p).openHistorical(1), unavailable);
    assert.equal((await p.coordinator.inspect()).historical, undefined);
});

for (const owner of [null, 'replacement-history-owner']) test('rotation refuses stale anchors and re-walks under ' + (owner ?? 'same owner/new generation'), async () => {
    const p = await setup(), old = await p.source.open(p.positions[0]);
    const before = await p.coordinator.inspect(), coordinator = await reopen(p, owner);
    const after = await coordinator.inspect();
    assert.notEqual(after.generation, before.generation);
    if (owner) assert.notEqual(after.ownerId, before.ownerId);
    await assert.rejects(p.source.revalidate(old), unavailable);
    const current = reader(p);
    await assert.rejects(current.openHistorical(1), unavailable);
    await coordinator.drain(); await coordinator.drain();
    assert.equal((await current.openHistorical(1)).source.blockId, p.positions[0].blockId);
});

test('crash/replacement discards walk progress and cannot adopt a prior generation root', async () => {
    const p = await setup();
    const first = await reopen(p, 'first-crash-owner');
    const partial = await first.inspect();
    const second = new ProtocolAbiCoordinator({chainId: p.options.chainId, profile: p.options.profile,
        ownerId: 'second-crash-owner', store: p.store, bindings: p.bindings, observations: p.observations,
        historicalCertificates: history(), verifyNativeGenesis: p.options.provider.verifyNativeGenesis?.bind(p.options.provider)});
    await second.start();
    assert.equal((await second.inspect()).historical, undefined);
    await assert.rejects(reader(p).openHistorical(1), unavailable);
    assert.equal(partial.head.blockNum, 5);
});

test('corrupt locator or unactivated root certificate never grants an old source', async () => {
    const p = await setup(), control = await p.coordinator.inspect();
    const current = protocolAbiCertificateForControl(control), identity = historicalAddressIdentity(current, 1);
    const address = await p.store.readHistoricalCertificateAddress(identity);
    const bad = historicalRootCertificate(current, control.historical.addressRootId);
    await p.store.prepareCertificate({...bad, addressRootId: 'h45abiroot1:' + 'f'.repeat(64)});
    assert.equal((await reader(p).openHistorical(1)).source.blockNum, 1, 'Unselected prepared authority must have no effect');
    p.memory.faults.read = (response, request) => request.id.startsWith('h45abihist1:')
        ? {...response, _source: {...response._source, digest: '0'.repeat(64)}} : response;
    await assert.rejects(reader(p).openHistorical(1), unavailable);
    delete p.memory.faults.read;
    assert.equal((await p.store.readHistoricalCertificateAddress(identity)).certificateId, address.certificateId);
});

test('cancellation and late owner change during exact reads refuse before historical proof issuance', async () => {
    for (const mode of ['cancel', 'owner']) {
        const p = await setup(), abort = new AbortController(); let fired = false;
        p.memory.faults.beforeRead = async request => {
            if (!fired && request.id.startsWith('h45abihist1:')) {
                fired = true; delete p.memory.faults.beforeRead;
                if (mode === 'cancel') abort.abort();
                else {
                    const replacement = new ProtocolAbiCoordinator({chainId: p.options.chainId, profile: p.options.profile,
                        ownerId: 'late-owner', store: p.store, bindings: p.bindings, observations: p.observations});
                    await replacement.start();
                }
            }
        };
        await assert.rejects(reader(p).openHistorical(1, {signal: abort.signal}), unavailable);
        assert.equal(fired, true);
    }
});

test('unknown address acknowledgments fence history only and repair through normal settled preparation', async () => {
    const p = await prepared({}, 0, undefined, {historicalCertificates: history(), maxAncestryBlocks: 1});
    p.memory.faults.receipt = (result, request) => request.id.startsWith('h45abihist1:')
        ? {...result, _shards: {total: 1, successful: 0, failed: 1}} : result;
    await p.advance(4);
    assert.equal((await p.source.head()).blockNum, 4, 'Ordinary source/history must keep progressing');
    await assert.rejects(reader(p).openHistorical(1), unavailable);
    delete p.memory.faults.receipt;
    for (let i = 0; i < 6; i++) await p.coordinator.drain();
    assert.equal((await reader(p).openHistorical(1)).source.blockNum, 1);
});

test('historical work uses explicit count/byte budgets and does not enlarge recent ancestry', async () => {
    assert.throws(() => resolveProtocolAbiHistory({...history(), maxCommitsPerDrain: 257}));
    assert.throws(() => resolveProtocolAbiHistory({...history(), maxMillisecondsPerDrain: 30001}));
    const p = await setup();
    const coordinator = await reopen(p, 'bounded-walk-owner');
    const original = p.store.readCommit.bind(p.store), cas=p.store.compareAndSet.bind(p.store); let reads=0,activations=0;
    p.store.readCommit = async (...args) => {reads++; return original(...args);};
    p.store.compareAndSet=async (previous,next)=>{
        if(previous?.value?.historical?.addressRootId!==next.historical?.addressRootId)activations++;
        return cas(previous,next);
    };
    await coordinator.drain(); assert.ok(reads <= 2, 'Each historical work unit must keep its configured2-commit bound');
    assert.ok(activations<=1,'A bounded drain publishes at most one new selected address root');
    assert.throws(() => resolveProtocolAbiHistory({...history(), maxCommitBytesPerDrain: 1023}));
});

test('unknown activation CAS cannot turn a primary-visible root into settled history authority', async () => {
    const p = await prepared({}, 0, undefined, {...retained, historicalCertificates: history(), maxAncestryBlocks: 1});
    let refused = false;
    p.memory.faults.receipt = (result, request) => {
        if (!refused && request.id === 'control' && request.document?.payload
            && JSON.parse(Buffer.from(request.document.payload, 'base64')).historical) {
            refused = true; return {...result, _shards: {total: 1, successful: 0, failed: 1}};
        }
        return result;
    };
    await p.advance(1); assert.equal(refused, true);
    assert.equal((await p.source.head()).blockNum, 1);
    await assert.rejects(reader(p).openHistorical(1), unavailable);
    delete p.memory.faults.receipt;
    await p.coordinator.drain();
    assert.equal((await reader(p).openHistorical(1)).source.blockNum, 1);
});

test('fork admission rotates generation and clears historical activation before replacement input is available', async () => {
    const p = await setup(), old = await p.source.open(p.positions[0]), before = await p.coordinator.inspect();
    const commit = await p.store.readCommit(before.head.commitId), {selection} = await p.bindings.readSelection(commit.selectionId);
    const replacement = await p.bindings.prepareSelection({...selection,
        source: {...selection.source, blockId: 'f'.repeat(64)}});
    await p.coordinator.admit(replacement.id, before.generation);
    const fenced = await p.coordinator.inspect();
    assert.notEqual(fenced.generation, before.generation);
    assert.equal(fenced.historical, undefined);
    await assert.rejects(p.source.revalidate(old), unavailable);
    await assert.rejects(reader(p).openHistorical(1), unavailable);
});

test('byte budget counts the actual original commits and a late work deadline cannot advance the historical walk', async () => {
    const p = await setup(), budget = {...history(), maxCommitBytesPerDrain: 1024};
    const coordinator = await reopen(p, 'byte-limited-owner', budget);
    const control = await coordinator.inspect(), sizes = new Map();
    let id = control.head.commitId;
    while (id) {const value = await p.store.readCommit(id); sizes.set(id, Buffer.byteLength(JSON.stringify(value))); id = value.previousCommitId;}
    const prepare = p.store.prepareCertificate.bind(p.store); let processed = 0;
    p.store.prepareCertificate = async value => {
        if (value.kind === 'settled-abi-head') processed += sizes.get(value.head.commitId) ?? 0;
        return prepare(value);
    };
    await coordinator.drain();
    assert.ok(processed <= budget.maxCommitBytesPerDrain);
    assert.equal((await coordinator.inspect()).head.blockNum, 5);

    const q = await setup(), timed = await reopen(q, 'deadline-owner');
    const originalRead = q.store.readCommit.bind(q.store); let now = 0;
    const clock = mock.method(performance, 'now', () => now);
    q.store.readCommit = async (...args) => {const value = await originalRead(...args); now = 2000; return value;};
    try {await timed.drain();} finally {clock.mock.restore(); q.store.readCommit = originalRead;}
    await assert.rejects(reader(q).openHistorical(1), unavailable);
    await timed.drain(); await timed.drain();
    assert.equal((await reader(q).openHistorical(1)).source.blockNum, 1);
});

test('queued live admission interrupts background history between awaited reads', async () => {
    const p=await setup(), coordinator=await reopen(p,'live-priority-owner');
    const control=await coordinator.inspect(), tip=await p.store.readCommit(control.head.commitId);
    const readCommit=p.store.readCommit.bind(p.store);let admission,interrupted=false;
    p.store.readCommit=async (...args)=>{
        const commit=await readCommit(...args);
        if(!interrupted) {interrupted=true;admission=coordinator.admit(tip.selectionId,control.generation);}
        return commit;
    };
    await coordinator.drain();assert.equal(interrupted,true);
    assert.equal((await admission).status,'accepted');p.store.readCommit=readCommit;
    await assert.rejects(reader(p).openHistorical(1),unavailable);
    for(let n=0;n<6;n++)await coordinator.drain();
    assert.equal((await reader(p).openHistorical(1)).source.blockNum,1);
    assert.equal((await coordinator.inspect()).head.blockNum,5);
});

test('later forward heads retain historical completed reads without resealing the selected activation', async () => {
    const p=await setup(), r=reader(p), old=await r.openHistorical(1), before=await p.coordinator.inspect();
    const activation=before.historical, prepare=p.store.prepareCertificate.bind(p.store), root=p.store.prepareHistoricalAddressRoot.bind(p.store);
    let rootCertificates=0;
    p.store.prepareCertificate=async value=>{if(value.kind==='settled-historical-abi-address-root')rootCertificates++;return prepare(value);};
    p.store.prepareHistoricalAddressRoot=async()=>{throw new Error('Controlled background map unavailable');};
    await p.advance(5);
    const after=await p.coordinator.inspect();assert.equal(after.head.blockNum,5);assert.deepEqual(after.historical,activation);
    assert.equal(rootCertificates,0,'Forward head keeps the settled activation rather than re-sealing it');
    await r.revalidate(old);assert.equal((await r.openHistorical(1)).source.blockNum,1);
    await p.source.revalidate(await p.source.open(p.positions[0]));
    p.store.prepareHistoricalAddressRoot=root;
    assert.equal(old.source.blockNum,1);
});

test('a same-generation control rewind below the activation anchor cannot serve historical membership', async () => {
    const p=await setup(), r=reader(p), old=await r.openHistorical(1), stored=await p.store.readControl();
    let commit=await p.store.readCommit(stored.value.head.commitId),id=stored.value.head.commitId;
    while(commit.source.blockNum>2){id=commit.previousCommitId;commit=await p.store.readCommit(id);}
    const head={blockNum:2,blockId:commit.source.blockId,commitId:id,stateRootId:commit.stateRootId,
        lastGlobalSequence:commit.lastGlobalSequence,coverageStart:commit.coverageStart};
    await p.store.compareAndSet(stored,{...stored.value,head});
    await assert.rejects(r.revalidate(old),unavailable);
    await assert.rejects(r.openHistorical(1),unavailable);
});

test('live work queued inside the real address-map publication prevents further background store calls', async () => {
    const p=await setup(), coordinator=await reopen(p,'map-publication-priority-owner');
    const before=await coordinator.inspect(), tip=await p.store.readCommit(before.head.commitId);
    const publish=p.store.prepareHistoricalAddressRoot.bind(p.store),read=p.store.readHistoricalCertificateAddress.bind(p.store);
    let inside=false,injected=false,admission,continued=0;
    p.store.prepareHistoricalAddressRoot=async (...args)=>{inside=true;try{return await publish(...args);}finally{inside=false;}};
    p.store.readHistoricalCertificateAddress=async (...args)=>{
        const value=await read(...args);
        if(inside&&!injected){injected=true;const calls=p.memory.calls.length;
            admission=coordinator.admit(tip.selectionId,before.generation);
            // Save the exact boundary after the first real map locator read has completed.
            p.memory.faults.beforeRead=()=>{if(inside&&p.memory.calls.length>calls)continued++;};
            p.memory.faults.beforeWrite=()=>{if(inside&&p.memory.calls.length>calls)continued++;};
        }
        return value;
    };
    await coordinator.drain();assert.equal(injected,true);assert.equal((await admission).status,'accepted');
    delete p.memory.faults.beforeRead;delete p.memory.faults.beforeWrite;
    assert.equal(continued,0,'No further map read/write may begin after queued live input is observed');
    assert.deepEqual((await coordinator.inspect()).historical,before.historical,'Prepared map artifacts cannot activate after interruption');
});

test('deadline expiry inside the real address-map publication prevents further background store calls', async () => {
    const p=await setup(), coordinator=await reopen(p,'map-publication-deadline-owner'),before=await coordinator.inspect();
    const publish=p.store.prepareHistoricalAddressRoot.bind(p.store),read=p.store.readHistoricalCertificateAddress.bind(p.store);
    let inside=false,injected=false,continued=0,now=0;const clock=mock.method(performance,'now',()=>now);
    p.store.prepareHistoricalAddressRoot=async (...args)=>{inside=true;try{return await publish(...args);}finally{inside=false;}};
    p.store.readHistoricalCertificateAddress=async (...args)=>{
        const value=await read(...args);
        if(inside&&!injected){injected=true;now=2000;const calls=p.memory.calls.length;
            p.memory.faults.beforeRead=()=>{if(inside&&p.memory.calls.length>calls)continued++;};
            p.memory.faults.beforeWrite=()=>{if(inside&&p.memory.calls.length>calls)continued++;};
        }
        return value;
    };
    try {await coordinator.drain();}finally{clock.mock.restore();delete p.memory.faults.beforeRead;delete p.memory.faults.beforeWrite;}
    assert.equal(injected,true);assert.equal(continued,0);
    assert.deepEqual((await coordinator.inspect()).historical,before.historical);
});

test('fresh managed owner crosses the unchanged256-block bound using original retained1..258 with absent genesis traces',
    {timeout:120000},async()=>{
    const coldFrames=Array.from({length:258},(_,n)=>read('block-'+String(n+1).padStart(6,'0')+'.bin'));
    const p=await prepared({},258,undefined,{...retained,frames:coldFrames,historicalCertificates:history()});
    assert.equal(p.options.maxAncestryBlocks,undefined,'Use the actual default256 bound');
    const source=await p.source.originalBlock(1,async target=>assert.equal(target.block.blockNum,1));
    assert.equal(source.observation.capture.tracesHex,null);
    let host;
    try {
        host=await statefulHostFixture({preparedSource:p,through:258,timeoutMs:5000,projectionId:PROJECTION_ID,
            pluginDirectory:join(root,'tests/fixtures/wire-managed-state-v2/plugin'),
            pluginConfiguration:{enabled:true,qualificationOnly:true,limits:limits()}});
        assert.equal(host.ownerErrors.length,0,host.ownerErrors.map(error=>error.stack).join('\n'));
        const recovery=await host.native.adapter.recovery();
        assert.equal(recovery.view.checkpoint.blockNum,258);assert.equal(recovery.raw,null);assert.equal(recovery.gap,null);
        assert.ok(host.ends.length>=258&&host.ends.every(end=>end.status==='quiescent'&&end.rootResult==='returned'));
        const response=await host.app.inject('/v2/qualification/wire/attseq/1067/0000000000000000');
        assert.equal(response.statusCode,200,response.body);assert.equal(response.json().row,null);
        assert.equal(response.headers['hyperion-state-block-num'],'258');
    } finally {await host?.close();}
});
