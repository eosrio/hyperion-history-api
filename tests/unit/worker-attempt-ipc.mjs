/** Real owned cluster workers; logical labels and IPC callbacks are never the end oracle. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd, workerAttemptDigest} from '../../build/indexer/protocol/worker-attempt-supervisor.js';

const mode = process.argv[2] ?? 'retry';
const transcript = [], cases = [], owned = [];
const endEvidence = [];
const supervisor = new WorkerAttemptSupervisor({onEnd(end) {endEvidence.push(end);}, fenceTimeoutMs: 1000});
cluster.setupPrimary({exec: fileURLToPath(new URL('./worker-attempt-ipc-child.mjs', import.meta.url)), silent: true});

function waitFor(predicate, label, timeout = 5000) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const poll = setInterval(() => {if (predicate()) {clearInterval(poll); clearTimeout(timer); resolve();}}, 5);
        const timer = setTimeout(() => {clearInterval(poll); reject(new Error('Timed out: ' + label));}, timeout);
    });
}
function spawn(label, dropReplies = false, selectedSupervisor = supervisor, role = 'ds_pool_worker') {
    const worker = cluster.fork({QUALIFICATION_WORKER_ROLE: role}); owned.push(worker);
    worker.id = 7; // The real master reuses this logical ID across distinct physical Worker objects.
    const messages = [], replies = [], requests = [];
    let stderr = '', stdout = '', exited = false, closed = false;
    const originalSend = worker.send.bind(worker); let droppedRegister = false, droppedEnd = false;
    const heldRegistrations = [];
    worker.send = (message, ...rest) => {
        if (message?.event === 'worker_attempt_reply') {
            replies.push(structuredClone(message)); transcript.push({owner: label, direction: 'parent-reply', message: structuredClone(message)});
            if (dropReplies === 'hold-register' && message.result?.challenge) {
                heldRegistrations.push(message); rest.find(value => typeof value === 'function')?.(null); return true;
            }
            const lose = dropReplies === 'all-register' && message.result?.challenge || dropReplies === 'all-end' && message.result?.end
                || dropReplies === true && (message.result?.challenge && !droppedRegister || message.result?.end && !droppedEnd);
            if (lose) {
                if (message.result?.challenge) droppedRegister = true; else droppedEnd = true;
                rest.find(value => typeof value === 'function')?.(null); return true;
            }
        }
        return originalSend(message, ...rest);
    };
    worker.on('message', message => {
        messages.push(message);
        if (message.event === 'worker_attempt_request') requests.push(structuredClone(message));
        transcript.push({owner: label, direction: 'child-message', message: structuredClone(message)});
    });
    worker.process.stdout.on('data', bytes => {stdout += bytes.toString();});
    worker.process.stderr.on('data', bytes => {stderr += bytes.toString();});
    worker.on('exit', () => {exited = true; transcript.push({owner: label, event: 'parent-observed-exit'});});
    worker.process.on('close', () => {closed = true;});
    selectedSupervisor.attach(worker, role);
    return {worker, messages, requests, replies,
        get stderr() {return stderr;}, get stdout() {return stdout;}, get exited() {return exited;}, get closed() {return closed;},
        phase: name => messages.find(message => message.event === 'qualification_phase' && message.phase === name),
        releaseRegistration: () => {for (const message of heldRegistrations.splice(0)) originalSend(message);},
        send: (command, fields = {}) => worker.send({event: 'qualification_command', command, ...fields})};
}

async function permanentlyLostResponses() {
    const noRegistration = spawn('unknown-registration', 'all-register');
    await waitFor(() => noRegistration.phase('ready'), 'unknown registration child ready'); noRegistration.send('start');
    await waitFor(() => noRegistration.phase('failed'), 'bounded exhausted registration replies');
    assert.equal(noRegistration.phase('body-entered'), undefined); assert.equal(noRegistration.phase('failed').data.attempt.masterEnd, null);
    const registrations = noRegistration.requests.filter(request => request.payload.operation === 'register');
    assert.equal(registrations.length, 3); for (const retry of registrations) assert.deepEqual(retry, registrations[0]);
    assert.equal(endEvidence.length, 0, 'a drained local wrapper cannot settle an unknown master registration');
    noRegistration.send('repeat'); await waitFor(() => noRegistration.phase('repeat-rejected'), 'unknown registration cannot rerun the root');
    assert.equal(noRegistration.phase('repeated-body'), undefined);
    noRegistration.send('quit'); await waitFor(() => noRegistration.exited && noRegistration.closed, 'unknown registration exact process cleanup');
    assert.equal(endEvidence.length, 1); const unresolved = describeWorkerAttemptEnd(supervisor, endEvidence[0]);
    assert.equal(unresolved.status, 'process-exited-unresolved'); assert.equal(unresolved.rootResult, 'unknown');
    assert.equal(noRegistration.stderr, '');

    const noEnd = spawn('unknown-end', 'all-end'); await waitFor(() => noEnd.phase('ready'), 'unknown end child ready'); noEnd.send('start');
    await waitFor(() => noEnd.phase('body-entered'), 'unknown end original root'); noEnd.send('finish-body'); noEnd.send('finish-finalizer');
    await waitFor(() => noEnd.phase('failed'), 'bounded exhausted end replies');
    assert.equal(noEnd.phase('done'), undefined); assert.equal(noEnd.phase('failed').data.attempt.masterEnd, null);
    assert.equal(noEnd.phase('failed').data.attempt.scope.state, 'drained');
    const endings = noEnd.requests.filter(request => request.payload.operation === 'end');
    assert.equal(endings.length, 3); for (const retry of endings) assert.deepEqual(retry, endings[0]);
    assert.equal(endEvidence.length, 2, 'the parent accepts one genuine end while the child still lacks its reply');
    assert.equal(describeWorkerAttemptEnd(supervisor, endEvidence[1]).status, 'quiescent');
    noEnd.send('repeat'); await waitFor(() => noEnd.phase('repeat-rejected'), 'unknown end cannot start another root');
    assert.equal(noEnd.phase('repeated-body'), undefined);
    noEnd.send('quit'); await waitFor(() => noEnd.exited && noEnd.closed, 'unknown end exact process cleanup');
    assert.equal(endEvidence.length, 2, 'exit must not issue another end for already genuinely drained work'); assert.equal(noEnd.stderr, '');
    cases.push({id: 'exhausted-registration-replies-never-start-root-or-mint-end', registrationRequests: 3, endedOnlyAtExactExit: true});
    cases.push({id: 'exhausted-end-replies-keep-child-unknown-with-one-parent-end', endRequests: 3, parentTransitions: 1, childAcceptedEnd: false});
}

async function exactRetryAndFinalizer() {
    const child = spawn('retry-owner', true); await waitFor(() => child.phase('ready'), 'owned child ready'); child.send('start');
    await waitFor(() => child.requests.some(request => request.payload.operation === 'register'), 'first original registration');
    assert.equal(child.phase('body-entered'), undefined, 'a send callback and lost registration reply cannot admit the processing root');
    assert.equal(endEvidence.length, 0);
    await waitFor(() => child.phase('body-entered'), 'exact registration retry accepted');
    const registrations = child.requests.filter(request => request.payload.operation === 'register');
    assert.equal(registrations.length, 2); assert.deepEqual(registrations[0], registrations[1]);
    child.send('finish-body'); await waitFor(() => child.phase('ack-attempted'), 'original ACK attempt marker');
    assert.equal(endEvidence.length, 0, 'ACK attempt alone cannot end held root finalizers');
    child.send('finish-finalizer'); await waitFor(() => child.phase('done'), 'lost end reply exact retry');
    const endings = child.requests.filter(request => request.payload.operation === 'end');
    assert.equal(endings.length, 2); assert.deepEqual(endings[0], endings[1]); assert.equal(endEvidence.length, 1);
    const end = describeWorkerAttemptEnd(supervisor, endEvidence[0]);
    assert.equal(end.status, 'quiescent'); assert.equal(end.acknowledgementAttempted, true); assert.equal(end.rootResult, 'returned');
    assert.deepEqual(end.binding, {}, 'physical custody must not invent source membership or an ordinal');
    assert.equal(child.phase('done').data.result, 'original-result');
    assert.throws(() => describeWorkerAttemptEnd(supervisor, structuredClone(endEvidence[0])), /Unissued or foreign/);
    assert.throws(() => describeWorkerAttemptEnd(new WorkerAttemptSupervisor(), endEvidence[0]), /Unissued or foreign/);
    // A new request nonce is a mismatched replay, even with every previous association copied exactly.
    const replay = structuredClone(endings[0]); replay.requestId = randomUUID();
    child.send('replay', {request: replay});
    await waitFor(() => child.replies.some(reply => reply.requestId === replay.requestId), 'mismatched replay rejection');
    assert.equal(child.replies.find(reply => reply.requestId === replay.requestId).result.ok, false); assert.equal(endEvidence.length, 1);
    cases.push({id: 'real-ipc-registration-and-end-exact-lost-response-retries', registrations: 2, endRequests: 2,
        acceptedEnds: 1, inventedSourceFields: 0, finalizersIncluded: true});
    child.send('quit'); await waitFor(() => child.exited && child.closed, 'owned retry child exit and pipe close'); assert.equal(child.stderr, '');
}

async function physicalDisconnectAndReplacement() {
    const old = spawn('disconnected-original'); await waitFor(() => old.phase('ready'), 'original child ready'); old.send('start');
    await waitFor(() => old.phase('body-entered'), 'original root holds real processing');
    const registration = old.requests.find(request => request.payload.operation === 'register');
    let terminationRequests = 0;
    old.worker.kill = () => {terminationRequests++; return old.worker;}; // Controlled failed termination; the original OS process remains real.
    old.send('disconnect');
    await waitFor(() => !old.worker.isConnected() && old.stdout.includes('OWNED_PROCESS_ALIVE_AFTER_IPC_DISCONNECT'), 'IPC disconnect while old process is demonstrably alive');
    assert.equal(old.worker.isDead(), false); process.kill(old.worker.process.pid, 0); assert.equal(endEvidence.length, 0);
    const replacement = spawn('replacement-same-id'); await waitFor(() => replacement.phase('ready'), 'replacement ready'); replacement.send('start');
    await waitFor(() => replacement.phase('body-entered'), 'replacement original root');
    assert.equal(old.worker.id, replacement.worker.id); assert.notEqual(old.worker, replacement.worker);
    assert.notEqual(old.worker.process.pid, replacement.worker.process.pid);
    assert.throws(() => supervisor.attach(replacement.worker, 'projection'), /physical attempt role/);
    const copied = structuredClone(registration); copied.requestId = randomUUID(); replacement.send('replay', {request: copied});
    await waitFor(() => replacement.replies.some(reply => reply.requestId === copied.requestId), 'cross-owner registration rejection');
    assert.equal(replacement.replies.find(reply => reply.requestId === copied.requestId).result.ok, false);
    const currentRegistration = replacement.requests.find(request => request.payload.operation === 'register');
    const currentReply = replacement.replies.find(reply => reply.requestId === currentRegistration.requestId).result;
    const mismatchedEnd = {event: 'worker_attempt_request', requestId: randomUUID(), payload: {
        ...currentRegistration.payload, operation: 'end', challenge: randomUUID(),
        descriptorSha256: currentReply.descriptorSha256, bindingSha256: workerAttemptDigest({}),
        summary: {acknowledgementAttempted: true, rootResult: 'returned'}}};
    replacement.send('replay', {request: mismatchedEnd});
    await waitFor(() => replacement.replies.some(reply => reply.requestId === mismatchedEnd.requestId), 'wrong challenge end rejection');
    assert.equal(replacement.replies.find(reply => reply.requestId === mismatchedEnd.requestId).result.ok, false);
    await waitFor(() => terminationRequests > 0, 'supervised termination request');
    assert.equal(old.worker.isDead(), false); assert.equal(endEvidence.length, 0, 'a failed kill call cannot prove exact-process death');
    replacement.send('finish-body'); replacement.send('finish-finalizer'); await waitFor(() => replacement.phase('done'), 'unrelated replacement completes');
    assert.equal(endEvidence.length, 1); assert.equal(describeWorkerAttemptEnd(supervisor, endEvidence[0]).status, 'quiescent');
    old.worker.process.kill();
    assert.equal(endEvidence.length, 1, 'requesting actual termination cannot synchronously issue an exit receipt');
    await waitFor(() => old.exited && old.closed, 'parent observes exact retired owner exit and full pipe close');
    assert.equal(endEvidence.length, 2);
    const death = describeWorkerAttemptEnd(supervisor, endEvidence[1]);
    assert.equal(death.status, 'process-exited-unresolved'); assert.equal(death.acknowledgementAttempted, null); assert.equal(death.rootResult, 'unknown');
    assert.deepEqual(death.binding, {}); assert.equal(old.stderr, '');
    const oldEndRequest = replacement.requests.find(request => request.payload.operation === 'end');
    replacement.send('quit'); await waitFor(() => replacement.exited && replacement.closed, 'replacement cleanup'); assert.equal(replacement.stderr, '');
    cases.push({id: 'real-disconnected-physical-owner-survives-reused-logical-id-and-failed-kill',
        terminationRequests, acceptedBeforeExactExit: 1, retiredExit: death.status, oldAcknowledgement: death.acknowledgementAttempted});

    const freshEnds = [], fresh = new WorkerAttemptSupervisor({onEnd: end => freshEnds.push(end), fenceTimeoutMs: 1000});
    const freshChild = spawn('fresh-parent-epoch', false, fresh);
    try {
        await waitFor(() => freshChild.phase('ready'), 'new epoch child ready'); freshChild.send('start');
        await waitFor(() => freshChild.phase('body-entered'), 'new epoch root');
        assert.notEqual(fresh.epoch, supervisor.epoch);
        const stale = structuredClone(oldEndRequest); stale.requestId = randomUUID(); freshChild.send('replay', {request: stale});
        await waitFor(() => freshChild.replies.some(reply => reply.requestId === stale.requestId), 'old epoch end rejection');
        assert.equal(freshChild.replies.find(reply => reply.requestId === stale.requestId).result.ok, false); assert.equal(freshEnds.length, 0);
        assert.throws(() => describeWorkerAttemptEnd(fresh, endEvidence[0]), /Unissued or foreign/);
        freshChild.send('finish-body'); freshChild.send('finish-finalizer'); await waitFor(() => freshChild.phase('done'), 'fresh parent unrelated progress');
        assert.equal(freshEnds.length, 1); assert.equal(describeWorkerAttemptEnd(fresh, freshEnds[0]).status, 'quiescent');
        freshChild.send('quit'); await waitFor(() => freshChild.exited && freshChild.closed, 'fresh epoch owned cleanup'); assert.equal(freshChild.stderr, '');
        cases.push({id: 'old-parent-epoch-and-end-copy-cannot-settle-fresh-owner', staleAccepted: false, freshAcceptedEnds: 1});
    } finally {fresh.stop();}
}

async function actualMainIngress() {
    for (const schedule of ['ordinary', 'queued-mutation', 'original-channel-close']) {
        const before = endEvidence.length;
        const child = spawn('actual-main-' + schedule, 'hold-register', supervisor, 'deserializer');
        await waitFor(() => child.phase('ready'), 'actual MainDS child ready');
        child.send('capture-role');
        await waitFor(() => child.phase('role-captured') && child.requests.some(request => request.payload.operation === 'register'),
            'actual original receipt registered before cargo');
        const registration = child.requests.find(request => request.payload.operation === 'register');
        assert.equal(registration.payload.descriptor.kind, 'source-delivery');
        assert.equal(registration.payload.descriptor.deliveryTag, 42);
        assert.equal(child.phase('role-parser-entered'), undefined);
        if (schedule === 'queued-mutation') {
            child.send('mutate-role'); await waitFor(() => child.phase('role-mutated'), 'queued original bytes changed');
        }
        child.send('run-role');
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(child.phase('role-parser-entered'), undefined, 'actual MainDS cannot enter its parser before the parent registration reply');
        assert.equal(endEvidence.length, before);
        child.releaseRegistration();
        if (schedule === 'queued-mutation') {
            await waitFor(() => child.phase('role-failed'), 'actual queued-byte mutation rejected');
            assert.match(child.phase('role-failed').data.message, /queued.*changed/);
            assert.equal(child.phase('role-parser-entered'), undefined);
        } else {
            await waitFor(() => child.phase('role-parser-entered'), 'parent accepted actual parser root');
            if (schedule === 'original-channel-close') {
                child.send('close-role'); await waitFor(() => child.phase('role-original-channel-closed'), 'actual original channel fenced');
            }
            child.send('finish-body'); await waitFor(() => child.phase('role-finalizer-entered'), 'actual parser finalizer held');
            assert.equal(endEvidence.length, before, 'MainDS ACK or local channel fencing cannot bypass the original parser finalizer');
            assert.equal(!!child.phase('role-ack-attempted'), schedule === 'ordinary');
            child.send('finish-finalizer');
            await waitFor(() => child.phase(schedule === 'ordinary' ? 'role-done' : 'role-failed'), 'actual MainDS root settled');
            assert.equal(child.phase('role-done')?.data.acks ?? child.phase('role-failed').data.acks, schedule === 'ordinary' ? 1 : 0);
        }
        assert.equal(endEvidence.length, before + 1);
        const end = describeWorkerAttemptEnd(supervisor, endEvidence.at(-1));
        assert.equal(end.role, 'deserializer'); assert.equal(end.status, 'quiescent');
        assert.equal(end.acknowledgementAttempted, schedule === 'ordinary');
        assert.equal(end.rootResult, schedule === 'ordinary' ? 'returned' : 'threw');
        assert.deepEqual(end.binding, {}, 'the real MainDS entry fixture provides physical custody only; no semantic membership may be invented');
        child.send('quit'); await waitFor(() => child.exited && child.closed, 'actual MainDS exact child cleanup'); assert.equal(child.stderr, '');
        cases.push({id: 'actual-main-ingress-' + schedule, controlledParserWorkOnly: true,
            parentAcceptedBeforeParser: true, ackAttempts: schedule === 'ordinary' ? 1 : 0, finalizersIncluded: schedule !== 'queued-mutation', inventedSemanticFields: 0});
    }
}

async function actualUnprocessableIngress() {
    const schedules = mode === 'headers' ? ['oversized', 'unsupported'] : ['unadmitted-raw'];
    for (const schedule of schedules) {
        const role = schedule === 'unadmitted-raw' ? 'ds_pool_worker' : 'deserializer', before = endEvidence.length;
        const child = spawn('actual-' + schedule, 'hold-register', supervisor, role);
        await waitFor(() => child.phase('ready'), 'unprocessable receipt child ready');
        child.send('capture-role', {headerKind: schedule});
        await waitFor(() => child.phase('role-captured') && child.requests.some(request => request.payload.operation === 'register'),
            'actual unprocessable physical receipt still registers');
        const registration = child.requests.find(request => request.payload.operation === 'register');
        assert.equal(registration.payload.descriptor.kind, role === 'deserializer' ? 'source-delivery' : 'ds-delivery');
        if (mode === 'headers') assert.equal(registration.payload.descriptor.headersSha256, null,
            'unavailable bounded typed header image is explicit; no fabricated fingerprint');
        child.send('run-role'); await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(child.phase('role-parser-entered'), undefined); assert.equal(endEvidence.length, before);
        child.releaseRegistration(); await waitFor(() => child.phase('role-failed'), 'actual unprocessable receipt refuses semantic processing');
        assert.equal(child.phase('role-failed').data.acks, 0); assert.equal(child.phase('role-parser-entered'), undefined);
        assert.match(child.phase('role-failed').data.message, /header|snapshot|admission|source|history|record|locator/i);
        assert.equal(endEvidence.length, before + 1); const end = describeWorkerAttemptEnd(supervisor, endEvidence.at(-1));
        assert.equal(end.role, role); assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, 'threw');
        assert.equal(end.acknowledgementAttempted, false); assert.deepEqual(end.binding, {});
        child.send('quit'); await waitFor(() => child.exited && child.closed, 'unprocessable actual role exact child cleanup'); assert.equal(child.stderr, '');
        cases.push({id: 'actual-physical-ingress-' + schedule, parentAcceptedPhysicalCustody: true, semanticProcessing: false,
            originalAcks: 0, inventedSourceMembership: false, constructedTypedHeaderBoundary: mode === 'headers'});
    }
}

try {
    if (mode === 'retry') await exactRetryAndFinalizer();
    else if (mode === 'disconnect') await physicalDisconnectAndReplacement();
    else if (mode === 'unknown') await permanentlyLostResponses();
    else if (mode === 'main-ingress') await actualMainIngress();
    else if (mode === 'headers' || mode === 'ds-unadmitted') await actualUnprocessableIngress();
    else assert.fail('unsupported IPC case');
    console.log(JSON.stringify({passed: true, mode, native: process.version, cases, transcript,
        ownedProcessesOnly: true, capacityAuthority: false, fullWorkerQualification: false}));
} finally {
    for (const worker of owned) if (!worker.isDead()) worker.process.kill();
    await waitFor(() => owned.every(worker => worker.isDead()), 'all owned child cleanup');
    supervisor.stop();
}
