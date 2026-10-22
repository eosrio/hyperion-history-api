import { cargo, queue } from "async";
import { Channel, ConsumeMessage, Message } from "amqplib";
import { join, resolve } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import { Redis, RedisValue } from "ioredis";

import { debugLog, hLog } from "../helpers/common_functions.js";
import { RabbitQueueDef } from "../definitions/index-queues.js";
import { ActionTrace } from "../../interfaces/action-trace.js";
import { HyperionWorker } from "./hyperionWorker.js";
import { HyperionActionAct } from "../../interfaces/hyperion-action.js";
import { ABI, Action, Serializer } from "@wharfkit/antelope";
import { HyperionAbi } from "../../interfaces/hyperion-abi.js";
import { groupActionTraces } from "../helpers/action-dedup.js";
import {assertCompleteProtocolSearch} from '../protocol/search.js';
import {protocolBytes} from '../protocol/contract-cache.js';
import {protocolSourceSelectionHeader} from '../protocol/source-bindings.js';
import {ProtocolAbiFrontierStore} from '../protocol/abi-frontier-store.js';
import {ProtocolNativeObservationStore} from '../protocol/native-observation-store.js';
import {ProtocolNativeActionReader, ProtocolNativeActionUnavailableError,
    type ProtocolNativeActionView, type ProtocolNativeActionGrant} from '../protocol/native-authorization.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError, type ProtocolAbiProofView,
    type ProtocolActionMetadata, type ProtocolActionSourceMetadata} from '../protocol/abi-proof.js';
import type {TrxMetadata} from '../../interfaces/trx-metadata.js';
import {normalizeActionSequences} from '../helpers/action-sequences.js';
import {compatibleUint64, compareUint64} from '../helpers/uint64.js';
import {transactionSequenceCacheKey} from '../helpers/transaction-cache.js';
import {actionSourceAdmissionHeader, type ActionSourceAdmission} from '../history/action-source-admission.js';
import {actionProducerEpoch, currentActionConfiguration} from '../history/action-producer-epoch.js';
import {actionHistoryImmutableJson} from '../history/action-history-manifest.js';
import {ActionSourceInventoryError} from '../history/action-source-inventory.js';
import type {ActionPublicationOwner} from '../history/action-confirmed-publication.js';
import {createHash} from 'node:crypto';
import type {ProtocolAbiActionInput} from '@eosrio/hyperion-sdk/protocol';

interface ProtocolActionWork {
    original: ActionTrace;
    metadata: ProtocolActionMetadata;
    view?: ProtocolAbiProofView;
    native?: {view: ProtocolNativeActionView; grant: ProtocolNativeActionGrant};
    nativeIncomplete?: {view: ProtocolNativeActionView; input: ProtocolAbiActionInput};
}

type ActionAbiIdentity =
    | {kind: "historical"; block: number; hex: string}
    | {kind: "custom"; abi: string; startingBlock: number; endingBlock: number};

interface CustomAbiDef {
    abi: string;
    startingBlock: number;
    endingBlock: number;
}

function cleanActionTrace(t: any) {
    try {
        if (t.return_value === '') {
            delete t.return_value;
        }
        if (t.context_free === false) {
            delete t.context_free;
        }
        if (t.elapsed === '0') {
            delete t.elapsed;
        }

        // remove act_digest from grouped receipts since it was written to the action
        if (t.receipts && t.receipts.length > 0) {
            t.act_digest = t.receipts[0].act_digest;
            for (let receipt of t.receipts) {
                delete receipt.act_digest;
            }
        } else {
            delete t.receipts;
        }

        delete t.receiver;

        // onblock action case
        if (t.signatures && t.signatures.length === 0) {
            delete t.signatures;
        }

        if (t.inline_count === 0) {
            delete t.inline_count;
        }

        if (t.net_usage_words === 0) {
            delete t.net_usage_words;
        }
    } catch (e) {
        console.log(e);
    }
}

function detachAdmittedActionBatch(actions: readonly unknown[]): any[] {
    try {return JSON.parse(actionHistoryImmutableJson(actions));} catch (error) {
        throw new ActionSourceInventoryError('Final action batch is not portable: ' + (error instanceof Error ? error.message : String(error)));
    }
}

export default class DSPoolWorker extends HyperionWorker {
    private actionHookFailure?: {error: unknown};
    noteActionHookFailure(error: unknown): void {this.actionHookFailure = {error};}
    private activeActionAdmission?: {admission: ActionSourceAdmission; traceOrdinal: number; payload: Buffer;
        headers: Message['properties']['headers']; configuration: string; owner: ActionPublicationOwner; fragmentId?: string};


    shipABI: string | undefined;

    types;
    tables: Map<string, string> = new Map();
    local_queue;
    consumerQueue;
    preIndexingQueue;
    temp_ds_counter = 0;
    act_emit_idx = 1;
    allowStreaming = false;
    // common functions
    common;
    totalHits = 0;
    // contract usage map (temporary)
    contractUsage = {};
    contracts: Map<string, {
        contract: ABI;
        valid_until: number;
        valid_from: number;
    }> = new Map();
    monitoringLoop?: NodeJS.Timeout;
    actionDsCounter = 0;

    customAbiMap: Map<string, CustomAbiDef[]> = new Map();
    private noActionCounter = 0;
    private protocolProofReader?: ProtocolAbiProofReader;
    private protocolNativeReader?: ProtocolNativeActionReader;
    private protocolTrace?: {view?: ProtocolAbiProofView; nativeView?: ProtocolNativeActionView;
        error?: ProtocolAbiProofUnavailableError | ProtocolNativeActionUnavailableError};
    private protocolActions = new WeakMap<ActionTrace, ProtocolActionWork>();
    private protocolCacheViews = new Set<ProtocolAbiProofView>();
    private protocolNativeCacheEntries = new Set<{work: ProtocolActionWork; payload: Buffer}>();
    private protocolDeliveryNativeEntries?: Set<{work: ProtocolActionWork; payload: Buffer}>;
    private readonly protocolDeliveryOwners = new WeakMap<Message, Channel>();
    private activeProtocolDelivery?: {message: Message; channel: Channel};

    // tx caching layer
    private readonly ioRedisClient: Redis;
    txCacheExpiration = 3600;

    constructor() {
        super();

        this.ioRedisClient = new Redis(this.manager.conn.redis);
        if (this.conf.api.tx_cache_expiration_sec) {
            if (typeof this.conf.api.tx_cache_expiration_sec === 'string') {
                this.txCacheExpiration = parseInt(this.conf.api.tx_cache_expiration_sec, 10);
            } else {
                this.txCacheExpiration = this.conf.api.tx_cache_expiration_sec;
            }
        }

        this.consumerQueue = cargo((payload: ConsumeMessage[], cb) => {
            // hLog(`Processing ${payload.length} messages`);
            this.processMessages(payload).then(() => cb()).catch((err) => {
                if (this.usesExtensionProtocol || this.actionSourceAdmissionEnabled) {
                    hLog('Protocol action processing failed; supervised replacement required:', err.message);
                    this.ch_ready = false;
                    this.consumerQueue.kill();
                    return process.exit(1);
                }
                hLog('NackAll:', err);
                if (this.ch && this.ch_ready) {
                    try {
                        this.ch.nackAll();
                    } catch (e: any) {
                        hLog(e.message);
                    }
                }
                cb();
            });
        }, this.conf.prefetch.block);

        this.preIndexingQueue = queue((data: any, cb) => {
            if (this.ch_ready && this.ch) {
                try {
                    this.ch.sendToQueue(data.queue, data.content, { headers: data.headers });
                } catch (e: any) {
                    hLog(e.message);
                }
                cb();
            } else {
                hLog('Channel is not ready!');
            }
        }, 1);

        this.processCustomABI();

        // Define Common Functions
        this.common = {
            attachActionExtras: this.attachActionExtras,
            deserializeActionAtBlockNative: this.deserializeActionAtBlockNative
        }
    }

    processCustomABI() {
        if (this.conf.settings.allow_custom_abi) {

            if (!this.customAbiMap) {
                this.customAbiMap = new Map<string, CustomAbiDef[]>();
            }

            const dir = join(resolve(), "custom-abi", this.chain);
            if (existsSync(dir)) {
                const files = readdirSync(dir);
                for (const abiFile of files) {
                    try {
                        const [code, startingBlock, suffix] = abiFile.split("-");
                        const endingBlock = suffix.split(".")[0];
                        hLog(`Custom ABI for ${code} from ${startingBlock} up to ${endingBlock}`);
                        const parsedAbi = readFileSync(join(dir, abiFile)).toString();
                        const def: CustomAbiDef = {
                            abi: parsedAbi,
                            startingBlock: parseInt(startingBlock),
                            endingBlock: parseInt(endingBlock)
                        };

                        if (!this.customAbiMap.has(code)) {
                            this.customAbiMap.set(code, [def]);
                        } else {
                            this.customAbiMap.get(code)?.push(def);
                        }

                    } catch (e: any) {
                        hLog(e.message);
                    }
                }
            }
        }
    }

    async attachActionExtras(self: DSPoolWorker, action: ActionTrace): Promise<void> {
        await self.mLoader.processActionData(action);
    }

    recordContractUsage(code: string) {
        // console.log(this.totalHits, this.actionDsCounter, this.monitoringLoop);
        this.totalHits++;
        if (this.contractUsage[code]) {
            this.contractUsage[code]++;
        } else {
            this.contractUsage[code] = 1;
        }
    }

    /** Per-cargo ABI-lookup memo (cleared each batch in processMessages). At
     *  mainnet density the same (contract, block) ABI is fetched once per action
     *  of that contract; the ES result is deterministic, so caching it per batch
     *  is format-safe. */
    private poolAbiCache = new Map<string, any>();
    /** Per-cargo type-resolution memo, keyed (field|contract|type|block). Skips
     *  repeated getAbiDataType native calls; block in the key keeps it correct. */
    private poolTypeCache = new Map<string, [boolean, string]>();
    // Native contexts are mutable per contract. A cached type name alone does
    // not prove that the ABI currently loaded belongs to this action's block.
    private loadedActionAbis = new Map<string, ActionAbiIdentity>();

    private clearTypeCacheForContract(contract: string) {
        for (const key of this.poolTypeCache.keys()) {
            if (key.split('|')[1] === contract) this.poolTypeCache.delete(key);
        }
    }

    async fetchAbiHexAtBlockElastic(
        contract_name: string,
        last_block: number,
        get_json: boolean,
        fetch_offset: number
    ) {
        const cacheKey = contract_name + '|' + last_block + '|' + (get_json ? 'j' : 'h') + '|' + fetch_offset;
        const cached = this.poolAbiCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
        const stopAbiFetch = this.profiler.start('fetch_abi_es');
        try {
            const _includes = ["block", "actions", "tables"];
            if (this.usesExtensionProtocol) _includes.push('account', 'block_id', 'protocol_profile', 'ordinal');
            if (get_json) {
                _includes.push("abi");
            } else {
                _includes.push("abi_hex");
            }
            // const t_start = process.hrtime.bigint();
            const queryResult = await this.client.search<any>({
                index: `${this.chain}-abi-*`,
                size: (this.usesExtensionProtocol ? 2 : 1) + fetch_offset,
                query: {
                    bool: {
                        must: [
                            { term: { account: contract_name } },
                            { range: { block: { lte: last_block } } }
                        ]
                    }
                },
                sort: [{ block: { order: "desc" } }],
                _source: { includes: _includes }
            });
            // const t_end = process.hrtime.bigint();
            if (this.usesExtensionProtocol) {
                assertCompleteProtocolSearch(queryResult);
            }
            const results = queryResult.hits.hits;
            if (this.usesExtensionProtocol) {
                if (results[1]?._source?.block === results[0]?._source?.block && results.length > 1) {
                    throw new Error('Protocol action ABI deployment is ambiguous');
                }
            }
            // const duration = (Number(t_end - t_start) / 1000 / 1000).toFixed(2);
            let result: any;
            if (results.length > 0) {
                // hLog(`fetch abi from elastic took: ${duration} ms`);
                result = results[fetch_offset]._source;
            } else {
                result = null;
            }
            this.poolAbiCache.set(cacheKey, result);
            return result;
        } catch (e) {
            if (this.usesExtensionProtocol) throw e;
            hLog(e);
            return null;
        } finally {
            stopAbiFetch();
        }
    }

    private clearActionAbiContext(contract: string) {
        this.loadedActionAbis.delete(contract);
        this.clearTypeCacheForContract(contract);
        this.abieos.deleteContract(contract);
    }

    private loadActionAbi(contract: string, identity: ActionAbiIdentity, load: () => boolean): boolean {
        const loaded = this.loadedActionAbis.get(contract);
        const matches = loaded?.kind === "custom" && identity.kind === "custom"
            ? loaded.abi === identity.abi && loaded.startingBlock === identity.startingBlock && loaded.endingBlock === identity.endingBlock
            : loaded?.kind === "historical" && identity.kind === "historical"
                && loaded.block === identity.block && loaded.hex === identity.hex;
        if (matches) return true;

        // A rejecting native loader may still replace part of its mutable
        // contract context. Never retain that context or a previously cached type.
        this.clearActionAbiContext(contract);
        try {
            if (load()) {
                this.loadedActionAbis.set(contract, identity);
                return true;
            }
        } catch (error: any) {
            debugLog(`Failed to load ${identity.kind} ABI for ${contract}: ${error.message}`);
        }
        this.clearActionAbiContext(contract);
        return false;
    }

    async verifyLocalType(contract: string, type: string, block_num: number, field: string): Promise<[boolean, string]> {
        if (this.usesExtensionProtocol) {
            this.clearActionAbiContext(contract);
            return [false, ''];
        }
        const vkey = field + '|' + contract + '|' + type + '|' + block_num;
        const resolveLoadedType = (): string => {
            const cached = this.poolTypeCache.get(vkey);
            if (cached?.[0]) return cached[1];
            const resultType = this.getAbiDataType(field, contract, type);
            if (resultType) this.poolTypeCache.set(vkey, [true, resultType]);
            return resultType;
        };

        // Explicit operator overrides precede historical schemas even when both
        // schemas declare the action. Preserve the existing exclusive bounds.
        const custom = this.conf.settings.allow_custom_abi
            ? this.customAbiMap.get(contract)?.find(entry => entry.startingBlock < block_num && entry.endingBlock > block_num)
            : undefined;
        if (custom?.abi && this.loadActionAbi(contract, {kind: "custom", abi: custom.abi,
            startingBlock: custom.startingBlock, endingBlock: custom.endingBlock}, () => this.abieos.loadAbi(contract, custom.abi))) {
            const resultType = resolveLoadedType();
            if (resultType) return [true, resultType];
        }

        const historical = await this.fetchAbiHexAtBlockElastic(contract, block_num, false, 0);
        if (historical?.abi_hex && this.loadActionAbi(contract,
            {kind: "historical", block: historical.block, hex: historical.abi_hex},
            () => this.loadAbiHex(contract, historical.block, historical.abi_hex))) {
            const resultType = resolveLoadedType();
            if (resultType) return [true, resultType];
        }

        // Missing/rejected historical ABIs retain the existing current fallback.
        // Its unknown deployment identity must never stand in for a historical
        // or custom selection on the next action.
        this.clearActionAbiContext(contract);
        let resultType = '';
        try {
            if (await this.loadCurrentAbiHex(contract)) resultType = this.getAbiDataType(field, contract, type);
        } catch (error: any) {
            debugLog(`(abieos/current) >> ${error.message}`);
        }
        if (!resultType) this.clearActionAbiContext(contract);
        const result: [boolean, string] = [!!resultType, resultType];
        this.poolTypeCache.set(vkey, result);
        return result;
    }

    async deserializeActionAtBlockNative(self: DSPoolWorker, action: HyperionActionAct, block_num: number): Promise<any> {
        self.recordContractUsage(action.account);
        const [_status, actionType] = await self.verifyLocalType(action.account, action.name, block_num, "action");
        if (_status && actionType) {
            const stopAbieos = self.profiler.start('abieos_deserialization');
            try {
                return self.abieos.binToJson(action.account, actionType, Buffer.from(action.data, 'hex'));
            } catch (e: any) {
                debugLog(`(abieos) ${action.account}::${action.name} (type: "${actionType}") @ ${block_num} >>> ${e.message}`);
            } finally {
                stopAbieos();
            }
        }
        return self.deserializeActionAtBlock(action, block_num);
    }

    async getContractAtBlock(accountName: string, block_num: number, check_action: string): Promise<ABI | null> {
        if (this.usesExtensionProtocol) return null;

        // recover ABI from cache
        if (this.contracts.has(accountName)) {
            let _sc = this.contracts.get(accountName);
            if (_sc) {
                if ((_sc.valid_until > block_num && block_num > _sc.valid_from) || _sc.valid_until === -1) {
                    if (_sc.contract.actions.find(value => value.name === check_action)) {
                        return _sc.contract;
                    }
                }
            }
        }

        let savedAbi: HyperionAbi | null;
        let abi: ABI;
        savedAbi = await this.fetchAbiHexAtBlockElastic(accountName, block_num, true, 0);
        if (savedAbi === null || (savedAbi.actions && !savedAbi.actions.includes(check_action))) {
            savedAbi = await this.getAbiFromHeadBlock(accountName);
            if (!savedAbi) {
                return null;
            }
            abi = ABI.from(savedAbi.abi)
        } else {
            try {
                abi = ABI.from(savedAbi.abi);
            } catch (e: any) {
                hLog('failed to parse abi at getContractAtBlock --> ' + e.message);
                return null;
            }
        }

        if (!abi) {
            return null;
        }


        if (check_action) {
            // check if the action is in the abi
            if (abi.getActionType(check_action)) {
                if (!this.failedAbiMap.has(accountName) || !this.failedAbiMap.get(accountName)?.has(-1)) {
                    try {
                        this.loadedActionAbis.delete(accountName);
                        this.clearTypeCacheForContract(accountName);
                        this.abieos.loadAbi(accountName, JSON.stringify(abi));
                    } catch (e:any) {
                        hLog(`failed to load abi for ${accountName} @ ${block_num} >>> ${e.message}`);
                    }
                } else {
                    debugLog('ignore reloading of current abi for', accountName);
                }
                this.contracts.set(accountName, {
                    contract: abi,
                    valid_until: savedAbi.valid_until ? savedAbi.valid_until : -1,
                    valid_from: savedAbi.valid_from ? savedAbi.valid_from : -1
                });
            }
        }
        return abi;
    }

    async deserializeActionAtBlock(action: HyperionActionAct, block_num: number): Promise<any | null> {
        if (this.usesExtensionProtocol) return null;
        const stopAntelope = this.profiler.start('antelope_deserialization');
        try {
            const contract = await this.getContractAtBlock(action.account, block_num, action.name);
            if (!contract) {
                return null;
            }
            try {
                const typedAction = Action.from(action);
                const decodedData = typedAction.decodeData(contract);
                return Serializer.objectify(decodedData);
            } catch (e: any) {
                debugLog(`(antelope) ${action.account}::${action.name} @ ${block_num} >>> ${e.message}`);
                return null;
            }
        } finally {
            stopAntelope();
        }
    }

    private getProtocolProofReader(): ProtocolAbiProofReader {
        return this.protocolProofReader ??= new ProtocolAbiProofReader({chainId: this.chainId,
            profile: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
            store: new ProtocolAbiFrontierStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0, {readOnly: true}),
            maxAncestryBlocks: this.conf.settings.protocol_abi_coordination?.recovery_window_blocks});
    }

    private getProtocolNativeReader(): ProtocolNativeActionReader {
        return this.protocolNativeReader ??= new ProtocolNativeActionReader({chainId: this.chainId,
            profile: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
            provider: this.protocol, proofReader: this.getProtocolProofReader(),
            store: new ProtocolNativeObservationStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0,
                undefined, {readOnly: true})});
    }

    /** Called before parser mutation; only the certified occurrence can select an ABI. */
    async deserializeProtocolAction(action: ActionTrace, transaction: TrxMetadata): Promise<void> {
        const receipt = Array.isArray(action.receipt) ? action.receipt[1] : action.receipt;
        const input = {transactionId: transaction.trx_id, actionOrdinal: action.action_ordinal,
            receiver: String((action as any).receiver ?? ''), account: action.act.account, name: action.act.name,
            rawHex: Buffer.from(protocolBytes(action.act.data)).toString('hex'),
            globalSequence: receipt?.global_sequence,
            receiptAbiSequence: Number.isSafeInteger(receipt?.abi_sequence) && receipt.abi_sequence >= 0 && receipt.abi_sequence <= 0xffffffff
                ? String(receipt.abi_sequence) : receipt?.abi_sequence};
        const metadata: ProtocolActionSourceMetadata = {schemaVersion: 1,
            source: {chainId: this.chainId, blockNum: Number(transaction.block_num), blockId: transaction.block_id},
            selectionId: transaction.protocolSelectionId ?? '', input, status: 'incomplete',
            error: {code: 'proof_unavailable', message: 'Canonical action ABI proof is unavailable'}};
        const work: ProtocolActionWork = {original: structuredClone(action), metadata, view: this.protocolTrace?.view};
        this.protocolActions ??= new WeakMap(); this.protocolActions.set(action, work);
        if (!work.view || this.protocolTrace?.error) {
            this.restoreProtocolAction(action, this.protocolTrace?.error ?? new ProtocolAbiProofUnavailableError('source_unbound', metadata.error.message)); return;
        }
        let selected;
        const stopProof = this.profiler.start('protocol_abi_action_proof');
        try {
            if (this.protocol.nativeActions) {
                const nativeView = this.protocolTrace?.nativeView;
                if (!nativeView) throw new ProtocolNativeActionUnavailableError('native_source_unavailable', 'Original native source is unavailable');
                const occurrence = await this.getProtocolProofReader().occurrence(work.view, input);
                const native = this.getProtocolNativeReader();
                const originalInput = {...input, inputActionOrdinal: occurrence.binding.inputActionOrdinal};
                const decision = await native.authorize(nativeView, originalInput);
                if (decision.kind === 'incomplete') {
                    work.nativeIncomplete = {view: nativeView, input: originalInput};
                    work.metadata = await native.incompleteMetadata(nativeView, originalInput);
                    this.restoreProtocolAction(action, new ProtocolNativeActionUnavailableError(decision.error.code, decision.error.message));
                    return;
                }
                if (decision.kind === 'native') {
                    work.native = {view: nativeView, grant: decision.grant};
                    work.metadata = await native.metadata(decision.grant);
                    action.act.data = await native.decodeValue(decision.grant);
                    action.protocol = structuredClone(work.metadata); delete action['ds_error'];
                    try {await this.common.attachActionExtras(this, action);} catch {
                        throw new ProtocolNativeActionUnavailableError('native_output_incomplete', 'Native action enrichment failed');
                    }
                    return;
                }
            }
            selected = await this.getProtocolProofReader().action(work.view, input);
        }
        catch (error) {
            if (!(error instanceof ProtocolAbiProofUnavailableError) && !(error instanceof ProtocolNativeActionUnavailableError)) {
                if (!work.native) throw error;
                this.restoreProtocolAction(action, new ProtocolNativeActionUnavailableError('native_output_incomplete', 'Native output is not portable or valid'));
                return;
            }
            this.restoreProtocolAction(action, error); return;
        } finally { stopProof(); }
        work.metadata = Object.freeze({schemaVersion: 1, source: Object.freeze({...metadata.source}), selectionId: metadata.selectionId,
            input: Object.freeze({...input, inputActionOrdinal: selected.binding.inputActionOrdinal})});
        try {
            const abi: any = this.protocol.contractCodec.decodeAbi(protocolBytes(selected.state.abiHex));
            const type = abi.actions?.find(entry => String(entry.name) === input.name)?.type;
            if (!type) throw new Error('Certified ABI has no action mapping');
            action.act.data = this.protocol.contractCodec.decodeValue(abi, type, protocolBytes(input.rawHex));
            action.protocol = work.metadata; delete action['ds_error'];
            await this.common.attachActionExtras(this, action);
        } catch (error: any) {
            this.restoreProtocolAction(action, new ProtocolAbiProofUnavailableError('protocol_action_abi_invalid', String(error?.message ?? error)));
        }
    }

    private restoreProtocolAction(action: ActionTrace, error: ProtocolAbiProofUnavailableError | ProtocolNativeActionUnavailableError): void {
        const work = this.protocolActions.get(action);
        if (!work) throw error;
        const hadExcept = Object.hasOwn(action, 'except'), hadErrorCode = Object.hasOwn(action, 'error_code');
        const parsed: Record<string, unknown> = {};
        for (const key of ['@timestamp', 'block_num', 'block_id', 'producer', 'trx_id', 'global_sequence', 'receipts', 'receipt',
            'code_sequence', 'abi_sequence', 'act_digest', 'cpu_usage_us', 'net_usage_words', 'signatures', 'inline_count', 'max_inline', 'inline_filtered']) {
            if (Object.hasOwn(action, key)) parsed[key] = action[key];
        }
        for (const key of Object.keys(action)) delete action[key];
        Object.assign(action, structuredClone(work.original), parsed);
        action.act = {...work.original.act, data: work.metadata.input.rawHex};
        if (Object.hasOwn(parsed, 'receipts')) {delete action.receipt; delete action['receiver'];}
        if (!hadExcept) delete action.except;
        if (!hadErrorCode) delete action.error_code;
        const {inputActionOrdinal: _origin, ...input} = work.metadata.input as any;
        if (work.metadata.schemaVersion === 2) {
            if (work.metadata.kind === 'native') work.metadata = {...work.metadata, status: 'incomplete',
                error: {code: error.code, message: error.message.slice(0, 4096).toWellFormed()}};
        } else work.metadata = {schemaVersion: 1, source: work.metadata.source, selectionId: work.metadata.selectionId,
            input, status: 'incomplete', error: {code: error.code, message: error.message.slice(0, 4096).toWellFormed()}};
        action.protocol = work.metadata.schemaVersion === 2 ? structuredClone(work.metadata) : work.metadata;
        action['ds_error'] = true;
        process.send?.({event: 'ds_error', data: {type: 'protocol_action_incomplete', ...work.metadata.source,
            account: action.act.account, action: action.act.name, globalSequence: input.globalSequence, message: work.metadata.error.message}});
    }

    private async revalidateProtocolAction(action: ActionTrace): Promise<void> {
        const work = this.protocolActions.get(action);
        if (!work?.view || 'status' in work.metadata) return;
        const stop = this.profiler.start('protocol_abi_action_revalidate');
        try {
            if (work.native) {
                const before = actionHistoryImmutableJson(action);
                const checked = await this.verifyNativePublication(JSON.parse(before), work);
                if (actionHistoryImmutableJson(action) !== before)
                    throw new ProtocolNativeActionUnavailableError('native_output_changed', 'Native action changed during final verification');
                action.act.data = checked.value; action.protocol = structuredClone(checked.metadata);
            } else {
                await this.getProtocolProofReader().revalidate(work.view); action.protocol = work.metadata;
            }
        }
        catch (error) {
            if (!(error instanceof ProtocolAbiProofUnavailableError) && !(error instanceof ProtocolNativeActionUnavailableError)) {
                if (!work.native) throw error;
                this.restoreProtocolAction(action, new ProtocolNativeActionUnavailableError('native_output_incomplete', 'Native output is not portable or valid'));
                return;
            }
            this.restoreProtocolAction(action, error);
        } finally { stop(); }
    }

    /** The source inventory grants membership; a fresh issued native grant separately checks decoding. */
    private async verifyNativePublication(action: any, work: ProtocolActionWork, finalEnvelope = false) {
        if (!work.native) throw new ProtocolNativeActionUnavailableError('native_invalid_grant', 'Native output lacks its original grant');
        const native = this.getProtocolNativeReader(), metadata = await native.metadata(work.native.grant), input = metadata.input;
        if (actionHistoryImmutableJson(action.protocol) !== actionHistoryImmutableJson(metadata)
            || action.block_num !== metadata.source.blockNum || action.block_id !== metadata.source.blockId
            || action.trx_id !== input.transactionId || action.action_ordinal !== input.actionOrdinal
            || action.act?.account !== input.account || action.act?.name !== input.name) {
            throw new ProtocolNativeActionUnavailableError('native_output_mismatch', 'Native output differs from its original occurrence or journal locator');
        }
        if (finalEnvelope) await native.verifyEnvelope(work.native.grant, action);
        const value = await native.verifyValue(work.native.grant, action.act.data);
        await native.revalidate(work.native.view);
        return {metadata, value};
    }

    private async revalidateProtocolPublication(action: any, work?: ProtocolActionWork): Promise<void> {
        if (!work || work.metadata.schemaVersion !== 2) return;
        const native = this.getProtocolNativeReader();
        if (work.nativeIncomplete) {
            const metadata = await native.incompleteMetadata(work.nativeIncomplete.view, work.nativeIncomplete.input);
            if (actionHistoryImmutableJson(action.protocol) !== actionHistoryImmutableJson(metadata) || action.act?.data !== metadata.input.rawHex)
                throw new ProtocolNativeActionUnavailableError('native_output_mismatch', 'Incomplete native output differs from its source decision');
            await native.revalidate(work.nativeIncomplete.view);
        } else if (work.native && 'status' in work.metadata) {
            const metadata = await native.metadata(work.native.grant);
            const expected = {...metadata, status: 'incomplete', error: work.metadata.error};
            if (actionHistoryImmutableJson(action.protocol) !== actionHistoryImmutableJson(expected) || action.act?.data !== metadata.input.rawHex)
                throw new ProtocolNativeActionUnavailableError('native_output_mismatch', 'Raw native output differs from its original decision');
            await native.verifyEnvelope(work.native.grant, {...action, protocol: metadata});
            await native.revalidate(work.native.view);
        } else await this.verifyNativePublication(action, work, true);
        this.assertProtocolDelivery();
    }

    private async revalidateProtocolDeliveryNativeOutputs(): Promise<void> {
        for (const entry of this.protocolDeliveryNativeEntries ?? [])
            await this.revalidateProtocolPublication(JSON.parse(entry.payload.toString()), entry.work);
        // Earlier values remain current after later async source checks and sealing/cache work.
        for (const entry of this.protocolDeliveryNativeEntries ?? []) {
            const view = entry.work.native?.view ?? entry.work.nativeIncomplete?.view;
            if (view) await this.getProtocolNativeReader().revalidate(view);
        }
        if (this.protocolDeliveryNativeEntries?.size) this.assertProtocolDelivery();
    }

    private assertProtocolDelivery(): void {
        if (!this.usesExtensionProtocol) return;
        if (!this.activeProtocolDelivery || this.activeProtocolDelivery.channel !== this.ch || !this.ch_ready)
            throw new Error('Protocol action delivery lost its original broker channel');
    }

    captureProtocolActionDelivery(message: Message, channel: Channel): void {
        const previous = this.protocolDeliveryOwners.get(message);
        if (previous && previous !== channel) throw new Error('Cannot replace a protocol action broker receipt');
        this.protocolDeliveryOwners.set(message, channel);
    }

    // Per-batch Redis pipeline accumulator. processTraces appends its
    // tx-cache writes here instead of doing its own round-trip; processMessages
    // flushes the whole batch with a single .exec() at the end.
    //
    // Hyperion has two operating modes with different cache-visibility needs:
    //
    //   • Batch indexing (historical catch-up): no live API traffic, throughput
    //     wins. We accumulate cache writes across the whole cargo and flush
    //     once at the end. Cargo-sized flush amortises Redis RTTs.
    //
    //   • Live indexing (caught up to chain head): API calls may hit
    //     `get_transaction(id)` for transactions submitted moments earlier.
    //     We flush per-trace so the cache is visible as fast as possible.
    //
    // The master tags each AMQP message with `live = 'true' | 'false'` based
    // on which reader produced it (continuous vs parallel). processTraces
    // reads that flag and flushes immediately for live traces; non-live
    // traces remain queued for the end-of-batch flush. No config knob is
    // needed for the common case — it follows the master's reader mode
    // automatically. Operators who want to override may set
    // `api.tx_cache_mode: 'sync' | 'batch' | 'auto'` (default 'auto').
    private redisBatchPipeline: any = null;
    private redisBatchHasOps = false;

    async processMessages(messages: Message[]) {
        const stop = this.profiler.start('process_messages_batch');
        this.poolAbiCache.clear();   // per-cargo ABI-lookup memo
        this.poolTypeCache.clear();  // per-cargo type-resolution memo
        this.protocolCacheViews?.clear();
        this.protocolNativeCacheEntries?.clear();
        try {
            this.redisBatchPipeline = this.ioRedisClient
                ? this.ioRedisClient.pipeline()
                : null;
            this.redisBatchHasOps = false;

            try {
                for (const data of messages) {
                    if (this.actionSourceAdmissionEnabled) await this.beginActionAdmission(data);
                    if (this.usesExtensionProtocol) {
                        const owner = this.protocolDeliveryOwners.get(data);
                        if (!owner || owner !== this.ch || !this.ch_ready) throw new Error('Protocol action delivery lacks its original broker channel');
                        this.activeProtocolDelivery = {message: data, channel: owner};
                        this.protocolDeliveryNativeEntries = new Set();
                    }
                    const parsedData = JSON.parse((this.activeActionAdmission?.payload ?? data.content).toString());
                    try {await this.processTraces(parsedData, this.activeActionAdmission?.headers ?? data.properties.headers);} catch (error) {
                        if (!this.activeActionAdmission || !(error instanceof ActionSourceInventoryError)) throw error;
                        // Retained input plus an explicit failure keeps this scope recoverable; it never certifies an empty fragment.
                        await this.getActionAdmissionStore().noteIncomplete(this.activeActionAdmission.admission.id,
                            Number.isSafeInteger(this.activeActionAdmission.traceOrdinal) ? this.activeActionAdmission.traceOrdinal : null, error.message);
                        hLog('Action membership remains incomplete:', error.message);
                    }
                    if (this.actionSourceAdmissionEnabled) {
                        await this.flushRedisBatch();
                        await this.revalidateProtocolDeliveryNativeOutputs();
                        const scope = this.activeActionAdmission!;
                        if (!scope.owner.current()) throw new Error('Action admission consumer changed before ACK');
                        await this.getActionAdmissionStore().trySeal(scope.admission);
                        await this.revalidateProtocolDeliveryNativeOutputs();
                        if (!scope.owner.current()) throw new Error('Action admission consumer changed during seal');
                        scope.owner.consumer.ack(data);
                        this.activeActionAdmission = undefined;
                        this.activeProtocolDelivery = undefined;
                        this.protocolDeliveryNativeEntries = undefined;
                        this.redisBatchPipeline = this.ioRedisClient ? this.ioRedisClient.pipeline() : null;
                        continue;
                    }
                    if (this.usesExtensionProtocol) {
                        await this.flushRedisBatch();
                        await this.revalidateProtocolDeliveryNativeOutputs();
                        this.assertProtocolDelivery();
                        this.activeProtocolDelivery!.channel.ack(data);
                        this.activeProtocolDelivery = undefined;
                        this.protocolDeliveryNativeEntries = undefined;
                        this.redisBatchPipeline = this.ioRedisClient ? this.ioRedisClient.pipeline() : null;
                        continue;
                    }
                    // ack message
                    if (this.ch_ready && this.ch) {
                        try {
                            this.ch.ack(data);
                        } catch (e) {
                            console.log(e);
                            console.log(parsedData);
                            console.log(data.properties.headers);
                        }
                    } else {
                        hLog("Channel is not ready!");
                    }
                }
            } finally {
                // ALWAYS attempt the end-of-batch flush — even if the for-loop
                // threw partway through. We want completed traces' cache
                // writes to persist even when a later trace in the same
                // batch fails to deserialize. Worst case the flush itself
                // fails and we log it; the durable AMQP path for those
                // traces is unaffected.
                if (!this.usesExtensionProtocol) await this.flushRedisBatch();
                else {this.redisBatchPipeline = null; this.redisBatchHasOps = false; this.activeProtocolDelivery = undefined;}
            }
        } finally {
            this.activeActionAdmission = undefined;
            this.protocolDeliveryNativeEntries = undefined;
            stop();
        }
    }

    private async flushRedisBatch(): Promise<void> {
        if (this.redisBatchPipeline && this.redisBatchHasOps) {
            if (this.usesExtensionProtocol && !await this.protocolCacheIsCurrent()) {
                this.redisBatchPipeline = null; this.redisBatchHasOps = false; return;
            }
            try {
                const stopRedis = this.profiler.start('redis_batch_exec');
                try { await this.redisBatchPipeline.exec(); } finally { stopRedis(); }
            } catch (e) {
                if (this.usesExtensionProtocol) throw e;
                hLog(e);
            }
        }
        this.redisBatchPipeline = null;
        this.redisBatchHasOps = false;
    }

    private async beginActionAdmission(message: Message): Promise<void> {
        const owner = this.actionPublicationOwner(message), payload = Buffer.from(message.content);
        const headers = JSON.parse(actionHistoryImmutableJson(message.properties.headers ?? {}));
        const admission = await this.getActionAdmissionStore().resolve(headers?.[actionSourceAdmissionHeader]);
        const epoch = await actionProducerEpoch(this);
        const source = admission.source.inventoryInput.source, ordinal = headers?.action_trace_ordinal;
        if (!owner.current() || actionHistoryImmutableJson(epoch.producer) !== actionHistoryImmutableJson(admission.source.producer)
            || epoch.executableSha256 !== admission.source.executableSha256 || source.chainId !== this.chainId
            || headers?.block_num !== source.blockNum || headers?.block_id !== source.blockId || headers?.producer !== source.producer
            || headers?.ts !== source.timestamp || actionHistoryImmutableJson(await this.actionTarget(source.blockNum)) !== actionHistoryImmutableJson(admission.target))
            throw new Error('Action admission producer/source/target epoch mismatch');
        if (admission.inventory) {
            const transaction = admission.inventory.transactions.find(value => value.traceOrdinal === ordinal);
            if (!transaction?.dispatch || createHash('sha256').update(payload).digest('hex') !== transaction.dispatch.bodySha256
                || headers?.inline_count !== transaction.dispatch.inlineCount || headers?.filtered !== transaction.dispatch.filtered
                || (this.usesExtensionProtocol && headers?.[protocolSourceSelectionHeader] !== admission.inventory.sourceSelectionId))
                throw new Error('Action admission input payload or source ordinal mismatch');
        }
        this.actionHookFailure = undefined;
        this.activeActionAdmission = {admission, traceOrdinal: ordinal, payload, headers, configuration: epoch.configuration, owner};
    }

    private async assertActionAdmissionCurrent(): Promise<void> {
        const scope = this.activeActionAdmission;
        if (!scope || !scope.owner.current() || currentActionConfiguration(this) !== scope.configuration)
            throw new Error('Action admission lost its producer/channel epoch');
        const target = await this.actionTarget(scope.admission.source.inventoryInput.source.blockNum);
        if (!scope.owner.current() || actionHistoryImmutableJson(target) !== actionHistoryImmutableJson(scope.admission.target))
            throw new Error('Action admission target identity changed');
        if (this.usesExtensionProtocol && this.protocolTrace?.view) await this.getProtocolProofReader().revalidate(this.protocolTrace.view);
    }

    private async protocolCacheIsCurrent(): Promise<boolean> {
        const stop = this.profiler.start('protocol_abi_cache_revalidate');
        try {
            for (const entry of this.protocolNativeCacheEntries ?? []) {
                await this.revalidateProtocolPublication(JSON.parse(entry.payload.toString()), entry.work);
            }
            for (const view of this.protocolCacheViews ?? []) await this.getProtocolProofReader().revalidate(view);
            for (const entry of this.protocolNativeCacheEntries ?? []) {
                const view = entry.work.native?.view ?? entry.work.nativeIncomplete?.view;
                if (view) await this.getProtocolNativeReader().revalidate(view);
            }
            this.assertProtocolDelivery(); return true;
        } catch (error) {
            if (!(error instanceof ProtocolAbiProofUnavailableError) && !(error instanceof ProtocolNativeActionUnavailableError)) throw error;
            return false;
        } finally { this.protocolCacheViews?.clear(); this.protocolNativeCacheEntries?.clear(); stop(); }
    }

    /**
     * Resolve the tx-cache flush policy. Returns `true` if the given trace
     * should be flushed to Redis immediately (per-trace, lower latency) or
     * `false` if it can ride on the end-of-cargo batch flush (higher
     * throughput).
     */
    private shouldFlushTxCacheNow(live: string | undefined): boolean {
        const mode = this.conf.api.tx_cache_mode ?? 'auto';
        if (mode === 'sync') return true;
        if (mode === 'batch') return false;
        // 'auto' (default): per-trace flush for live traces, end-of-batch
        // for historical/parallel traces.
        return live === 'true';
    }

    async processTraces(transaction_trace, extra) {
        const stopTraces = this.profiler.start('process_traces');
        try {
            const { cpu_usage_us, net_usage_words, signatures } = transaction_trace;
            const { block_num, block_id, producer, ts, inline_count, filtered, live } = extra;

            if (transaction_trace.status === 0) {
                const selectionId = extra?.[protocolSourceSelectionHeader];
                if (this.usesExtensionProtocol) {
                    this.protocolActions = new WeakMap();
                    this.protocolCacheViews ??= new Set();
                    this.protocolNativeCacheEntries ??= new Set();
                    this.protocolTrace = undefined;
                    const stop = this.profiler.start('protocol_abi_trace_wait');
                    try {
                        if (typeof selectionId !== 'string' || !/^h45srcsel1:[0-9a-f]{64}$/.test(selectionId))
                            throw new ProtocolAbiProofUnavailableError('source_unbound', 'Action trace lacks its source selection');
                        const view = await this.getProtocolProofReader().waitForOpen({chainId: this.chainId,
                            blockNum: Number(block_num), blockId: String(block_id)}, selectionId);
                        if (view.nativeActionInterfaceVersion === 1 && !this.protocol.nativeActions)
                            throw new ProtocolNativeActionUnavailableError('native_capability_unavailable', 'Canonical source requires its selected native action capability');
                        this.protocolTrace = {view};
                        if (this.protocol.nativeActions) this.protocolTrace.nativeView = await this.getProtocolNativeReader().waitForOpen({chainId: this.chainId,
                            blockNum: Number(block_num), blockId: String(block_id)}, selectionId);
                    } catch (error) {
                        if (!(error instanceof ProtocolAbiProofUnavailableError) && !(error instanceof ProtocolNativeActionUnavailableError)) throw error;
                        this.protocolTrace = {error};
                    } finally { stop(); }
                }
                let action_count = 0;
                const trx_id = transaction_trace['id'].toLowerCase();
                const _actDataArray: any[] = [];
                const _processedTraces: ActionTrace[] = [];
                let action_traces: ActionTrace[] = transaction_trace['action_traces'];
                const trx_data = {
                    trx_id,
                    block_num,
                    block_id,
                    producer,
                    cpu_usage_us,
                    net_usage_words,
                    ts,
                    inline_count,
                    filtered,
                    signatures,
                    protocolSelectionId: typeof selectionId === 'string' ? selectionId : undefined
                };

                const usageIncluded = { status: false };

                // perform action flattening if necessary
                if (this.mLoader.parser?.flatten) {
                    const trace_counters = { trace_index: 0 };
                    action_traces = await this.mLoader.parser.flattenInlineActions(action_traces, 0, trace_counters, 0);
                    action_traces.sort((a, b) => {
                        return compareUint64(compatibleUint64(a[1].receipt[1].global_sequence), compatibleUint64(b[1].receipt[1].global_sequence));
                    });
                }

                for (const action_trace of action_traces) {

                    // print original trace, uncomment below
                    // console.log(trx_id, JSON.stringify(action_trace[1], null, 2));

                    if (action_trace[0].startsWith('action_trace_')) {
                        const ds_status = await this.mLoader.parser?.parseAction(this,
                            ts,
                            action_trace[1],
                            trx_data,
                            _actDataArray,
                            _processedTraces,
                            transaction_trace,
                            usageIncluded
                        );
                        if (ds_status) {
                            this.temp_ds_counter++;
                            action_count++;
                            // print deserialized trace, uncomment below
                            // console.log(trx_id, JSON.stringify(action_trace[1], null, 2));
                        }
                    }

                    // console.log(action_trace);
                }

                // Group action traces: merge notification receipts while preserving
                // genuinely distinct duplicate actions (fixes #148)
                if (this.usesExtensionProtocol) for (const action of _processedTraces) await this.revalidateProtocolAction(action);
                let _finalTraces: ActionTrace[];
                try {_finalTraces = groupActionTraces(_processedTraces, this.usesExtensionProtocol);} catch (error) {
                    // A later hook may have corrupted an earlier action. Only pure grouping is classified here.
                    if (!this.activeActionAdmission) throw error;
                    throw new ActionSourceInventoryError('Action grouping failed: ' + (error instanceof Error ? error.message : String(error)));
                }

                // Submit Actions after deduplication

                const redisPayload = new Map<string, RedisValue>();

                const finalized: ActionTrace[] = [];
                for (const uniqueAction of _finalTraces) {

                    if (this.usesExtensionProtocol) {
                        await this.revalidateProtocolAction(uniqueAction);
                        this.assertProtocolDelivery();
                        const work = this.protocolActions.get(uniqueAction);
                        if (this.redisBatchPipeline && !this.conf.api.disable_tx_cache && work?.view
                            && (!('status' in work.metadata) || work.metadata.schemaVersion === 2))
                            this.protocolCacheViews.add(work.view);
                    }

                    try {
                        normalizeActionSequences(uniqueAction);
                        cleanActionTrace(uniqueAction);

                        // Console metadata can also have been changed by a later contract hook.
                        if (!this.conf.features.contract_console) {
                            delete uniqueAction.console;
                        } else if (uniqueAction.console) {
                            console.log(uniqueAction.block_num, uniqueAction.act.account, uniqueAction.act.name, uniqueAction.console);
                        }
                    } catch (error) {
                        // Proof, storage and transport awaits stay outside this contract-output failure boundary.
                        if (!this.activeActionAdmission) throw error;
                        throw new ActionSourceInventoryError('Action finalization failed: ' + (error instanceof Error ? error.message : String(error)));
                    }

                    finalized.push(uniqueAction);
                }
                let finalBatch: readonly any[] = finalized;
                const admissionScope = this.activeActionAdmission;
                if (admissionScope?.admission.inventory) {
                    if (this.actionHookFailure !== undefined) throw new ActionSourceInventoryError('Action hook failed before whole-transaction settlement');
                    // Detach every finalized document before target/proof/journal awaits; hooks may retain their input.
                    finalBatch = detachAdmittedActionBatch(finalized);
                    await this.assertActionAdmissionCurrent();
                    for (let index = 0; index < finalBatch.length; index++) {
                        await this.revalidateProtocolPublication(finalBatch[index], this.protocolActions?.get(finalized[index]));
                    }
                    const prepared = await this.getActionAdmissionStore().prepareTransaction(admissionScope.admission,
                        admissionScope.traceOrdinal, admissionScope.payload, finalBatch);
                    admissionScope.fragmentId = prepared.fragmentId; finalBatch = prepared.actions;
                    await this.assertActionAdmissionCurrent();
                } else if (admissionScope) {
                    // Explicitly incomplete source output grants no membership certificate.
                    finalBatch = detachAdmittedActionBatch(finalized);
                } else if (this.usesExtensionProtocol) {
                    // Hooks may retain parsed objects; queued bytes and routing metadata own detached snapshots.
                    finalBatch = JSON.parse(JSON.stringify(finalized));
                }
                const staged = finalBatch.map((action, index) => ({action, work: this.protocolActions?.get(finalized[index]),
                    payload: Buffer.from(admissionScope ? actionHistoryImmutableJson(action) : JSON.stringify(action))}));
                for (const {work, payload} of staged) if (work?.metadata.schemaVersion === 2)
                    this.protocolDeliveryNativeEntries?.add({work, payload: Buffer.from(payload)});
                if (admissionScope) for (const {action, work, payload} of staged) {
                    await this.assertActionAdmissionCurrent();
                    await this.revalidateProtocolPublication(action, work);
                    const q = `${this.chain}:index_actions:${this.act_emit_idx}`;
                    this.act_emit_idx = this.act_emit_idx % this.conf.scaling.ad_idx_queues + 1;
                    if (!this.conf.indexer.disable_indexing) await this.publishAdmitted(admissionScope.owner, q, payload,
                        {block_num, [actionSourceAdmissionHeader]: admissionScope.admission.id,
                            ...(admissionScope.fragmentId ? {action_fragment_id: admissionScope.fragmentId} : {})});
                    await this.revalidateProtocolPublication(action, work);
                }
                for (const {action: uniqueAction, work, payload} of staged) {
                    await this.revalidateProtocolPublication(uniqueAction, work);
                    redisPayload.set(uniqueAction.global_sequence, payload);
                    if (this.redisBatchPipeline && !this.conf.api.disable_tx_cache && work?.metadata.schemaVersion === 2) {
                        this.protocolNativeCacheEntries.add({work, payload: Buffer.from(payload)});
                    }
                    this.actionDsCounter++;
                    if (!admissionScope) this.pushToActionsQueue(payload, block_num);
                    if (live === 'true') {
                        this.pushToActionStreamingQueue(payload, uniqueAction);
                    }
                }

                // Queue tx-cache writes onto the batch-level pipeline.
                // For batch indexing traces (live !== 'true') the actual
                // round-trip happens once at the end of the cargo via
                // processMessages → ~N traces collapse into one Redis
                // network exchange.
                //
                // For live indexing traces (live === 'true'), flush
                // immediately so the cache is visible for API queries that
                // may arrive moments after the action — at the cost of
                // doing the same one-pipeline round-trip per trace that
                // the experiment-1 per-trace pipeline already proved is
                // safe and ~half the cost of two separate awaits.
                if (this.redisBatchPipeline && !this.conf.api.disable_tx_cache && redisPayload.size > 0) {
                    const cacheKey = transactionSequenceCacheKey(this.chain, trx_data.trx_id);
                    this.redisBatchPipeline
                        .hset(cacheKey, redisPayload)
                        .expire(cacheKey, this.txCacheExpiration);
                    this.redisBatchHasOps = true;

                    if (this.shouldFlushTxCacheNow(live)) {
                        // Flush the current pipeline now; create a fresh
                        // one for any subsequent traces in the same batch.
                        const stopLive = this.profiler.start('redis_live_flush');
                        try {
                            if (!this.usesExtensionProtocol || await this.protocolCacheIsCurrent()) await this.redisBatchPipeline.exec();
                        } catch (e) {
                            if (this.usesExtensionProtocol) throw e;
                            hLog(e);
                        } finally {
                            stopLive();
                        }
                        this.redisBatchPipeline = this.ioRedisClient
                            ? this.ioRedisClient.pipeline()
                            : null;
                        this.redisBatchHasOps = false;
                    }
                }
            }
        } finally {
            this.protocolTrace = undefined;
            stopTraces();
        }
    }

    pushToActionsQueue(payload: any, block_num: number) {
        if (this.conf.indexer.disable_indexing) return;
        const q = this.chain + ":index_actions:" + (this.act_emit_idx);
        this.act_emit_idx++;
        if (this.act_emit_idx > (this.conf.scaling.ad_idx_queues)) {
            this.act_emit_idx = 1;
        }
        // Hot path: publish directly via the AMQP channel. amqplib buffers
        // internally and returns false on backpressure; the cargo wrapper
        // around processMessages is the natural throttling point so we
        // don't need a per-push async queue here. Fall back to the
        // preIndexingQueue only when the channel isn't ready.
        if (this.ch_ready && this.ch) {
            try {
                this.ch.sendToQueue(q, payload, { headers: { block_num } });
                return;
            } catch (e: any) {
                hLog(e.message);
            }
        }
        // Channel temporarily unavailable — queue for the async worker
        // which will retry once ch_ready returns true.
        this.preIndexingQueue.push({
            queue: q,
            content: payload,
            headers: { block_num }
        });
    }

    pushToActionStreamingQueue(payload: any, uniqueAction: any) {
        if (this.allowStreaming && this.conf.features['streaming'].traces && this.ch) {
            try {
                const notificationArray = new Set();
                uniqueAction.act.authorization.forEach((auth: any) => {
                    notificationArray.add(auth.actor);
                });
                uniqueAction.receipts.forEach((rec: any) => {
                    notificationArray.add(rec.receiver);
                });
                const headers = {
                    event: 'trace',
                    account: uniqueAction['act']['account'],
                    name: uniqueAction['act']['name'],
                    notified: [...notificationArray].join(",")
                };
                this.ch.publish('', this.chain + ':stream', payload, { headers });
            } catch (e) {
                hLog(e);
            }
        }
    }

    async initConsumer() {
        if (this.ch_ready && this.ch) {
            const consumer = this.ch;
            await consumer.prefetch(this.conf.prefetch.block);
            await consumer.consume(this.local_queue, (data) => {
                if (data) {
                    if (this.actionSourceAdmissionEnabled) this.captureActionAdmissionDelivery(data, consumer);
                    if (this.usesExtensionProtocol) this.captureProtocolActionDelivery(data, consumer);
                    this.consumerQueue.push(data);
                }
            });
            debugLog(`started consuming from ${this.local_queue}`);
        }
    }

    deleteCache(contract: string) {
        this.loadedActionAbis.delete(contract);
        this.clearTypeCacheForContract(contract);
        // delete cache contract on abieos context
        const status = this.abieos.deleteContract(contract);
        if (!status) {
            debugLog('Contract not found on cache!');
        } else {
            debugLog(`🗑️ Contract successfully removed from cache!`);
        }
    }

    startMonitoring() {

        // hLog(`Starting monitoring loop on ds_worker ${process.env.local_id}`);
        // Monitor Contract Usage
        if (!this.monitoringLoop) {
            this.monitoringLoop = setInterval(() => {
                if (this.totalHits > 0) {
                    process.send?.({
                        event: 'contract_usage_report',
                        data: this.contractUsage,
                        total_hits: this.totalHits
                    });
                    // hLog(`${this.local_queue} ->> ${this.actionDsCounter} actions`);
                    process.send?.({
                        event: 'ds_report',
                        actions: this.actionDsCounter
                    });
                    this.noActionCounter = 0;
                } else {
                    if (!this.conf.indexer.abi_scan_mode && !this.conf.indexer.live_reader) {
                        this.noActionCounter++;
                        if (this.noActionCounter > 60) {
                            debugLog(`No actions processed for ${this.noActionCounter} seconds!`);
                        }
                    }
                }
                this.contractUsage = {};
                this.totalHits = 0;
                this.actionDsCounter = 0;
            }, 1000);
        }
        // hLog(`Monitoring loop started on ds_worker ${process.env.local_id}`);
    }

    async initializeShipAbi(abiString: string) {
        await this.initializeProtocolShip(abiString);
        this.shipABI = abiString;
        this.startMonitoring();
    }

    async assertQueues(): Promise<void> {
        const queue_prefix = this.conf.settings.chain;
        this.local_queue = queue_prefix + ':ds_pool:' + process.env.local_id;
        if (this.ch) {
            this.ch_ready = true;
            await this.ch.assertQueue(this.local_queue, RabbitQueueDef);
            await this.initConsumer();
        }
    }

    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'initialize_abi': {
                void this.initializeShipAbi(msg.data).catch(error => { hLog("Protocol initialization failed", error); process.exit(1); });
                break;
            }
            case 'remove_contract': {
                // hLog(`[${process.env.local_id}] Delete contract: ${msg.contract}`);
                this.deleteCache(msg.contract);
                break;
            }
            case 'connect_ws': {
                this.allowStreaming = true;
                break;
            }
        }
    }

    onReady() {
        process.send?.({
            event: 'ds_ready',
            id: process.env.worker_id
        });
    }

    async run(): Promise<void> {
        debugLog(`Standalone deserializer launched with id: ${process.env.local_id}`);
        this.events.once('ready', () => {
            // check if the ship abi is loaded
            if (!this.shipABI) {
                this.onReady();
            }
        });
    }
}
