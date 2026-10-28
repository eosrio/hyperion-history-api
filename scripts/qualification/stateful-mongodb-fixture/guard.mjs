import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, lstatSync, statSync, readdirSync, readlinkSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync, opendirSync} from 'node:fs';
import {dirname, join, resolve, isAbsolute, relative, sep} from 'node:path';

export const PHASES = Object.freeze(['a', 'fail-b', 'recover-b', 'fork-c', 'retention']);
export const ADAPTER_HEAD = 'e4a46cfa69f0a0cf7f6ca51847a0efa51da80795';
export const SDK_HEAD = 'b64bac478fc8015d409d44aa6f100668e0e091d2';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const hex = n => n.toString(16).padStart(64, '0');
export const point = (blockNum, blockId = hex(blockNum)) => ({blockNum, blockId});
export const stable = v => v !== null && typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
    : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}') : JSON.stringify(v);
export const priorPhase = phase => PHASES[PHASES.indexOf(phase) - 1] ?? null;
const exact = (v, keys) => assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
const integer = (v, min, max) => assert.ok(Number.isSafeInteger(v) && v >= min && v <= max, 'Explicit fixture bound required');
const digest = v => assert.match(v, /^[0-9a-f]{64}$/);

/** Pure target/shape admission. No filesystem, imports, clients or network activity. */
export function validateManifest(m) {
    exact(m, ['schemaVersion','caseId','caseRoot','databaseName','collectionPrefix','uri','server','owner','runtime','modules','input','bounds','policy','adapterHead','sdkHead']);
    assert.equal(m.schemaVersion, 1); assert.match(m.caseId, /^h45_stateful_[0-9a-f]{12}$/);
    assert.equal(m.caseRoot, '/opt/hapi329/stateful-qualification/' + m.caseId);
    assert.equal(m.databaseName, m.caseId); assert.equal(m.collectionPrefix, 'case_' + m.caseId.slice(-12));
    assert.equal(m.adapterHead, ADAPTER_HEAD); assert.equal(m.sdkHead, SDK_HEAD);
    const u = new URL(m.uri);
    assert.equal(u.protocol, 'mongodb:'); assert.equal(u.hostname, '127.0.0.1');
    assert.equal(u.username + u.password + u.hash, ''); assert.ok(u.pathname === '/' || u.pathname === '');
    integer(Number(u.port), 1024, 65535); assert.ok(u.port !== '27017', 'Refuse conventional/default Mongo endpoint');
    assert.deepEqual([...u.searchParams.keys()].sort(), ['directConnection','replicaSet']);
    assert.equal(u.searchParams.get('directConnection'), 'true');
    exact(m.server, ['replicaSet','replicaSetId','member','version','failpointBaselineCount']);
    assert.match(m.server.replicaSet, /^h45_stateful_[0-9a-f]{12}$/); assert.equal(m.server.replicaSet, m.caseId);
    assert.match(m.server.replicaSetId, /^[0-9a-f]{24}$/); assert.equal(u.searchParams.get('replicaSet'), m.server.replicaSet);
    assert.equal(m.server.member, '127.0.0.1:' + u.port); assert.match(m.server.version, /^\d+\.\d+\.\d+$/);
    integer(m.server.failpointBaselineCount, 0, Number.MAX_SAFE_INTEGER);
    exact(m.owner, ['pid','birthTicks','executable','executableSha256','cmdlineSha256','netNamespace','socketInode']);
    integer(m.owner.pid, 2, 2 ** 31 - 1); assert.match(m.owner.birthTicks, /^\d+$/);
    assert.ok(isAbsolute(m.owner.executable)); digest(m.owner.executableSha256); digest(m.owner.cmdlineSha256);
    assert.match(m.owner.netNamespace, /^net:\[\d+\]$/); assert.match(m.owner.socketInode, /^\d+$/);
    exact(m.runtime, ['version','executableSha256']); assert.ok(['v24.19.0','v26.4.0'].includes(m.runtime.version)); digest(m.runtime.executableSha256);
    exact(m.bounds, ['phaseMS','operationMS','transactionMS','candidateBytes','maxRecords','outputBytes','moduleFiles','moduleBytes','moduleFileBytes']);
    integer(m.bounds.phaseMS, 1000, 120000); integer(m.bounds.operationMS, 100, 30000);
    integer(m.bounds.transactionMS, m.bounds.operationMS, 60000); assert.ok(m.bounds.phaseMS > m.bounds.transactionMS);
    integer(m.bounds.candidateBytes, 16384, 4 * 1024 ** 2); integer(m.bounds.maxRecords, 8, 128);
    integer(m.bounds.outputBytes, 1024, 65536); integer(m.bounds.moduleFiles, 6, 20000);
    integer(m.bounds.moduleBytes, 1024, 512 * 1024 ** 2); integer(m.bounds.moduleFileBytes, 1024, 256 * 1024 ** 2);
    exact(m.policy, ['receiptRetention','rollbackRetentionBlocks','rollbackRetentionBytes','rollbackMaxBlockBytes']);
    assert.equal(m.policy.receiptRetention, 2); assert.equal(m.policy.rollbackRetentionBlocks, 2);
    integer(m.policy.rollbackRetentionBytes, 16384, 1024 ** 3); integer(m.policy.rollbackMaxBlockBytes, 8192, m.policy.rollbackRetentionBytes);
    exact(m.modules, ['root','entries','files']); assert.equal(m.modules.root,m.caseRoot+'/component');
    exact(m.modules.entries, ['sdk','adapterSdk','adapter','driver','runner','guard']);
    assert.deepEqual(m.modules.entries, {sdk:'host-sdk/dist/projection-stateful.js',adapterSdk:'node_modules/@eosrio/hyperion-sdk/dist/projection-stateful.js',
        adapter:'dist/stateful.js',driver:'node_modules/mongodb/lib/index.js',runner:'qualification/runner.mjs',guard:'qualification/guard.mjs'});
    assert.ok(Array.isArray(m.modules.files) && m.modules.files.length <= m.bounds.moduleFiles);
    const names = new Set(); let bytes = 0;
    for (const f of m.modules.files) {
        exact(f, ['path','bytes','sha256']); assert.ok(typeof f.path === 'string' && f.path.length > 0 && !f.path.includes('\\'));
        assert.equal(f.path, f.path.split('/').filter(p => p && p !== '.' && p !== '..').join('/')); assert.ok(!isAbsolute(f.path));
        assert.ok(!names.has(f.path)); names.add(f.path); integer(f.bytes, 0, m.bounds.moduleFileBytes); digest(f.sha256); bytes += f.bytes;
    }
    assert.ok(bytes <= m.bounds.moduleBytes); for (const f of Object.values(m.modules.entries)) assert.ok(names.has(f), 'Entry absent from reviewed module inventory');
    assert.equal(m.modules.files.find(f=>f.path===m.modules.entries.sdk).sha256,m.modules.files.find(f=>f.path===m.modules.entries.adapterSdk).sha256,'SDK instances must contain the same reviewed bytes');
    exact(m.input, ['path','bytes','sha256']); assert.equal(m.input.path, m.caseRoot + '/plan.json'); integer(m.input.bytes, 1, 16384); digest(m.input.sha256);
    return m;
}

export function ordinary(path, {owner = true, maxBytes = 512 * 1024 ** 2} = {}) {
    const full = resolve(path); let p = full;
    for (;;) {const s = lstatSync(p); assert.ok(!s.isSymbolicLink()); if (owner) {assert.equal(s.uid, 0);assert.equal(s.mode&0o022,0);} if (p === dirname(p)) break; p = dirname(p);}
    const s = lstatSync(full); assert.ok(s.isFile() && s.nlink === 1 && s.size <= maxBytes); return full;
}
export function boundedJson(path, maxBytes, owner = true) {return JSON.parse(readFileSync(ordinary(path, {maxBytes, owner}), 'utf8'));}
export function readPin(path, pin, owner = true) {
    const b = readFileSync(ordinary(path, {owner, maxBytes: pin.bytes})); assert.equal(b.length, pin.bytes); assert.equal(hash(b), pin.sha256); return b;
}
export function freshJson(path, value, maximum) {
    const b = Buffer.from(JSON.stringify(value) + '\n'); assert.ok(b.length <= maximum);
    const fd = openSync(path, 'wx', 0o600); try {writeFileSync(fd, b); fsyncSync(fd);} finally {closeSync(fd);}
    const dir = openSync(dirname(path), 'r'); try {fsyncSync(dir);} finally {closeSync(dir);}
    return {bytes: b.length, sha256: hash(b)};
}
export function processIdentity(pid) {
    const b = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = b.slice(b.lastIndexOf(')') + 2).split(' ');
    return {pid, birthTicks: fields[19]};
}
export function assertOwner(m, checkExecutable = false) {
    assert.deepEqual(processIdentity(m.owner.pid), {pid:m.owner.pid,birthTicks:m.owner.birthTicks});
    assert.equal(readlinkSync(`/proc/${m.owner.pid}/exe`), m.owner.executable);
    assert.equal(readlinkSync(`/proc/${m.owner.pid}/ns/net`), m.owner.netNamespace);
    assert.equal(readlinkSync('/proc/self/ns/net'), m.owner.netNamespace);
    assert.equal(hash(readFileSync(`/proc/${m.owner.pid}/cmdline`)), m.owner.cmdlineSha256);
    const tcp = readFileSync('/proc/net/tcp', 'utf8'); assert.ok(Buffer.byteLength(tcp) <= 4 * 1024 ** 2);
    const endpoint = '0100007F:' + Number(new URL(m.uri).port).toString(16).toUpperCase().padStart(4, '0');
    const rows = tcp.trim().split('\n').slice(1).map(s => s.trim().split(/\s+/));
    const selected = rows.filter(r => r[1] === endpoint && r[3] === '0A'); assert.equal(selected.length, 1);
    assert.equal(selected[0][9], m.owner.socketInode);
    const fds = readdirSync(`/proc/${m.owner.pid}/fd`); assert.ok(fds.length <= 8192);
    assert.ok(fds.some(fd => {try {return readlinkSync(`/proc/${m.owner.pid}/fd/${fd}`) === `socket:[${m.owner.socketInode}]`;} catch {return false;}}));
    if (checkExecutable) {
        // The real executable may live in the owned container mount namespace. Read its exact
        // kernel process reference, not an unrelated same-named file in the runner namespace.
        assert.ok(!m.owner.executable.endsWith(' (deleted)'));
        const p=`/proc/${m.owner.pid}/exe`;assert.ok(statSync(p).size<=m.bounds.moduleFileBytes);
        assert.equal(hash(readFileSync(p)),m.owner.executableSha256);
    }
}
/** Called only by explicit runtime phases; never used by offline configuration controls. */
export function preflight(manifestPath, expectedHash) {
    digest(expectedHash); assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
    assert.deepEqual(process.execArgv,[],'Preload/loader/runtime flags are outside this fixture');
    for(const key of Object.keys(process.env)) if(['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_V8_COVERAGE'].includes(key)||key.startsWith('MONGODB_LOG_'))
        assert.fail('External loader/coverage/driver logging environment is outside this fixture');
    const bytes = readFileSync(ordinary(manifestPath, {maxBytes:4*1024**2})); assert.equal(hash(bytes), expectedHash);
    const m = validateManifest(JSON.parse(bytes)); assert.equal(resolve(manifestPath), m.caseRoot + '/manifest.json');
    const st = lstatSync(m.caseRoot); assert.ok(st.isDirectory() && st.uid === 0 && (st.mode & 0o077) === 0);
    assert.equal(process.version, m.runtime.version); assert.equal(hash(readFileSync(ordinary(process.execPath))), m.runtime.executableSha256);
    assertOwner(m, true);
    // Every executable dependency file is pinned. Extra files (including new package exports) refuse.
    const actual = []; let total = 0,directories=0;
    const walk = dir => {assert.ok(++directories<=m.bounds.moduleFiles);const handle=opendirSync(dir);try {let entry;while((entry=handle.readSync())!==null) {
        const p = join(dir, entry.name); assert.ok(!entry.isSymbolicLink());
        if (entry.isDirectory()) walk(p); else {assert.ok(entry.isFile()); actual.push(relative(m.modules.root,p).split(sep).join('/')); assert.ok(actual.length <= m.bounds.moduleFiles);}
    }}finally{handle.closeSync();}};
    assert.equal(realpathSync(m.modules.root), resolve(m.modules.root)); walk(m.modules.root);
    assert.deepEqual(actual.sort(), m.modules.files.map(f => f.path).sort());
    for (const f of m.modules.files) {readPin(join(m.modules.root,f.path),f); total += f.bytes; assert.ok(total <= m.bounds.moduleBytes);}
    const sdkFiles=prefix=>m.modules.files.filter(f=>f.path.startsWith(prefix)).map(f=>({path:f.path.slice(prefix.length),bytes:f.bytes,sha256:f.sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    assert.deepEqual(sdkFiles('host-sdk/dist/'),sdkFiles('node_modules/@eosrio/hyperion-sdk/dist/'),'Host/adapter SDK emitted inventories differ');
    assert.equal(JSON.parse(readFileSync(join(m.modules.root,'node_modules/mongodb/package.json'),'utf8')).version,'7.2.0');
    const input = JSON.parse(readPin(m.input.path,m.input)); assert.equal(input.schemaVersion,1);
    return {manifest:m,input,manifestSha256:expectedHash};
}

/** Closed phase prerequisites. A receipt is evidence only, never authority for a target. */
export function validatePrior(receipt, phase, manifestSha256) {
    assert.ok(PHASES.includes(phase) && priorPhase(phase) !== null);
    assert.equal(receipt.phase, priorPhase(phase)); assert.equal(receipt.status,'passed'); assert.equal(receipt.manifestSha256,manifestSha256);
    assert.equal(receipt.actualMongo, true); assert.equal(receipt.engineCrash, false); return receipt;
}
