import {ABI, Serializer} from '@wharfkit/antelope';
import type {ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import type {ContractDecoder} from './contract-cache.js';

let nextAlias = 1n;

/** Called only after chain selection. Merely importing a worker never loads the addon. */
export async function createAntelopeProvider(): Promise<{provider: ProtocolProvider; decoder: ContractDecoder}> {
    const {Abieos} = await import('@eosrio/node-abieos');
    const native = Abieos.getInstance();
    // The pinned addon exposes a single context. Private aliases give each provider
    // disjoint contract slots while preserving the qualified native decode path.
    const aliases = new Map<string, string>();
    const alias = (contract: string) => {
        let result = aliases.get(contract);
        if (!result) {
            const alphabet = '.12345abcdefghijklmnopqrstuvwxyz';
            let counter = nextAlias++;
            result = 'zz';
            for (let index = 0; index < 10; index++) { result += alphabet[Number(counter & 31n)]; counter >>= 5n; }
            aliases.set(contract, result);
        }
        return result;
    };
    const replace = (contract: string, load: (slot: string) => boolean) => {
        const previous = aliases.get(contract);
        if (previous) { aliases.delete(contract); native.deleteContract(previous); }
        const slot = alias(contract);
        try {
            const loaded = load(slot);
            if (!loaded) { aliases.delete(contract); native.deleteContract(slot); }
            return loaded;
        } catch (error) {
            aliases.delete(contract);
            native.deleteContract(slot);
            throw error;
        }
    };
    const decoder: ContractDecoder = {
        loadAbi: (contract, abi) => replace(contract, slot => native.loadAbi(slot, abi)),
        loadAbiHex: (contract, hex) => replace(contract, slot => native.loadAbiHex(slot, hex)),
        deleteContract: contract => {
            const name = aliases.get(contract);
            aliases.delete(contract);
            return name ? native.deleteContract(name) : false;
        },
        getTypeForAction: (contract, name) => native.getTypeForAction(alias(contract), name),
        getTypeForTable: (contract, name) => native.getTypeForTable(alias(contract), name),
        binToJson: (contract, type, bytes) => native.binToJson(alias(contract), type, bytes),
        hexToJson: (contract, type, hex) => native.hexToJson(alias(contract), type, hex),
    };
    const provider: ProtocolProvider = {
        profileId: 'antelope-default-v1',
        contractCodec: {
            decodeAbi: bytes => Serializer.objectify(Serializer.decode({data: bytes, type: ABI})),
            encodeAbi: abi => Serializer.encode({object: ABI.from(abi as ABI.Def)}).array,
            decodeValue: (abi, type, bytes) => Serializer.objectify(Serializer.decode({data: bytes, type, abi: ABI.from(abi as ABI.Def)})),
            encodeValue: (abi, type, value) => Serializer.encode({object: value, type, abi: ABI.from(abi as ABI.Def)}).array,
        },
        createShipSession(handshake) {
            const abi = ABI.from(handshake as ABI.Def);
            const contract = `@ship-session:${nextAlias++}`;
            if (!decoder.loadAbi(contract, JSON.stringify(handshake))) throw new Error('Antelope SHiP ABI was rejected');
            let closed = false;
            const active = () => { if (closed) throw new Error('Protocol SHiP session is closed'); };
            return {
                encodeRequest: request => { active(); return Serializer.encode({object: request, type: 'request', abi}).array; },
                decodeResult: bytes => { active(); return Serializer.objectify(Serializer.decode({data: bytes, type: 'result', abi})); },
                decodeBlock: bytes => { active(); return decoder.binToJson(contract, 'signed_block', bytes); },
                decodeTraces: bytes => { active(); return decoder.binToJson(contract, 'transaction_trace[]', bytes); },
                decodeDeltas: bytes => { active(); return Serializer.objectify(Serializer.decode({data: bytes, type: 'table_delta[]', abi})); },
                decodeRow: (stream, bytes) => { active(); return decoder.binToJson(contract, stream, bytes); },
                close: () => { if (!closed) { closed = true; decoder.deleteContract(contract); } },
            };
        },
        normalizeDelta(input) { return {kind: 'passthrough', value: input.value}; },
    };
    return {provider, decoder};
}
