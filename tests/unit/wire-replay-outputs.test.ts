import {describe, expect, it} from 'bun:test';
import {createHash} from 'node:crypto';
import type {AuditedWireReplayFixture} from '../../scripts/qualification/wire-replay-fixture.ts';
import {assertWireReplayOutputDocuments, assertWireReplayPublications, buildWireReplayExpectations,
    type WireReplayExpectations, type WireReplayOutputDocuments, type WireReplayPublication} from '../../scripts/qualification/wire-replay-outputs.ts';

// Constructed component records, never a captured source/ABI/worker authority. The native driver audits the real corpus separately.
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const id = (number: number) => number.toString(16).padStart(64, '0');
const clone = <T>(value: T): T => structuredClone(value);
const profile = {id: '@eosrio/hyperion-wire-plugin', profileId: 'wire-sysio-7dede884-engineering-v1', components: []};
const oldAbi = '0111', newAbi = '0222';
const meta = {version: 'component-abi', tables: [{name: 'rows', table_id: 300, type: 'entry',
    secondary_indexes: [{name: 'byowner', table_id: 37799, key_type: 'name'}]}]};

function fixture(): AuditedWireReplayFixture {
    const independentChecks: any[] = [], records: any[] = [], blocks: any[] = [], applications: any[] = [], kvEvents: any[] = [];
    const check = (name: string, result: any) => independentChecks.push({id: name, expected: {result}});
    const deployments = [{target: 'wiremap', globalSequence: '20', abiHex: oldAbi, abiSha256: hash(Buffer.from(oldAbi, 'hex'))},
        {target: 'wireupgrade', globalSequence: '155', abiHex: newAbi, abiSha256: hash(Buffer.from(newAbi, 'hex'))}];
    deployments.forEach(value => check(`abi-deployment-${value.target}-${value.globalSequence}`, meta));
    const accountRows: Record<number, {name: string; abi: string}> = {10: {name: 'wiremap', abi: oldAbi},
        11: {name: 'wireorder', abi: oldAbi}, 12: {name: 'wireinline', abi: oldAbi}, 13: {name: 'wireupgrade', abi: oldAbi},
        14: {name: 'wiresec', abi: oldAbi}, 117: {name: 'wireupgrade', abi: newAbi}};
    let sourceReceipts = 0;
    for (let blockNum = 2; blockNum <= 120; blockNum++) {
        const frame = Buffer.from(`component-only-${blockNum}`), blockId = id(blockNum), previousId = id(blockNum - 1);
        records.push({blockNum, id: blockId, previousId, frame, frameSha256: hash(frame)});
        blocks.push({blockNum, blockId}); check(`block-${blockNum}-signed`, {previous: previousId, timestamp: `2026-10-20T00:${String(blockNum).padStart(3, '0')}`, producer: 'sysio'});
        const actions: any[] = [];
        function action(ordinal: number, global: number, account: string, name: string, creator = 0,
            receiver = account, data = '', abiSequence = 1) {
            const value = {action_ordinal: ordinal, creator_action_ordinal: creator, receiver,
                act: {account, name, authorization: name === 'noop' ? [] : [{actor: account, permission: 'active'}], data},
                receipt: ['action_receipt_v0', {receiver, global_sequence: String(global), recv_sequence: String(global),
                    auth_sequence: name === 'noop' ? [] : [{account, sequence: String(global)}], act_digest: hash(account + name + data),
                    code_sequence: 1, abi_sequence: abiSequence}], return_value: ''};
            actions.push(['action_trace_v1', value]); return value;
        }
        if (blockNum === 2) action(1, 1, 'sysio', 'onblock');
        if (blockNum === 90) action(1, 120, 'wiremap', 'put', 0, 'wiremap', '01');
        if (blockNum === 108) {
            action(1, 139, 'wireorder', 'inlnotify', 0, 'wireorder', 'ab');
            action(2, 142, 'wireorder', 'notifyinl', 0, 'wireorder', 'ac');
            action(3, 141, 'wireinline', 'noop', 1);
            action(4, 140, 'wireorder', 'inlnotify', 1, 'wirenotify', 'ab');
            action(5, 143, 'wireorder', 'notifyinl', 2, 'wirenotify', 'ac');
            action(6, 144, 'wireinline', 'noop', 2);
        }
        if (blockNum === 111) action(1, 148, 'wireupgrade', 'put', 0, 'wireupgrade', '02');
        if (blockNum === 120) action(1, 160, 'wireupgrade', 'put', 0, 'wireupgrade', '03', 2);
        const trx = id(1000 + blockNum);
        for (const [, value] of actions) if (value.receiver === value.act.account && value.act.account !== 'sysio') {
            const global = value.receipt[1].global_sequence;
            applications.push({blockNum, transactionId: trx, actionOrdinal: value.action_ordinal, inputActionOrdinal: value.action_ordinal,
                account: value.act.account, name: value.act.name, rawHex: value.act.data, globalSequence: global,
                abiSha256: hash(Buffer.from(blockNum === 120 ? newAbi : oldAbi, 'hex'))});
            check('action-' + global, blockNum === 90 ? {id: '18446744073709551615', amount: '9007199254740993'}
                : blockNum === 120 ? {replacement: 'exact new layout'} : {});
        }
        sourceReceipts += actions.length; check(`block-${blockNum}-traces`, actions.length ? [['transaction_trace_v0', {id: trx, action_traces: actions}]] : []);
        const deltas: any[] = [];
        if (accountRows[blockNum]) {
            deltas.push(['table_delta_v0', {name: 'account', rows: [{present: true, data: '00'}]}]);
            check(`block-${blockNum}-row-0`, ['account_v0', accountRows[blockNum]]);
        }
        if ([90, 91, 96, 99].includes(blockNum)) {
            const primary = blockNum < 96, present = blockNum !== 91, tableId = primary ? 300 : 37799;
            const bytes = Buffer.alloc(19); bytes.writeBigUInt64LE(primary ? 11n : 12n, 1); bytes.writeBigUInt64LE(22n, 9); bytes.writeUInt16LE(tableId, 17);
            const key = primary ? 'ff00' : 'ab', pri = blockNum === 96 ? '01' : '02';
            const rawHex = Buffer.concat([bytes, Buffer.from(primary ? key + 'aa' : key + pri, 'hex')]).toString('hex');
            const stream = primary ? 'contract_row_kv' : 'contract_index_kv', code = primary ? 'wiremap' : 'wiresec';
            const decoded = {code, payer: 'wiremap', table_id: tableId,
                ...(primary ? {key, value: present ? 'aa' : ''} : {sec_key: key, pri_key: pri})};
            deltas.push(['table_delta_v0', {name: stream, rows: [{present, data: rawHex}]}]);
            kvEvents.push({blockNum, deltaOrdinal: 0, present, rawHex, decoded: [primary ? 'contract_row_kv_v0' : 'contract_index_kv_v0', decoded]});
            if (primary && present) check(`kv-value-${blockNum}-0`, {amount: '9007199254740993'});
        }
        check(`block-${blockNum}-deltas-compat`, {deltas});
    }
    return {chainId: id(999), profileId: profile.profileId, replayStart: 2, replayEnd: 120, independentChecks, records,
        audit: {blocks, actionReceiptCount: sourceReceipts, abiDeployments: deployments, applicationActions: applications, kvEvents}} as unknown as AuditedWireReplayFixture;
}

function documents(expected: WireReplayExpectations): WireReplayOutputDocuments {
    const accountStates: Record<string, any> = {}, kvStates: Record<string, any> = {};
    const commits = expected.blocks.map((block, index) => ({id: 'commit-' + block.blockNum, value: {schemaVersion: 1, chainId: expected.chainId,
        profile, source: {chainId: expected.chainId, blockNum: block.blockNum, blockId: block.blockId, previousBlockId: block.previousId},
        previousCommitId: index ? 'commit-' + (block.blockNum - 1) : null, selectionId: 'h45srcsel1:' + id(block.blockNum),
        observationId: 'observation-' + block.blockNum, observationDigest: id(block.blockNum + 400), status: 'complete', reason: null,
        stateRootId: 'root-' + block.blockNum, bindings: expected.bindings[String(block.blockNum)].map(binding => {
            const action = expected.actions.find(row => row.blockNum === block.blockNum && row.transactionId === binding.transactionId && row.actionOrdinal === binding.inputActionOrdinal);
            const stateId = action ? 'state-' + block.blockNum + '-' + action.account : null;
            if (stateId && action) accountStates[stateId] = {account: action.account, present: true, abiHex: block.blockNum === 120 ? newAbi : oldAbi,
                protocol: profile, source: {chainId: expected.chainId, blockNum: block.blockNum}};
            return {...binding, stateId};
        })}}));
    const actions = expected.actions.map(row => ({_id: row.globalSequence, _index: 'owned-action-v1-000001', _source: {
        global_sequence: row.globalSequence, block_num: row.blockNum, block_id: row.blockId, trx_id: row.transactionId,
        action_ordinal: row.actionOrdinal, creator_action_ordinal: row.creatorActionOrdinal, '@timestamp': row.timestamp, producer: row.producer,
        act: {account: row.account, name: row.name, authorization: clone(row.authorization), data: clone(row.data)},
        act_digest: row.act_digest, abi_sequence: row.abi_sequence, code_sequence: row.code_sequence, receipts: clone(row.receipts),
        ...(row.returnHex ? {return_value: row.returnHex} : {}), protocol: {schemaVersion: 1,
            source: {chainId: expected.chainId, blockNum: row.blockNum, blockId: row.blockId}, selectionId: 'h45srcsel1:' + id(row.blockNum),
            input: {transactionId: row.transactionId, actionOrdinal: row.actionOrdinal, inputActionOrdinal: row.inputActionOrdinal,
                receiver: row.account, account: row.account, name: row.name, rawHex: row.rawHex, globalSequence: row.globalSequence, receiptAbiSequence: String(row.abi_sequence)}},
        h45_sequences_v1: {version: 1, global: pair(row.globalSequence), code_sequence: row.code_sequence, abi_sequence: row.abi_sequence,
            receipts: row.receipts.map((value: any, index: number) => ({index, receiver: value.receiver, global: pair(value.global_sequence),
                receive: pair(value.recv_sequence), code_sequence: value.code_sequence, abi_sequence: value.abi_sequence,
                authorization: value.auth_sequence.map((auth: any, index: number) => ({index, account: auth.account, sequence: pair(auth.sequence)}))}))},
    }}));
    const deltas = expected.deltas.map(row => {
        kvStates[row.blockNum + ':' + row.code] = {account: row.code, present: true, protocol: profile, abiHex: oldAbi, source: {blockNum: row.abiBlock}};
        return {_id: row.id, _index: 'owned-delta-v1-000001', _source: {'@timestamp': row.timestamp, block_num: row.blockNum, block_id: row.blockId,
            code: row.code, scope: '', table: row.table, primary_key: row.primaryKey, payer: row.payer, present: row.present ? 1 : 0, data: clone(row.data),
            protocol: {id: profile.id, profileId: expected.profileId, logicalIdentity: row.identity, record: clone(row.record), source: clone(row.source),
                rawHex: row.rawHex, metadata: clone(row.metadata)}}};
    });
    const abis = expected.abis.map(row => ({_id: String(row.block) + row.account, _index: 'owned-abi-v1', _source: {
        account: row.account, block: row.block, block_id: row.block_id, ordinal: row.ordinal, abi_hex: row.abi_hex,
        abi_available: row.abi_available, abi_error: '', abi: JSON.stringify(row.abiMetadata)}}));
    const blocks = expected.blocks.map(row => ({_id: String(row.blockNum), _index: 'owned-block-v1-000001', _source: {
        block_num: row.blockNum, block_id: row.blockId, prev_id: row.previousId, '@timestamp': row.timestamp, producer: row.producer}}));
    const tip = expected.blocks.at(-1)!;
    const coordinator = {chainId: expected.chainId, profile, ownerId: 'fixture-owner', generation: 1, phase: 'following', gap: null, pending: [],
        head: {blockNum: tip.blockNum, blockId: tip.blockId, commitId: 'commit-' + tip.blockNum, stateRootId: 'root-' + tip.blockNum, coverageStart: 2}};
    const certificate = {schemaVersion: 1, kind: 'settled-abi-head', chainId: expected.chainId, profile, ownerId: coordinator.ownerId,
        generation: coordinator.generation, head: coordinator.head};
    return clone({actions, blocks, deltas, abis, commits, coordinator, certificate, accountStates, kvStates});
}
const pair = (value: string) => ({value, key: value.padStart(20, '0')});
function publications(value: WireReplayOutputDocuments): WireReplayPublication[] {
    return (['actions', 'blocks', 'deltas', 'abis'] as const).flatMap(kind => value[kind].map(row => ({operation: 'index', index: row._index!,
        id: row._id, source: clone(row._source), receiptNumber: 1, itemStatus: 201})));
}
function ready() {const source = fixture(), expected = buildWireReplayExpectations(source, 'owned'); return {source, expected, actual: documents(expected)};}

describe('Wire replay output qualification guards (constructed component records)', () => {
    it('keeps identical inline inputs separate and retains both notifications', () => {
        const {expected, actual} = ready();
        expect(expected.actions.filter(row => row.blockNum === 108).map(row => [row.globalSequence, row.receipts.length]))
            .toEqual([['139', 2], ['142', 2], ['141', 1], ['144', 1]]);
        const result = assertWireReplayOutputDocuments(expected, actual);
        expect(result).toMatchObject({blocks: 119, actions: 7, actionReceipts: 9, sourceBindings: 10, historyDeltas: 4,
            primaryHistoryTombstones: 1, secondaryHistoryTombstones: 0, coordinatorCommits: 119});
        expect(result.gaps.join(' ')).toContain('contract_state remains disabled');
        expect(actual.actions.find(row => row._id === '120')!._source.act.data).toEqual({id: '18446744073709551615', amount: '9007199254740993'});
    });
    it('uses independent observations, never the selected decoder view, and detaches inputs', () => {
        const source = fixture(); (source.records[0] as any).traces = [['deliberately false decoded view']];
        const expected = buildWireReplayExpectations(source, 'owned');
        expect(Object.isFrozen(expected.actions[0].data)).toBe(true);
        expect(Object.isFrozen(source.independentChecks)).toBe(false);
        const observation = source.independentChecks.find(row => row.id === 'action-120'); observation.expected.result.amount = 'mutated';
        expect(expected.actions[0].data.amount).toBe('9007199254740993');
    });
    it.each(['receipt', 'inline', 'extra', 'duplicate'] as const)('rejects incorrect grouped membership: %s', mode => {
        const {expected, actual} = ready();
        if (mode === 'receipt') actual.actions.find(row => row._id === '139')!._source.receipts.pop();
        if (mode === 'inline') (actual.actions as any[]).splice(actual.actions.findIndex(row => row._id === '144'), 1);
        if (mode === 'extra') (actual.actions as any[]).push({...clone(actual.actions[0]), _id: 'invented'});
        if (mode === 'duplicate') (actual.actions as any[]).push(clone(actual.actions[0]));
        expect(() => assertWireReplayOutputDocuments(expected, actual)).toThrow();
    });
    it.each(['rounded amount', 'rounded receipt', 'physical pair', 'raw proof', 'selection', 'incomplete'] as const)('rejects wrong exact action output: %s', mode => {
        const {expected, actual} = ready(), action = actual.actions.find(row => row._id === '120')!._source;
        if (mode === 'rounded amount') action.act.data.amount = 9007199254740992;
        if (mode === 'rounded receipt') action.receipts[0].recv_sequence = 120;
        if (mode === 'physical pair') action.h45_sequences_v1.receipts[0].global.key = '120';
        if (mode === 'raw proof') action.protocol.input.rawHex = '02';
        if (mode === 'selection') action.protocol.selectionId = 'h45srcsel1:' + id(10);
        if (mode === 'incomplete') action.protocol.status = 'incomplete';
        expect(() => assertWireReplayOutputDocuments(expected, actual)).toThrow();
    });
    it.each(['ABI epoch', 'missing ABI', 'corrupt ABI', 'block linkage', 'missing binding', 'binding input', 'unsettled', 'certificate', 'namespace'] as const)('rejects wrong coordinator/source evidence: %s', mode => {
        const {expected, actual} = ready();
        if (mode === 'ABI epoch') actual.accountStates['state-120-wireupgrade'].abiHex = oldAbi;
        if (mode === 'missing ABI') delete (actual.accountStates as any)['state-111-wireupgrade'];
        if (mode === 'corrupt ABI') actual.abis[0]._source.abi_hex = 'ff';
        if (mode === 'block linkage') actual.commits[30].value.previousCommitId = null;
        if (mode === 'missing binding') actual.commits.find(row => row.value.source.blockNum === 2)!.value.bindings = [];
        if (mode === 'binding input') actual.commits.find(row => row.value.source.blockNum === 108)!.value.bindings[0].rawSha256 = id(5);
        if (mode === 'unsettled') actual.coordinator.phase = 'recovering';
        if (mode === 'certificate') actual.certificate.generation++;
        if (mode === 'namespace') actual.actions[0]._index = 'unrelated-action-v1-000001';
        expect(() => assertWireReplayOutputDocuments(expected, actual)).toThrow();
    });
    it.each(['identity', 'payer', 'source', 'tombstone', 'value', 'numeric table', 'ABI binding'] as const)('rejects wrong KV output: %s', mode => {
        const {expected, actual} = ready(), first = actual.deltas[0]._source;
        if (mode === 'identity') first.primary_key = actual.deltas[1]._id;
        if (mode === 'payer') first.payer = 'wiresec';
        if (mode === 'source') first.protocol.source.ordinal++;
        if (mode === 'tombstone') actual.deltas[1]._source.present = 1;
        if (mode === 'value') first.data.amount = 9007199254740992;
        if (mode === 'numeric table') first.protocol.record.tableId++;
        if (mode === 'ABI binding') actual.kvStates['90:wiremap'].source.blockNum++;
        expect(() => assertWireReplayOutputDocuments(expected, actual)).toThrow();
    });
    it('distinguishes both secondary primary suffixes and repeated primary history versions', () => {
        const {expected} = ready(), primary = expected.deltas.filter(row => row.stream === 'contract_row_kv'), secondary = expected.deltas.filter(row => row.stream === 'contract_index_kv');
        expect(primary[0].primaryKey).toBe(primary[1].primaryKey); expect(primary[0].id).not.toBe(primary[1].id);
        expect(secondary[0].primaryKey).not.toBe(secondary[1].primaryKey); expect(secondary[0].record.secondaryKeyHex).toBe(secondary[1].record.secondaryKeyHex);
        expect(secondary.map(row => row.record.primaryKeyHex)).toEqual(['01', '02']);
    });
    it('requires complete successful publication coverage but retains failed/retried attempts', () => {
        const {expected, actual} = ready(), ledger = publications(actual), failed = {...clone(ledger[0]), receiptNumber: 2, itemStatus: 429, error: {type: 'rejected'}};
        expect(assertWireReplayPublications(expected, [failed, ...ledger])).toMatchObject({attempts: ledger.length + 1,
            uniqueSuccessfulActions: 7, uniqueSuccessfulHistoryDeltas: 4, actualElasticsearchDeletesCertified: false});
        expect(() => assertWireReplayPublications(expected, [failed, ...ledger.slice(1)])).toThrow();
        failed.source!.act.data = {modified: true}; expect(() => assertWireReplayPublications(expected, [failed, ...ledger])).toThrow();
    });
    it.each(['bodyless', 'delete', 'unfinished', 'unknown group', 'unowned'] as const)('rejects invalid original publication: %s', mode => {
        const {expected, actual} = ready(), ledger = publications(actual);
        if (mode === 'bodyless') delete ledger[0].source;
        if (mode === 'delete') ledger.find(row => row.index.includes('-delta-'))!.operation = 'delete';
        if (mode === 'unfinished') delete ledger[0].itemStatus;
        if (mode === 'unknown group') ledger[0].id = '9999';
        if (mode === 'unowned') ledger[0].index = 'unrelated-action-v1-000001';
        expect(() => assertWireReplayPublications(expected, ledger)).toThrow();
    });
    it.each(['missing observation', 'tampered bytes', 'extra application', 'unknown ABI', 'secondary tombstone', 'rounded source', 'duplicate block'] as const)('fails closed on invalid independent source membership: %s', mode => {
        const source = fixture();
        if (mode === 'missing observation') (source.independentChecks as any[]).splice(source.independentChecks.findIndex(row => row.id === 'action-141'), 1);
        if (mode === 'tampered bytes') source.records[0].frame[0] ^= 1;
        if (mode === 'extra application') source.audit.applicationActions.push({...source.audit.applicationActions[0], globalSequence: '1000'});
        if (mode === 'unknown ABI') source.audit.abiDeployments = [];
        if (mode === 'secondary tombstone') {
            source.audit.kvEvents.find((row: any) => row.blockNum === 96).present = false;
            source.independentChecks.find(row => row.id === 'block-96-deltas-compat').expected.result.deltas[0][1].rows[0].present = false;
        }
        if (mode === 'rounded source') source.independentChecks.find(row => row.id === 'block-90-traces').expected.result[0][1].action_traces[0][1].receipt[1].global_sequence = 9007199254740992;
        if (mode === 'duplicate block') (source.records as any[])[1] = source.records[0];
        expect(() => buildWireReplayExpectations(source)).toThrow();
    });
});
