/** #246: actual production launcher/reader/worker/Mongo/HTTP engineering fork tracer.
 * Synthetic branch facts are explicitly distinct from live Wire consensus acceptance. */
import assert from 'node:assert/strict';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {mkdir, open, readdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {advanceProjectionMeasurementPhase, assertProjectionMeasurementReport} from './projection-validation-phase.mjs';
import {Client} from '@elastic/elasticsearch';
import {MongoClient} from 'mongodb';
import {Redis} from 'ioredis';
import {OwnedMongoFixture, MONGODB_VERSION, waitForMongo} from './projection-fixture.mjs';
import {startBulkLedger} from './replay-bulk-ledger.ts';
import {assertPortableWorkerServices, describePortableWorkerError, portableWorkerConfig, portableWorkerEnvironment,
    validatePortableWorkerPlan} from './portable-state-worker.ts';
import {auditPortableWorkerSource, boundedPortableFile, ordinaryPortablePath, portableSourceHash} from './portable-state-worker-source.ts';
import {buildRecoveryEngineeringSource, recoveryRecord, recoverySourceLimits, serveRecoveryEngineeringSource, type RecoveryBranch} from './portable-state-recovery-source.ts';
import {assertRecoveryHttp, assertRecoveryPhysical, assertRecoveryUnavailable, assertRecoveryProbe, inspectRecoveryPhysical, recoveryExpectedRows,
    recoveryMetadataId, recoveryUnaffectedDefinition} from './portable-state-recovery-oracle.ts';
import type {ProjectionBinding, ProjectionQuery} from '@eosrio/hyperion-sdk/projection';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
export async function waitForRecoveryHeldHead(milliseconds: 10000,
    clock: {now: () => number; pause: (ms: number) => Promise<unknown>} = {now: () => performance.now(), pause}) {
    // A timer wakeup alone does not prove that the required monotonic interval elapsed.
    const deadline = clock.now() + milliseconds;
    for (let remaining = milliseconds; remaining > 0; remaining = deadline - clock.now()) {
        await clock.pause(Math.ceil(remaining));
    }
}
const point = (value: {blockNum: number; blockId: string}) => ({blockNum: value.blockNum, blockId: value.blockId});
const describe = describePortableWorkerError;
export interface RecoveryRunOptions {
    readonly profilePrefix?: 288; readonly cpuProfile?: boolean;
    readonly projectionMeasurements?: boolean; readonly heldHeadMs?: 10000;
}
export function validateRecoveryRunOptions(options: RecoveryRunOptions = {}) {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    assert.ok(Object.keys(options).every(key => ['profilePrefix', 'cpuProfile', 'projectionMeasurements', 'heldHeadMs'].includes(key)), 'Unknown recovery run option');
    assert.ok(options.profilePrefix === undefined || options.profilePrefix === 288, 'Only the audited profiling prefix288 is supported');
    assert.ok(options.cpuProfile === undefined || typeof options.cpuProfile === 'boolean' && options.profilePrefix === 288,
        'CPU capture can only be selected explicitly with profiling prefix288');
    assert.ok(options.projectionMeasurements === undefined || typeof options.projectionMeasurements === 'boolean' && options.profilePrefix === 288,
        'Projection measurements require an explicit prefix288 diagnostic');
    assert.equal(options.heldHeadMs === undefined, options.projectionMeasurements === undefined,
        'Both projection measurement controls and the held-head duration must be explicit');
    assert.ok(options.heldHeadMs === undefined || options.heldHeadMs === 10000, 'The initial held-head comparison uses exactly10000ms');
    return options.profilePrefix;
}

/** Retain signed protocol deltas; only chronological, bounded intervals can supply elapsed weights. */
export function recoveryCpuProfileEvidence(profile: any) {
    assert.ok(profile && typeof profile === 'object' && !Array.isArray(profile));
    assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0 && profile.nodes.length <= 100000);
    assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0 && profile.samples.length <= 200000);
    assert.ok(Number.isSafeInteger(profile.startTime) && profile.startTime >= 0 &&
        Number.isSafeInteger(profile.endTime) && profile.endTime > profile.startTime);
    assert.ok(Array.isArray(profile.timeDeltas) && profile.timeDeltas.length === profile.samples.length);
    const ids = new Set<number>();
    for (const node of profile.nodes) {
        assert.ok(node && Number.isSafeInteger(node.id) && node.id > 0 && !ids.has(node.id)); ids.add(node.id);
    }
    assert.ok(profile.samples.every((id: unknown) => Number.isSafeInteger(id) && ids.has(id as number)));
    const elapsedMicros = profile.endTime - profile.startTime;
    let total = 0, minimumOffset = 0, maximumOffset = 0, minimumDelta = Infinity;
    let negativeCount = 0, negativeTotal = 0, outsideExtent = 0;
    const firstNegativeDeltas: {index: number; deltaMicros: number}[] = [];
    for (let index = 0; index < profile.timeDeltas.length; index++) {
        const delta = profile.timeDeltas[index];
        assert.ok(Number.isSafeInteger(delta), 'Profile deltas must be integer protocol microseconds');
        total += delta; assert.ok(Number.isSafeInteger(total), 'Reconstructed profile timestamp exceeds exact arithmetic');
        minimumDelta = Math.min(minimumDelta, delta);
        minimumOffset = Math.min(minimumOffset, total); maximumOffset = Math.max(maximumOffset, total);
        if (total < 0 || total > elapsedMicros) outsideExtent++;
        if (delta < 0) {
            negativeCount++; negativeTotal += delta; assert.ok(Number.isSafeInteger(negativeTotal));
            if (firstNegativeDeltas.length < 16) firstNegativeDeltas.push({index, deltaMicros: delta});
        }
    }
    const unavailableReasons: string[] = [];
    if (negativeCount) unavailableReasons.push('out-of-order-samples');
    if (outsideExtent) unavailableReasons.push('sample-outside-recording-extent');
    if (total <= 0) unavailableReasons.push('no-positive-sampled-interval');
    const intervalWeightsAvailable = unavailableReasons.length === 0;
    const lastSampleToEnd = elapsedMicros - total; assert.ok(Number.isSafeInteger(lastSampleToEnd));
    return {samples: profile.samples.length, startTime: profile.startTime, endTime: profile.endTime,
        timing: {elapsedMicros, rawSignedDeltaSumMicros: total, rawLastSampleToEndMicros: lastSampleToEnd,
            reconstructedOffsetRangeMicros: {min: minimumOffset, max: maximumOffset}, outsideExtentSampleCount: outsideExtent,
            negativeDeltaCount: negativeCount, negativeDeltaTotalMicros: negativeTotal, minimumDeltaMicros: minimumDelta,
            firstNegativeDeltas, intervalWeightsAvailable, unavailableReasons,
            sampledIntervalMicros: intervalWeightsAvailable ? total : null,
            unweightedTailMicros: intervalWeightsAvailable ? lastSampleToEnd : null, normalized: false as const}};
}

/** Profile completion is checked against observer receipts and actual bounded files after clean shutdown. */
export async function assertRecoveryCpuProfiles(rows: any[], directory: string, stableAt: number, enabled: boolean, parent: ChildProcess) {
    assert.ok(Number.isSafeInteger(parent?.pid) && parent.pid! > 0, 'An independently owned parent PID is required');
    const shutdown = assertRecoveryShutdown(rows, parent, []);
    assert.equal(rows.filter(row => row.kind === 'shutdown' && row.pid === parent.pid).length, 1);
    const uniquePids = (values: any[]) => {assert.ok(values.every(pid => Number.isSafeInteger(pid) && pid > 0));
        assert.equal(new Set(values).size, values.length, 'Duplicate PID in process inventory'); return [...values].sort((a, b) => a - b);};
    const forks = rows.filter(row => row.kind === 'worker_fork'), exits = rows.filter(row => row.kind === 'worker_exit');
    assert.ok([...forks, ...exits].every(row => row.pid === parent.pid), 'Child lifecycle receipt belongs to a foreign parent');
    const children = uniquePids(forks.map(row => row.childPid)); assert.ok(!children.includes(parent.pid));
    assert.deepEqual(uniquePids(shutdown.childExits.map((exit: any) => exit.pid)), children, 'Fork and shutdown child inventories differ');
    assert.deepEqual(uniquePids(exits.map(row => row.childPid)), children, 'Fork and actual child exit inventories differ');
    assert.ok(exits.every(row => row.code === 0 && row.signal === null), 'Actual child exit receipt was not clean');
    const online = rows.filter(row => row.kind === 'worker_online');
    uniquePids(online.map(row => row.childPid));
    assert.ok(online.every(row => row.pid === parent.pid && children.includes(row.childPid)), 'Online receipt contains a foreign child');
    const expected = uniquePids([parent.pid, ...children]);
    const starts = rows.filter(row => row.kind === 'start'); assert.ok(starts.length > 0);
    assert.deepEqual(uniquePids(starts.map(row => row.pid)), expected, 'An owned process observer is missing or foreign');
    assert.ok(starts.every(row => row.pid === parent.pid || row.parentPid === parent.pid), 'Child observer has a foreign parent');
    assert.ok(rows.every(row => expected.includes(row.pid)), 'Observer records contain a foreign process');
    assert.ok(!rows.some(row => row.kind === 'observer_error'));
    const files = await readdir(directory, {withFileTypes: true}); assert.ok(files.length <= 4096);
    assert.ok(files.every(file => file.isFile() && /^worker-[1-9][0-9]*\.(jsonl|cpuprofile)$/.test(file.name)), 'Unexpected observer artifact');
    for (const extension of ['jsonl', 'cpuprofile']) {
        const wanted = extension === 'jsonl' || enabled ? expected.map(pid => `worker-${pid}.${extension}`).sort() : [];
        assert.deepEqual(files.filter(file => file.name.endsWith('.' + extension)).map(file => file.name).sort(), wanted,
            'Actual observer artifact inventory differs: ' + extension);
    }
    const profiles: any[] = [];
    for (const start of starts) {
        const selected = rows.filter(row => row.pid === start.pid), file = join(directory, `worker-${start.pid}.cpuprofile`);
        const began = selected.filter(row => row.kind === 'profile_started'), saved = selected.filter(row => row.kind === 'profile_saved');
        const flushed = selected.filter(row => row.kind === 'flush'), exited = selected.filter(row => row.kind === 'exit');
        assert.equal(flushed.length, 1); const flush = flushed[0];
        assert.equal(flush.reason, 'qualifier_shutdown'); assert.ok(flush.at >= stableAt);
        assert.equal(flush.success, true); assert.equal(flush.error, null); assert.equal(flush.droppedRecords, 0);
        assert.equal(flush.profileState, enabled ? 'saved' : 'disabled'); assert.equal(flush.profilePath, enabled ? file : null);
        assert.equal(exited.length, 1); assert.equal(exited[0].code, 0); assert.equal(exited[0].profileState, enabled ? 'saved' : 'disabled');
        assert.equal(exited[0].flushed, true); assert.equal(exited[0].droppedRecords, 0);
        if (!enabled) {assert.equal(began.length, 0); assert.equal(saved.length, 0); continue;}
        assert.equal(began.length, 1); assert.equal(began[0].samplingIntervalMicros, 10000); assert.equal(began[0].maximumDurationMs, 900000);
        assert.ok(began[0].at <= stableAt); assert.equal(saved.length, 1); assert.equal(saved[0].profilePath, file);
        const bytes = await boundedPortableFile(file, 32 * 1024 * 1024); assert.equal(bytes.length, saved[0].bytes);
        const evidence = recoveryCpuProfileEvidence(JSON.parse(bytes.toString()));
        profiles.push({pid: start.pid, role: start.role, start, file, bytes: bytes.length, sha256: portableSourceHash(bytes),
            ...evidence, flush});
    }
    return profiles;
}

async function recoveryProfilePins(projectionMeasurements: boolean) {
    const files: {path: string; bytes: number; sha256: string}[] = []; let totalBytes = 0;
    const record = async (path: string) => {assert.ok(files.length < 4096);
        const bytes = await boundedPortableFile(join(repo, path), 16 * 1024 * 1024); totalBytes += bytes.length;
        assert.ok(totalBytes <= 128 * 1024 * 1024); files.push({path, bytes: bytes.length, sha256: portableSourceHash(bytes)});};
    const walk = async (path: string) => {await ordinaryPortablePath(join(repo, path), true);
        for (const entry of (await readdir(join(repo, path), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
            assert.ok(entry.isDirectory() || entry.isFile(), 'Profile emission must contain ordinary files/directories');
            if (entry.isDirectory()) await walk(path + '/' + entry.name); else await record(path + '/' + entry.name);
        }};
    for (const path of ['build', 'packages/backend-mongodb/dist']) await walk(path);
    for (const path of ['package-lock.json', 'packages/backend-mongodb/package-lock.json', 'tsconfig.json',
        'packages/backend-mongodb/tsconfig.json', '.bun-version', 'scripts/qualification/portable-state-recovery.ts',
        'scripts/qualification/es955-worker-observer.mjs', 'scripts/qualification/portable-state-recovery-observer.mjs']) await record(path);
    if (projectionMeasurements) for (const path of ['scripts/qualification/projection-validation-phase.mjs',
        'scripts/qualification/projection-validation-observer.mjs']) await record(path);
    for (const path of ['build/indexer/launcher.js', 'build/indexer/workers/projection.js', 'build/api/server.js', 'packages/backend-mongodb/dist/index.js'])
        assert.ok(files.some(file => file.path === path), 'Required profile emission missing: ' + path);
    const dirty = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], {cwd: repo, timeout: 5000, maxBuffer: 16 * 1024 * 1024});
    assert.equal(dirty.length, 0, 'Profile runs require committed tracked source/configuration');
    return {files, totalBytes, inventorySha256: portableSourceHash(Buffer.from(JSON.stringify(files))),
        trackedDiffBytes: dirty.length, trackedDiffSha256: portableSourceHash(dirty)};
}

async function freePort() {const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port; await new Promise<void>(done => server.close(() => done())); return port as number;}
async function responseBody(response: Response, maximum = 4 * 1024 * 1024) {assert.ok(response.body); const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of response.body) {bytes += chunk.length; assert.ok(bytes <= maximum); chunks.push(Buffer.from(chunk));}
    return JSON.parse(Buffer.concat(chunks).toString());}

/** Read actual effective node settings and filesystem headroom; JSON intent alone is insufficient. */
export function assertRecoveryDiskReadiness(core: any, settings: any, stats: any, cluster: any) {
    const profiles: Record<string, {low: string; high: string; floodStage: string}> = {
        '20-10-5gb': {low: '20gb', high: '10gb', floodStage: '5gb'},
        '8-4-2gb': {low: '8gb', high: '4gb', floodStage: '2gb'},
    };
    assert.ok(Object.hasOwn(profiles, core.diskWatermarkProfile), 'An explicit allowlisted disposable disk profile is required');
    const expected = profiles[core.diskWatermarkProfile]; assert.deepEqual(core.diskWatermarks, expected);
    const minimumAvailableBytes = (Number.parseInt(expected.low) + 2) * 1024 ** 3;
    const actual: any[] = [], selected = Object.entries(settings.nodes ?? {});
    assert.equal(selected.length, core.nodes.length);
    assert.deepEqual(selected.map(([, value]) => (value as any).name).sort(), core.nodes.map((value: any) => value.name).sort());
    assert.deepEqual(Object.keys(stats.nodes ?? {}).sort(), selected.map(([id]) => id).sort());
    for (const [nodeId, value] of selected) {
        const node = value as any, owned = core.nodes.find((item: any) => item.name === node.name);
        assert.ok(owned, 'Settings contain an unexpected fixture node'); assert.equal(stats.nodes?.[nodeId]?.name, node.name);
        const effective = (key: string) => cluster.transient?.[key] ?? cluster.persistent?.[key] ?? node.settings?.[key] ?? cluster.defaults?.[key];
        const readback: Record<string, unknown> = {};
        for (const [key, wanted] of Object.entries({'cluster.routing.allocation.disk.watermark.low': expected.low,
            'cluster.routing.allocation.disk.watermark.high': expected.high, 'cluster.routing.allocation.disk.watermark.flood_stage': expected.floodStage,
            'indexing_pressure.memory.limit': '64mb'})) {
            const observed = effective(key); assert.equal(observed, wanted, 'Effective fixture setting differs: ' + node.name + ' ' + key); readback[key] = observed;
        }
        const enabled = effective('cluster.routing.allocation.disk.threshold_enabled');
        assert.ok(enabled === true || enabled === 'true', 'Disk allocation thresholds must remain enabled');
        const available = stats.nodes[nodeId]?.fs?.total?.available_in_bytes;
        assert.ok(Number.isSafeInteger(available) && available >= 0, 'Actual available disk bytes are missing');
        if (owned.role === 'data') assert.ok(available >= minimumAvailableBytes, 'Owned data node lacks low-watermark plus2GiB headroom');
        actual.push({nodeId, name: node.name, role: owned.role, availableBytes: available, minimumAvailableBytes, settings: readback, thresholdsEnabled: enabled});
    }
    return {profile: core.diskWatermarkProfile, watermarks: expected, minimumAvailableBytes, nodes: actual,
        description: 'Read after Mongo image/startup and before production processes; all-copy writes and one replica remain required.'};
}

export function assertRecoveryShutdown(rows: any[], parent: ChildProcess, intentionalKills: readonly number[]) {
    const summary = rows.findLast(value => value.kind === 'shutdown' && value.pid === parent.pid);
    assert.ok(summary); assert.deepEqual(summary.forced, []); assert.deepEqual(summary.unresolved, []);
    const expected = [...intentionalKills].sort((a, b) => a - b);
    assert.deepEqual(summary.failedChildren.map((value: any) => value.pid).sort((a: number, b: number) => a - b), expected);
    for (const exit of summary.childExits) {
        if (intentionalKills.includes(exit.pid)) {assert.equal(exit.code, null); assert.equal(exit.signal, 'SIGKILL');}
        else {assert.equal(exit.code, 0); assert.equal(exit.signal, null);}
    }
    assert.equal(parent.signalCode, null); assert.equal(parent.exitCode, intentionalKills.length ? 1 : 0);
    assert.equal(summary.success, intentionalKills.length === 0);
    assert.equal(summary.childExits.length, rows.filter(value => value.kind === 'worker_fork').length);
    return summary;
}

export async function runPortableStateRecovery(stateFile: string, planFile: string, outputDirectory: string,
    finality: 'reversible' | 'irreversible', options: RecoveryRunOptions = {}) {
    const profilePrefix = validateRecoveryRunOptions(options), profileOnly = profilePrefix !== undefined, cpuProfile = profileOnly && options.cpuProfile !== false;
    const measurementComparison = options.projectionMeasurements !== undefined, measurementsEnabled = options.projectionMeasurements === true;
    assert.equal(process.release.name, 'node'); assert.ok(!process.versions.bun && /^(22|24)\./.test(process.versions.node));
    assert.equal(process.platform, 'linux', 'Actual stop/kill recovery qualification requires Linux');
    assert.ok(['reversible', 'irreversible'].includes(finality));
    const deadline = performance.now() + recoverySourceLimits.runMs;
    let cleanupDeadline: number | undefined;
    const remaining = () => {const value = Math.floor((cleanupDeadline ?? deadline) - performance.now()); assert.ok(value > 0, 'Recovery fixture deadline exceeded'); return value;};
    const docker = (args: string[]) => execFileSync('docker', args, {encoding: 'utf8', timeout: Math.min(30000, remaining()), maxBuffer: 16 * 1024 * 1024}).trim();
    const output = resolve(outputDirectory); await ordinaryPortablePath(dirname(output), true);
    try {await ordinaryPortablePath(output, true); throw new Error('Recovery output must be new');} catch (error: any) {if (error.code !== 'ENOENT') throw error;}
    const planBytes = await boundedPortableFile(resolve(planFile), 8 * 1024 * 1024), plan = validatePortableWorkerPlan(JSON.parse(planBytes.toString()));
    const original = await auditPortableWorkerSource(plan.source);
    const oracles: any[] = [], oracleHashes: Record<string, string> = {};
    for (const item of plan.oracleFiles) {const bytes = await boundedPortableFile(resolve(dirname(planFile), item.path), 16 * 1024 * 1024);
        assert.equal(bytes.length, item.bytes); assert.equal(portableSourceHash(bytes), item.sha256); oracleHashes[item.path] = item.sha256;
        const value = JSON.parse(bytes.toString()); if (value.sourceAbi && value.rows && value.conversions) oracles.push(value);}
    assert.equal(oracles.length, 1); const source = buildRecoveryEngineeringSource(original, plan, oracles[0]);
    const manifestBytes = await boundedPortableFile(join(repo, 'tests/fixtures/portable-state-recovery/manifest.json'), 65536);
    const fixed = JSON.parse(manifestBytes.toString()); assert.equal(source.records.length, fixed.derived.records);
    assert.equal(source.manifest.recordsSha256, fixed.derived.recordsSha256); assert.equal(source.chainId, fixed.original.chainId);
    assert.equal(source.profileId, fixed.original.profileId); assert.equal(source.sourceRevision, fixed.original.upstreamRevision);
    const state = JSON.parse((await boundedPortableFile(resolve(stateFile), 1024 * 1024)).toString());
    assert.equal(state.core.indexingPressureLimitMb, 64, 'Actual source journal requires the declared 64MiB pressure fixture');
    const services = [...state.core.nodes, state.core.broker, state.redis, ...['spring', 'mongo'].filter(key => state[key]).map(key => state[key])];
    const inspected = JSON.parse(docker(['inspect', ...services.map(value => value.containerId)]));
    const inspections = Object.fromEntries(services.map(value => [value.name, inspected.find((item: any) => item.Id === value.containerId)]));
    const network = JSON.parse(docker(['network', 'inspect', state.network]))[0]; assertPortableWorkerServices(state, inspections, network);
    const volumes: any[] = [];
    for (const service of services) {const volume = JSON.parse(docker(['volume', 'inspect', service.volume]))[0];
        assert.equal(volume.Labels?.['io.eosrio.run'], state.run);
        assert.deepEqual(docker(['ps', '-a', '--no-trunc', '--filter', 'volume=' + service.volume, '--format', '{{.ID}}']).split(/\r?\n/).filter(Boolean), [service.containerId]); volumes.push(volume);}
    await mkdir(output); for (const directory of ['observer', 'barrier', 'bulk', 'stages', 'config/chains']) await mkdir(join(output, directory), {recursive: true});
    if (measurementComparison) await mkdir(join(output, 'projection-observer'));
    const reportFile = await open(join(output, 'report.json'), 'wx');
    const report: any = {schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), finality, source: source.manifest,
        inputHashes: source.inputHashes, oracleHashes, planSha256: portableSourceHash(planBytes),
        manifestSha256: portableSourceHash(manifestBytes), runtime: {node: process.version, executable: process.execPath},
        inspections, network, volumes, indexingPressureLimitMb: state.core.indexingPressureLimitMb,
        stages: [], probes: [], transitions: [], crashes: [], errors: [], cleanup: [],
        limits: {nodeAuthenticatedFork: false, wireTestnetReleaseQualified: false, legacyRoutesQualified: false,
            boundedHistoricalSourceGapQualified: false, unavailableUndoAncestorQualified: false,
            originalCorpusChanged: false, fixture: 'synthetic-engineering-fork'}};
    if (profileOnly) {report.profileOnly = true; report.profiling = {prefix: profilePrefix, firstBlock: 1, sourcePacingBlocks: 32,
        cpuSamplingIntervalMicros: 10000, maximumProfileBytes: 32 * 1024 * 1024, maximumDurationMs: 900000,
        cpuCapture: {requested: cpuProfile, observerFlag: cpuProfile ? '1' : '0', verified: false, enabled: null},
        sourcePins: {chainId: source.chainId, profileId: source.profileId, upstreamRevision: source.sourceRevision, components: source.components},
        emptyTargetTablePrefix: true, overhead: cpuProfile ? 'CPU profiling overhead is not quantified; compare with a separately pinned observer-only control.'
            : 'CPU capture is disabled; existing observer/proxy overhead is not quantified.',
        fullRecoveryScenarioExecuted: false, stable: false};}
    if (measurementComparison) report.profiling.projectionMeasurements = {
        enabled: measurementsEnabled, heldHeadMs: options.heldHeadMs, phases: [], reports: [], completed: false,
        mode: 'qualification-wrappers', preciseV8Coverage: false,
        limitations: ['Inclusive asynchronous spans overlap synchronous loaded-metadata validation and must not be added.',
            'Lexical candidate-state and direct initialization validation, SDK function entries and native allocation costs are not observed by these wrappers.',
            'The API first public startup operation precedes attachment; it is outside the prefix phase and is not reconstructed.',
            'This diagnostic uses empty selected tables, not populated-row or full recovery qualification.'],
    };
    const chain = 'hyp-p191-' + state.run, database = 'h45_p191_' + state.run;
    const es = new Client({node: state.core.nodes[0].url, requestTimeout: 10000, maxRetries: 0});
    const mongoFixture = new OwnedMongoFixture({command: docker});
    let mongo: MongoClient | undefined, redis: Redis | undefined, replay: Awaited<ReturnType<typeof serveRecoveryEngineeringSource>> | undefined;
    let rpc: ReturnType<typeof createServer> | undefined, ledger: Awaited<ReturnType<typeof startBulkLedger>> | undefined;
    let api: ChildProcess | undefined, master: ChildProcess | undefined, apiPort = 0, configFile = '', generation = 0;
    const masters: {child: ChildProcess; name: string; kills: number[]; stopped: boolean}[] = [];
    const apis: {child: ChildProcess; name: string; stopped: boolean}[] = [];
    let probeTask: Promise<void> | undefined, stopProbes = false, probeStage = 'initial', knownFork = false;
    let captureFailure: (() => Promise<unknown>) | undefined;
    const wait = async (name: string, condition: () => Promise<void>, duration = 180000) => {
        const end = Math.min(deadline, performance.now() + duration); let last: unknown;
        while (performance.now() < end) {assert.deepEqual(report.errors, []);
            for (const child of [api, master]) if (child) assert.ok(child.exitCode === null && child.signalCode === null, name + ': production child exited');
            try {await condition(); return;} catch (error) {last = error;} await pause(100);}
        throw new Error(name + ' did not complete: ' + describe(last));
    };
    const observed = async (name: string) => {const directory = join(output, 'observer', name), rows: any[] = [];
        for (const file of (await readdir(directory)).filter(value => value.endsWith('.jsonl'))) {
            const lines = (await boundedPortableFile(join(directory, file), 24 * 1024 * 1024)).toString().split(/\r?\n/);
            for (const [index, line] of lines.entries()) if (line) try {rows.push(JSON.parse(line));} catch (error) {if (index < lines.length - 1) throw error;}}
        return rows;};
    const spawnOwned = async (entry: string, name: string) => {const directory = join(output, 'observer', name); await mkdir(directory);
        const stdout = await open(join(output, name + '.stdout.log'), 'wx'), stderr = await open(join(output, name + '.stderr.log'), 'wx');
        const environment = portableWorkerEnvironment(process.env, output, configFile, chain);
        for (const key of Object.keys(environment)) if (key.startsWith('HYP246_') || key.startsWith('HYP252_')) delete environment[key];
        try {const child = spawn(process.execPath, ['--import', pathToFileURL(join(repo, 'scripts/qualification/es955-worker-observer.mjs')).href,
            '--import', pathToFileURL(join(repo, 'scripts/qualification/portable-state-recovery-observer.mjs')).href,
            ...(measurementComparison ? ['--import', pathToFileURL(join(repo, 'scripts/qualification/projection-validation-observer.mjs')).href] : []), join(repo, entry)],
            {cwd: output, detached: true, stdio: ['ignore', stdout.fd, stderr.fd, 'ipc'], env: {...environment,
                ES198_OBSERVER_DIR: directory, HYP246_RECOVERY_OBSERVER: join(output, 'barrier'),
                ...(measurementsEnabled ? {HYP252_OBSERVER_DIR: join(output, 'projection-observer')} : {}),
                ...(profileOnly ? {ES198_CPU_PROFILE: cpuProfile ? '1' : '0', ES198_PROFILE_MAX_MS: '900000'} : {})}});
            child.on('error', error => report.errors.push(describe(error))); return child;
        } finally {await stdout.close(); await stderr.close();}};
    const query = async (projection: string, query: ProjectionQuery = {filter: [], limit: 256, count: {upTo: 1000}}) => {
        const response = await fetch('http://127.0.0.1:' + apiPort + '/v2/state/query', {method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({projection, query}), signal: AbortSignal.timeout(Math.min(5000, remaining()))});
        return {status: response.status, headers: response.headers, body: await responseBody(response)};};
    const receipt = (response: Awaited<ReturnType<typeof query>>) => ({status: response.status, headers: Object.fromEntries(response.headers), body: response.body});
    const queues = async () => {
        const response = await fetch(state.core.broker.managementUrl + '/api/queues/%2F', {headers: {
            authorization: 'Basic ' + Buffer.from('qualifier:qualifier-test-only').toString('base64')}, signal: AbortSignal.timeout(Math.min(5000, remaining()))});
        assert.equal(response.status, 200); const values = await responseBody(response, 1024 * 1024); assert.ok(Array.isArray(values) && values.length <= 4096);
        return values.filter((value: any) => value.name.startsWith(chain + ':')).map((value: any) => ({name: value.name,
            ready: value.messages_ready, unacked: value.messages_unacknowledged, messages: value.messages,
            ack: value.message_stats?.ack ?? 0, delivered: value.message_stats?.deliver_get ?? 0, redelivered: value.message_stats?.redeliver ?? 0}));
    };
    const drained = async () => {const values = await queues(); assert.ok(values.length > 0);
        assert.ok(values.every((value: any) => value.ready === 0 && value.unacked === 0 && value.messages === 0)); return values;};
    const stopMaster = async (entry: typeof masters[number]) => {
        if (entry.stopped) return;
        entry.child.send({event: 'qualifier_shutdown'});
        await Promise.race([once(entry.child, 'exit'), pause(10000)]);
        report.cleanup.push({name: entry.name, ok: true, shutdown: assertRecoveryShutdown(await observed(entry.name), entry.child, entry.kills)});
        entry.stopped = true;
    };
    const stopApi = async (entry: typeof apis[number]) => {
        if (entry.stopped) return;
        entry.child.send({event: 'qualifier_shutdown'}); await Promise.race([once(entry.child, 'exit'), pause(10000)]);
        report.cleanup.push({name: entry.name, ok: true, shutdown: assertRecoveryShutdown(await observed(entry.name), entry.child, [])});
        entry.stopped = true;
    };
    try {
        report.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8', timeout: 5000}).trim();
        report.runtime.sha256 = portableSourceHash(await boundedPortableFile(process.execPath, 256 * 1024 * 1024));
        if (profileOnly) {report.profiling.pins = await recoveryProfilePins(measurementComparison); report.runtime.execArgv = process.execArgv;}
        const identity = await es.info(); assert.equal(identity.version.number, '9.5.5'); assert.equal(identity.cluster_uuid, state.core.clusterUuid);
        const kernel = docker(['info', '--format', '{{.KernelVersion}}']); const version = /^(\d+)\.(\d+)\.(\d+)/.exec(kernel);
        assert.ok(!version || !(Number(version[1]) === 6 && Number(version[2]) >= 19
            || Number(version[1]) === 7 && Number(version[2]) === 0 && Number(version[3]) < 14), 'Mongo8.0.34 incompatible host kernel');
        report.kernel = kernel;
        assert.deepEqual(Object.keys(await es.indices.get({index: chain + '-*', allow_no_indices: true, ignore_unavailable: true})), []);
        assert.deepEqual(await queues(), []);
        redis = new Redis(state.redis.url, {lazyConnect: true, commandTimeout: 5000, connectTimeout: 5000, enableOfflineQueue: false, maxRetriesPerRequest: 1});
        redis.on('error', error => report.errors.push(describe(error))); await redis.connect(); assert.deepEqual(await redis.keys(chain + '::*'), []);
        mongoFixture.prepare(); const mongoUri = mongoFixture.start('replica');
        const initial = await waitForMongo(() => new MongoClient(mongoUri, {directConnection: true, serverSelectionTimeoutMS: 1500, timeoutMS: 5000})); await initial.close();
        mongoFixture.initializeReplica(); mongo = await waitForMongo(() => new MongoClient(mongoUri, {directConnection: true, retryWrites: false,
            replicaSet: mongoFixture.replicaSet, serverSelectionTimeoutMS: 1500, timeoutMS: 5000}), {primary: true, replicaSet: mongoFixture.replicaSet});
        assert.ok(mongo); assert.equal((await mongo.db('admin').command({buildInfo: 1})).version, MONGODB_VERSION);
        assert.deepEqual(await mongo.db(database).listCollections({}, {nameOnly: true}).toArray(), []);
        report.mongo = {uri: mongoUri, version: MONGODB_VERSION, replicaSet: mongoFixture.replicaSet, database, container: mongoFixture.ownedContainer('replica')};
        report.diskReadiness = assertRecoveryDiskReadiness(state.core,
            await es.nodes.info({metric: ['settings'], flat_settings: true}), await es.nodes.stats({metric: ['fs']}),
            await es.cluster.getSettings({include_defaults: true, flat_settings: true}));
        replay = await serveRecoveryEngineeringSource(source, report.errors);
        report.rpcRequests = []; report.rpcRejections = []; report.rpcRejectionsOmitted = 0;
        report.discoveryProbes = []; report.discoveryProbesOmitted = 0;
        rpc = createServer(async (incoming, outgoing) => {
          const request: any = {at: Date.now(), method: incoming.method, path: incoming.url, userAgent: incoming.headers['user-agent'], bytes: 0};
          try {let bytes = 0; const chunks: Buffer[] = [];
            for await (const chunk of incoming) {bytes += chunk.length; request.bytes = bytes; assert.ok(bytes <= 4096); chunks.push(Buffer.from(chunk));}
            const raw = Buffer.concat(chunks); request.bodySha256 = portableSourceHash(raw);
            request.bodyPreviewHex = raw.subarray(0, 512).toString('hex');
            const body = bytes ? JSON.parse(raw.toString()) : {};
            request.body = body;
            // Fleet listener discovery may probe this loopback socket; it is not a chain RPC input.
            if (incoming.method === 'GET' && incoming.url === '/v2/health' && bytes === 0) {
                if (report.discoveryProbes.length < 64) report.discoveryProbes.push({...request, status: 404}); else report.discoveryProbesOmitted++;
                outgoing.writeHead(404, {'content-type': 'application/json'}); outgoing.end('{"error":"not_found"}'); return;
            }
            assert.ok(report.rpcRequests.length < 512 && ['POST', 'GET'].includes(incoming.method!)
                && incoming.url === '/v1/chain/get_info' && Object.keys(body).length === 0);
            const info = replay!.info(); report.rpcRequests.push({at: Date.now(), body, info}); outgoing.writeHead(200, {'content-type': 'application/json'}); outgoing.end(JSON.stringify(info));
        } catch (error) {
            if (report.rpcRejections.length < 16) report.rpcRejections.push(request); else report.rpcRejectionsOmitted++;
            report.errors.push(describe(error)); outgoing.writeHead(503); outgoing.end('{}');}});
        rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening'); const rpcUrl = 'http://127.0.0.1:' + (rpc.address() as any).port;
        ledger = await startBulkLedger(state.core.nodes[0].url, join(output, 'bulk'), report.errors, 20000);
        const unaffected = recoveryUnaffectedDefinition(plan), definitions = [...plan.definitions, unaffected];
        apiPort = await freePort(); const config = portableWorkerConfig(chain, database, definitions, apiPort, rpcUrl);
        (config.features.portable_state as any).finality = finality;
        (config.settings as any).protocol_abi_coordination = {recovery_window_blocks: 4096};
        const configModule = await import(new URL('../../build/indexer/projection/config.js', import.meta.url).href);
        const selected = configModule.resolvePortableStateConfiguration(config.features.portable_state, source.chainId);
        const bindings: ProjectionBinding[] = definitions.map(definition => configModule.portableStateBinding(selected, definition, source.chainId));
        const {ProtocolAbiFrontierStore} = await import(new URL('../../build/indexer/protocol/abi-frontier-store.js', import.meta.url).href);
        const frontier = new ProtocolAbiFrontierStore(es, chain, 1, {readOnly: true});
        captureFailure = async () => {
            const targets = [...bindings, ...(report.gapBinding ? [report.gapBinding] : [])];
            const labels = ['canonical-frontier', ...targets.map(binding => binding.projectionId)];
            const results = await Promise.allSettled([frontier.readControl(), ...targets.map(binding => inspectRecoveryPhysical(mongo!, database, binding))]);
            return {at: Date.now(), source: replay?.metrics(), snapshots: results.map((result, index) => result.status === 'fulfilled'
                ? {name: labels[index], ok: true, value: result.value} : {name: labels[index], ok: false, error: describe(result.reason)})};
        };
        const mongoUrl = new URL(mongoUri), redisUrl = new URL(state.redis.url), connections = {
            elasticsearch: {protocol: 'http', host: new URL(state.core.nodes[0].url).host, ingest_nodes: [new URL(ledger.url).host], user: '', pass: ''},
            amqp: {protocol: 'http', host: new URL(state.core.broker.url).host, api: new URL(state.core.broker.managementUrl).host,
                user: 'qualifier', pass: 'qualifier-test-only', vhost: '/', frameMax: '0x10000'},
            redis: {host: redisUrl.hostname, port: Number(redisUrl.port)}, mongodb: {enabled: true, host: mongoUrl.hostname, port: Number(mongoUrl.port),
                directConnection: true, replicaSet: mongoFixture.replicaSet, database_prefix: chain, user: '', pass: ''},
            chains: {[chain]: {chain_id: source.chainId, http: rpcUrl, ship: [{label: 'synthetic-p246-engineering', url: replay.url}], control_port: await freePort()}}, alerts: {enabled: false}};
        configFile = join(output, 'chain.json');
        for (const [file, value] of [[configFile, config], [join(output, 'config/chains', chain + '.config.json'), config],
            [join(output, 'config/connections.json'), connections], [join(output, 'package.json'), JSON.parse((await boundedPortableFile(join(repo, 'package.json'), 65536)).toString())]] as const)
            await writeFile(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
        report.config = config; report.bindings = bindings; report.connections = connections; report.unaffectedDefinition = unaffected;
        const startMaster = async () => {const name = 'master-' + generation++; master = await spawnOwned('build/indexer/launcher.js', name);
            const entry = {child: master, name, kills: [] as number[], stopped: false}; masters.push(entry); return entry;};
        const startApi = async () => {const name = 'api-' + apis.length; api = await spawnOwned('build/api/server.js', name);
            const entry = {child: api, name, stopped: false}; apis.push(entry); return entry;};
        let owner = await startMaster(), apiOwner = await startApi();
        const captureControl = async () => {const current = await frontier.readControl(); const value = current?.value;
            if (value && (report.transitions.length === 0 || report.transitions.at(-1).revision !== value.revision)) {
                assert.ok(report.transitions.length < 20000); report.transitions.push({at: Date.now(), ...value});}
            return value;};
        const checkpoint = (branch: RecoveryBranch, through: number) => point(recoveryRecord(source, branch, through));
        const physicalAt = async (branch: RecoveryBranch, through: number) => {
            const expected = {...recoveryExpectedRows(plan, branch, through), [unaffected.id]: []}, physical: any[] = [];
            for (const binding of bindings) {const value = await inspectRecoveryPhysical(mongo!, database, binding);
                assertRecoveryPhysical(value, checkpoint(branch, through), expected[binding.projectionId]); physical.push(value);}
            return physical;};
        const stage = async (name: string, branch: RecoveryBranch, through: number) => {
            probeStage = name; let physical: any[] = [], responses: any[] = [];
            await wait(name, async () => {
                const current = await captureControl(); assert.equal(current?.phase, 'following');
                assert.equal(current?.head?.blockId, recoveryRecord(source, branch, replay!.metrics().through).blockId);
                physical = await physicalAt(branch, through); responses = [];
                for (const [index, binding] of bindings.entries()) {const response = await query(binding.projectionId); assert.equal(response.status, 200);
                    assertRecoveryHttp(response.body, response.headers, binding, checkpoint(branch, through),
                        binding.projectionId === unaffected.id ? [] : recoveryExpectedRows(plan, branch, through)[binding.projectionId], finality,
                        physical[index].metadata.revision); responses.push(receipt(response));}
            });
            const value = {name, branch, through, physical, responses, source: replay!.metrics(), control: await captureControl()};
            const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), file = 'stages/' + name + '.json';
            await writeFile(join(output, file), bytes, {flag: 'wx'}); report.stages.push({name, file, sha256: portableSourceHash(bytes)}); return value;
        };
        await wait('HTTP unavailable before source', async () => assertRecoveryUnavailable(await query(bindings[0].projectionId)));
        let projectionIdentity: {pid: number; parentPid: number; role: string; viaParentPid: number} | undefined;
        const measurementPhase = async (phase: 'prefix' | 'held-head' | 'verification' | 'shutdown') => {
            if (!measurementsEnabled) return;
            if (!projectionIdentity) {
                await wait('actual projection measurement process start', async () => {
                    const starts = (await observed(owner.name)).filter(row => row.kind === 'start' && row.role === 'projection');
                    assert.equal(starts.length, 1); const start = starts[0];
                    assert.ok(Number.isSafeInteger(start.pid) && start.pid > 0); assert.equal(start.parentPid, owner.child.pid);
                    projectionIdentity = {pid: start.pid, parentPid: owner.child.pid!, role: 'projection', viaParentPid: owner.child.pid!};
                }, 10000);
            }
            const receipts = await Promise.all([
                advanceProjectionMeasurementPhase(owner.child, projectionIdentity!, phase),
                advanceProjectionMeasurementPhase(apiOwner.child, {pid: apiOwner.child.pid!, parentPid: process.pid, role: 'api'}, phase),
            ]);
            report.profiling.projectionMeasurements.phases.push({phase, receipts});
        };
        const commonThrough = profilePrefix ?? 1243;
        if (measurementsEnabled) await measurementPhase('prefix');
        if (profileOnly) report.profiling.firstReleaseAt = Date.now();
        for (let through = 32; through < commonThrough; through += 32) {replay.release(through);
            await wait('paced common prefix ' + through, async () => {await physicalAt('A', through);});}
        replay.release(commonThrough); const common = await stage(profileOnly ? 'profile-prefix-288' : 'common', 'A', commonThrough);
        if (profileOnly) {
            const stableAt = Date.now();
            for (const value of common.physical) {assert.equal(value.metadata.undo.length, 256);
                assert.deepEqual(value.metadata.coverageFloor, checkpoint('A', 32));}
            await wait('profile source credits acknowledged', async () => replay!.assertDrained());
            const sent = replay.metrics().sessions.flatMap(session => session.sent);
            assert.ok(sent.every(entry => entry.branch === 'A' && entry.blockNum >= 1 && entry.blockNum <= profilePrefix));
            assert.deepEqual([...new Set(sent.map(entry => entry.blockNum))].sort((a, b) => a - b), Array.from({length: profilePrefix}, (_, index) => index + 1));
            await wait('profile broker acknowledgments and queues drained', async () => {report.brokerAcks = await drained();
                const raw = report.brokerAcks.filter((value: any) => value.name === chain + ':live_blocks'); assert.equal(raw.length, 1);
                assert.ok(raw[0].ack >= profilePrefix && raw[0].delivered >= raw[0].ack);});
            const after = await auditPortableWorkerSource(plan.source); assert.deepEqual(after.inputHashes, original.inputHashes);
            report.profiling.stable = true; report.profiling.stableAt = stableAt; report.profiling.sourceReauditHashes = after.inputHashes;
            if (measurementComparison) {
                await measurementPhase('held-head');
                const heldHeadStartedAt = Date.now(), heldHeadStartedMonotonicMs = performance.now();
                await waitForRecoveryHeldHead(options.heldHeadMs!);
                await measurementPhase('verification');
                report.profiling.projectionMeasurements.heldHead = {startedAt: heldHeadStartedAt, endedAt: Date.now(),
                    elapsedMonotonicMs: performance.now() - heldHeadStartedMonotonicMs,
                    note: 'No HTTP queries or new source releases during the fixed-head wait; phase barriers add separately recorded time.'};
                const held = await stage('profile-held-head-288', 'A', profilePrefix);
                assert.deepEqual(held.source.sessions.flatMap((session: any) => session.sent), sent);
                for (const value of held.physical) {assert.equal(value.metadata.undo.length, 256);
                    assert.deepEqual(value.metadata.coverageFloor, checkpoint('A', 32));}
                const heldAudit = await auditPortableWorkerSource(plan.source); assert.deepEqual(heldAudit.inputHashes, original.inputHashes);
                await wait('held-head source and broker drained', async () => {replay!.assertDrained(); report.brokerAcks = await drained();});
                await measurementPhase('shutdown');
            }
            await stopMaster(owner); master = undefined; await stopApi(apiOwner); api = undefined;
            if (measurementComparison) {
                const directory = join(output, 'projection-observer'), files = await readdir(directory, {withFileTypes: true});
                const identities = measurementsEnabled ? [projectionIdentity!, {pid: apiOwner.child.pid!, parentPid: process.pid, role: 'api'}] : [];
                assert.deepEqual(files.map(file => file.name).sort(), identities.map(identity => `projection-${identity.pid}.json`).sort());
                assert.ok(files.every(file => file.isFile()));
                const storage = report.profiling.pins.files.find((file: any) => file.path === 'packages/backend-mongodb/dist/storage.js');
                assert.ok(storage);
                for (const identity of identities) {
                    const file = `projection-observer/projection-${identity.pid}.json`, bytes = await boundedPortableFile(join(output, file), 24 * 1024 * 1024);
                    const summary = assertProjectionMeasurementReport(JSON.parse(bytes.toString()), identity,
                        report.profiling.projectionMeasurements.phases, storage.sha256);
                    report.profiling.projectionMeasurements.reports.push({file, bytes: bytes.length, sha256: portableSourceHash(bytes), summary});
                }
                report.profiling.projectionMeasurements.completed = true;
            }
            report.profiling.cpuProfiles = []; report.profiling.observerCompletion = [];
            for (const entry of [owner, apiOwner]) {const rows = await observed(entry.name);
                report.profiling.cpuProfiles.push(...await assertRecoveryCpuProfiles(rows, join(output, 'observer', entry.name), stableAt, cpuProfile, entry.child));
                report.profiling.observerCompletion.push({name: entry.name, ownedParentPid: entry.child.pid,
                    events: rows.filter(row => ['start', 'worker_fork', 'worker_online', 'worker_exit', 'shutdown', 'profile_started', 'profile_saved', 'flush', 'exit'].includes(row.kind))});}
            if (cpuProfile) assert.equal(report.profiling.cpuProfiles.filter((value: any) => value.role === 'projection').length, 1);
            Object.assign(report.profiling.cpuCapture, {verified: true, enabled: cpuProfile,
                intervalWeightsAvailable: cpuProfile ? report.profiling.cpuProfiles.every((value: any) => value.timing.intervalWeightsAvailable) : null,
                unavailableIntervalWeightProfiles: report.profiling.cpuProfiles.filter((value: any) => !value.timing.intervalWeightsAvailable).map((value: any) => value.pid)});
            report.sourceMetrics = replay.metrics(); report.sourceRequests = replay.requests; report.status = 'profiled-prefix'; return report;
        }
        replay.release(1247); const a = await stage('branch-a', 'A', finality === 'reversible' ? 1247 : 1243);
        const beforeGeneration = a.control.generation;
        if (finality === 'reversible') await writeFile(join(output, 'barrier/arm.json'), JSON.stringify({database, metadataId: recoveryMetadataId(bindings[0])}) + '\n', {flag: 'wx'});
        probeTask = (async () => {while (!stopProbes) {try {const control = await captureControl();
            if (control && control.generation !== beforeGeneration) knownFork = true;
            const afterFork = knownFork;
            for (const binding of bindings) {
                const response = await query(binding.projectionId);
                assert.ok(report.probes.length < 12000); report.probes.push({at: Date.now(), stage: probeStage, projection: binding.projectionId,
                    afterFork, control: {phase: control?.phase, generation: control?.generation}, ...receipt(response)});
                if (response.status === 503) assertRecoveryUnavailable(response);
                else {assert.equal(response.status, 200); assertRecoveryProbe(response.body, response.headers, binding, finality, source, plan, afterFork);}
            }
        } catch (error) {report.errors.push(describe(error)); return;} await pause(50);}})();
        await wait('all A source credits acknowledged', async () => replay!.assertDrained());
        probeStage = 'fork'; replay.replaceAndDisconnect(); replay.release(1248);
        if (finality === 'reversible') {
            let barrier: any;
            await wait('actual rollback intent stop', async () => {barrier = JSON.parse((await boundedPortableFile(join(output, 'barrier/barrier.json'), 65536)).toString());});
            assert.equal(barrier.parentPid, owner.child.pid); assert.equal(barrier.role, 'projection'); assert.ok(Number.isSafeInteger(barrier.pid));
            const starts = await observed(owner.name); assert.ok(starts.some(value => value.kind === 'start' && value.pid === barrier.pid && value.role === 'projection'));
            const status = (await boundedPortableFile('/proc/' + barrier.pid + '/status', 65536)).toString();
            assert.match(status, new RegExp('PPid:\\s+' + owner.child.pid + '\\b')); assert.match(status, /State:\s+T/);
            const physical = await inspectRecoveryPhysical(mongo!, database, bindings[0]);
            assert.equal(physical.metadata.rollback.status, 'running'); assert.equal(physical.metadata.rollback.operationId, barrier.receipt.operationId);
            assert.deepEqual(physical.metadata.rollback.from, checkpoint('A', 1247)); assert.deepEqual(physical.metadata.rollback.ancestor, checkpoint('A', 1243));
            assert.equal(physical.metadata.revision, barrier.receipt.revision); assertRecoveryUnavailable(await query(bindings[0].projectionId));
            const history = await fetch('http://127.0.0.1:' + apiPort + '/v2/history/get_block?block_num=1243', {signal: AbortSignal.timeout(5000)});
            assert.equal(history.status, 200); assert.equal((await responseBody(history)).block_id, checkpoint('A', 1243).blockId);
            owner.kills.push(barrier.pid); process.kill(barrier.pid, 'SIGKILL');
            report.crashes.push({barrier, physical, killedAt: new Date().toISOString(), kind: 'actual-projection-worker-after-durable-rollback-intent'});
        }
        await stage('branch-b', 'B', finality === 'reversible' ? 1248 : 1246);
        assert.ok(knownFork); assert.ok(report.probes.some((value: any) => value.status === 503), 'Recovery never exposed the expected retryable unavailable interval');
        await wait('source credits drained before launcher restart', async () => replay!.assertDrained());
        await wait('broker drained before launcher restart', async () => {await drained();});
        await stopMaster(owner); master = undefined;
        owner = await startMaster(); await stage('launcher-restart', 'B', finality === 'reversible' ? 1248 : 1246);
        await wait('source credits settled after launcher restart', async () => replay!.assertDrained());
        assert.ok(replay.metrics().sessions.length >= 3, 'Expected initial, replacement and launcher-restart SHiP sessions');
        stopProbes = true; await probeTask; probeTask = undefined;
        await wait('broker drained before bounded-gap restart', async () => {await drained();});
        await stopMaster(owner); master = undefined; await stopApi(apiOwner); api = undefined;
        const gapDefinition = {...structuredClone(plan.definitions[0]), id: 'qualification-bounded-genesis-gap'};
        const gapConfig = structuredClone(config); gapConfig.features.portable_state.projections = [...gapConfig.features.portable_state.projections, gapDefinition];
        (gapConfig.settings as any).protocol_abi_coordination = {recovery_window_blocks: 3};
        const selectedGap = configModule.resolvePortableStateConfiguration(gapConfig.features.portable_state, source.chainId);
        const gapBinding: ProjectionBinding = configModule.portableStateBinding(selectedGap, gapDefinition, source.chainId);
        report.gapBinding = gapBinding;
        for (const file of [configFile, join(output, 'config/chains', chain + '.config.json')]) await writeFile(file, JSON.stringify(gapConfig, null, 2) + '\n');
        owner = await startMaster(); apiOwner = await startApi();
        await stage('bounded-gap-existing', 'B', finality === 'reversible' ? 1248 : 1246);
        let durableGap: any;
        await wait('new instance has a durable bounded historical source gap', async () => {
            durableGap = await inspectRecoveryPhysical(mongo!, database, gapBinding);
            assert.equal(durableGap.metadata.checkpoint.blockNum, 0); assert.deepEqual(durableGap.rows, []);
            assert.equal(durableGap.metadata.pending, null);
            const target = checkpoint('B', finality === 'reversible' ? 1248 : 1246);
            assert.equal(durableGap.metadata.gap?.block.blockNum, target.blockNum); assert.equal(durableGap.metadata.gap?.block.blockId, target.blockId);
            assertRecoveryUnavailable(await query(gapBinding.projectionId));
        });
        replay.release(1249); const progressed = await stage('bounded-gap-continuation', 'B', finality === 'reversible' ? 1249 : 1247);
        const gapResponse = await query(gapBinding.projectionId); assertRecoveryUnavailable(gapResponse);
        const healthy = await query(bindings[0].projectionId); assert.equal(healthy.status, 200);
        let historyEvidence: any;
        await wait('canonical history continues through new B1249', async () => {
            const response = await fetch('http://127.0.0.1:' + apiPort + '/v2/history/get_block?block_num=1249', {signal: AbortSignal.timeout(5000)});
            const body = await responseBody(response); assert.equal(response.status, 200); assert.equal(body.block_id, checkpoint('B', 1249).blockId);
            historyEvidence = {status: response.status, headers: Object.fromEntries(response.headers), body};
        });
        report.boundedGap = {window: 3, definition: gapDefinition, binding: gapBinding, beforeContinuation: durableGap,
            afterContinuation: await inspectRecoveryPhysical(mongo!, database, gapBinding), unavailable: receipt(gapResponse),
            healthy: receipt(healthy), history: historyEvidence, control: progressed.control,
            note: 'Original journal bytes remain present. A fresh genesis instance cannot claim proof outside its configured source window; existing instances and new canonical history continue.'};
        report.limits.boundedHistoricalSourceGapQualified = true;
        await wait('final broker acknowledgments and all owned queues drained', async () => {report.brokerAcks = await drained();
            const raw = report.brokerAcks.filter((value: any) => value.name === chain + ':live_blocks'); assert.equal(raw.length, 1);
            assert.ok(raw[0].ack >= 1249 && raw[0].delivered >= raw[0].ack);});
        await wait('final source credits acknowledged', async () => replay!.assertDrained());
        const after = await auditPortableWorkerSource(plan.source); assert.deepEqual(after.inputHashes, original.inputHashes);
        report.sourceMetrics = replay.metrics(); report.sourceRequests = replay.requests; report.status = 'passed';
    } catch (error) {report.status = 'failed'; report.error = describe(error);}
    finally {
        cleanupDeadline = performance.now() + 90000; stopProbes = true; await probeTask;
        if (report.errors.length) {report.status = 'failed'; report.error ??= 'Asynchronous fixture errors: ' + describe(report.errors[0]);}
        if (report.status === 'failed' && captureFailure) {
            try {report.failureSnapshot = await captureFailure();}
            catch (error) {report.failureSnapshot = {error: describe(error)};}
        }
        for (const entry of masters) if (!entry.stopped) {try {await stopMaster(entry);} catch (error) {report.status = 'failed'; report.cleanup.push({name: entry.name, ok: false, error: describe(error)});
            try {if (entry.child.pid && entry.child.exitCode === null && entry.child.signalCode === null) process.kill(-entry.child.pid, 'SIGKILL');} catch (forced: any) {if (forced.code !== 'ESRCH') report.cleanup.push({name: entry.name + '-forced', ok: false, error: describe(forced)});}}}
        for (const entry of apis) if (!entry.stopped) try {await stopApi(entry);}
        catch (error) {report.status = 'failed'; report.cleanup.push({name: entry.name, ok: false, error: describe(error)}); try {if (entry.child.pid && entry.child.exitCode === null) process.kill(-entry.child.pid, 'SIGKILL');} catch {}}
        for (const [name, close] of [['source', () => replay?.close()], ['rpc', () => {rpc?.closeAllConnections(); return rpc ? new Promise<void>(done => rpc!.close(() => done())) : undefined;}],
            ['bulk', () => ledger?.close()], ['redis', () => redis?.disconnect()], ['mongo-client', () => mongo?.close()], ['elasticsearch', () => es.close()], ['owned-mongodb', () => mongoFixture.cleanup()]] as const)
            try {await close(); report.cleanup.push({name, ok: true});} catch (error) {report.status = 'failed'; report.cleanup.push({name, ok: false, error: describe(error)});}
        report.mongoCleanup = mongoFixture.cleanupResult; report.sourceMetrics ??= replay?.metrics(); report.sourceRequests ??= replay?.requests;
        report.bulkCapture = ledger ? {...ledger.limits, recordedRequests: ledger.receipts.length} : null;
        if (report.errors.length) {report.status = 'failed'; report.error ??= 'Asynchronous fixture errors: ' + describe(report.errors[0]);}
        if (profileOnly) {
            if (report.error !== undefined || report.cleanup.some((value: any) => value.ok !== true)) report.status = 'failed';
            report.profiling.completed = report.status === 'profiled-prefix';
        }
        report.completedAt = new Date().toISOString(); await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportFile.sync(); await reportFile.close();
    }
    return report;
}

export function parseRecoveryArguments(args: string[]) {
    assert.ok(args.length === 4 || [6, 8, 12].includes(args.length) && args[4] === '--profile-prefix' && args[5] === '288'
        && (args.length === 6 || args[6] === '--cpu-profile' && ['on', 'off'].includes(args[7]))
        && (args.length !== 12 || args[8] === '--projection-measurements' && ['on', 'off'].includes(args[9])
            && args[10] === '--held-head-ms' && args[11] === '10000'),
        'usage: node portable-state-recovery.ts STATE_FILE ORIGINAL_PLAN NEW_OUTPUT reversible|irreversible [--profile-prefix 288 [--cpu-profile on|off [--projection-measurements on|off --held-head-ms 10000]]]');
    assert.ok(['reversible', 'irreversible'].includes(args[3]));
    const options: RecoveryRunOptions = args.length > 4 ? {profilePrefix: 288, cpuProfile: args.length === 6 || args[7] === 'on'} : {};
    const selected = args.length === 12 ? {...options, projectionMeasurements: args[9] === 'on', heldHeadMs: 10000 as const} : options;
    validateRecoveryRunOptions(selected);
    return {stateFile: args[0], planFile: args[1], outputDirectory: args[2], finality: args[3] as 'reversible' | 'irreversible', options: selected};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const {stateFile, planFile, outputDirectory, finality, options} = parseRecoveryArguments(process.argv.slice(2));
    const result = await runPortableStateRecovery(stateFile, planFile, outputDirectory, finality, options);
    console.log(JSON.stringify({status: result.status, error: result.error, finality: result.finality, stages: result.stages}));
    if (result.status !== (options.profilePrefix ? 'profiled-prefix' : 'passed')) process.exitCode = 1;
}
