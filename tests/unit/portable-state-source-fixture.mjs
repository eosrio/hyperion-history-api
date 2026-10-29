import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
const code = process.versions.bun ? "../../src/" : "../../build/";
const { loadChainProtocol } = await import(new URL(code + "indexer/protocol/selection.js", import.meta.url));
const { ProtocolAbiCoordinator } = await import(new URL(code + "indexer/protocol/abi-coordinator.js", import.meta.url));
const { ProtocolAbiFrontierStore } = await import(new URL(code + "indexer/protocol/abi-frontier-store.js", import.meta.url));
const { ProtocolAbiObservationStore } = await import(new URL(code + "indexer/protocol/abi-observation-store.js", import.meta.url));
const { ProtocolSourceBindingStore } = await import(new URL(code + "indexer/protocol/source-bindings.js", import.meta.url));
const { PortableProjectionSource } = await import(new URL(code + "indexer/projection/source.js", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (name) => readFileSync(new URL("./fixtures/wire-native-genesis/" + name, import.meta.url));
const original = read("ship-preflight-20261020.json"), forward = read("receipt-forward-2-4-20261020.json");
assert.equal(hash(original), "b8edf652dd0ad265917bf0111ca48789ec7a3f1976f2113783202cc3dd38acb4");
assert.equal(hash(forward), "38d75b7a1ba28e3abd77512854f963e7723631d6837df73bd7aeff656cc8a450");
const capture = JSON.parse(original.toString()), follow = JSON.parse(forward.toString());
const schemaJson = Buffer.from(capture.schema.base64, "base64").toString("utf8");
const frames = [
  capture.messages.find((entry) => entry.kind === "block1"),
  ...follow.messages.filter((entry) => entry.kind === "block")
].map((entry) => {
  const frame = Buffer.from(entry.response.base64, "base64");
  assert.equal(hash(frame), entry.response.sha256);
  return frame;
});
export async function prepared(constructedEpochs = {}, initialThrough = 4, construct, retained) {
  // Explicit test input only. The retained-range fixture verifies its original member hashes first;
  // normal tests keep their exact four-frame capture and construction controls.
  const inputFrames = retained?.frames ?? frames;
  const inputSchema = retained?.schemaJson ?? schemaJson;
  const inputCapture = retained?.capture ?? capture;
  const selected = await loadChainProtocol({ provider: "extension", package: "@eosrio/hyperion-wire-plugin", profileId: inputCapture.profileId });
  const profile = { id: selected.id, profileId: selected.provider.profileId, components: selected.components };
  const memory = frontierMemoryClient(), chain = "portable-source-fixture";
  const store = new ProtocolAbiFrontierStore(memory.client, chain), bindings = new ProtocolSourceBindingStore(memory.client, chain);
  const observations = new ProtocolAbiObservationStore(memory.client, chain);
  const coordinator = new ProtocolAbiCoordinator({
    chainId: inputCapture.chainId,
    profile,
    ownerId: "fixture-owner",
    store,
    bindings,
    observations,
    verifyNativeGenesis: selected.provider.verifyNativeGenesis?.bind(selected.provider)
  });
  await coordinator.start();
  const contextId = (await bindings.prepareContext({ schemaVersion: 1, chainId: inputCapture.chainId, protocol: profile, schemaJson: inputSchema })).id;
  const { generation } = await coordinator.openSource(contextId, "fixture-source");
  const schema = JSON.parse(inputSchema);
  const positions = [], observed = [];
  async function advance(through) {
    const session = selected.provider.createShipSession(JSON.parse(inputSchema));
    try {
      const nativeDeltas = session.decodeDeltas(Buffer.from(session.decodeResult(inputFrames[0])[1].deltas, "hex"));
      const nativeAbiHex = session.decodeRow("account", Buffer.from(nativeDeltas[0][1].rows[0].data, "hex"))[1].abi;
      const nativeAbi = selected.provider.contractCodec.decodeAbi(Buffer.from(nativeAbiHex, "hex"));
      for (const frame of inputFrames.slice(positions.length, through)) {
        const decoded = session.decodeResult(frame), result = decoded[1];
        const source = {
          chainId: inputCapture.chainId,
          blockNum: Number(result.this_block.block_num),
          blockId: result.this_block.block_id,
          previousBlockId: result.prev_block?.block_id ?? null
        };
        const epoch = constructedEpochs[source.blockNum];
        if (epoch) {
          const account = ["account_v0", { name: "target", creation_date: "2025-01-01T00:00:00.000", abi: epoch.abiHex }];
          const raw = selected.provider.contractCodec.encodeValue(schema, "account", account);
          result.deltas = Buffer.from(selected.provider.contractCodec.encodeValue(schema, "table_delta[]", [["table_delta_v0", { name: "account", rows: [{ present: epoch.present === false ? 0 : 1, data: Buffer.from(raw).toString("hex") }] }]])).toString("hex");
          if (epoch.publish) {
            const traces = session.decodeTraces(Buffer.from(result.traces, "hex"));
            const action = traces[0][1].action_traces[0][1];
            action.act.name = "setabi";
            action.act.data = Buffer.from(selected.provider.contractCodec.encodeValue(nativeAbi, "setabi", { account: "target", abi: epoch.abiHex })).toString("hex");
            result.traces = Buffer.from(selected.provider.contractCodec.encodeValue(schema, "transaction_trace[]", traces)).toString("hex");
          }
        }
        const constructed = construct?.({ source, result, provider: selected.provider, schema, session }) === true;
        const sourceFrame = epoch || constructed ? selected.provider.contractCodec.encodeValue(schema, "result", decoded) : frame;
        const sections = {
          kind: "unattested-ship-result-sections-v1",
          schemaJson: inputSchema,
          blockHex: result.block,
          tracesHex: result.traces,
          deltasHex: result.deltas
        };
        const { protocolAbiCaptureDigest } = await import(new URL(code + "indexer/protocol/abi-observation-store.js", import.meta.url));
        const captureSha256 = protocolAbiCaptureDigest(source, sections);
        const selectionId = (await bindings.prepareSelection({
          schemaVersion: 1,
          contextId,
          readerSessionId: "fixture-source",
          readerRole: "live",
          assignmentId: null,
          source,
          frameSha256: hash(sourceFrame),
          captureSha256,
          head: { blockNum: Number(result.head.block_num), blockId: result.head.block_id },
          irreversible: { blockNum: Number(result.last_irreversible.block_num), blockId: result.last_irreversible.block_id }
        })).id;
        let observation;
        if (source.blockNum === 1)
          observation = { status: "native-genesis", facts: selected.provider.verifyNativeGenesis({
            schemaJson: inputSchema,
            block: Buffer.from(result.block, "hex"),
            traces: null,
            deltas: Buffer.from(result.deltas, "hex")
          }, source) };
        else {
          const deltas = session.decodeDeltas(Buffer.from(result.deltas, "hex")), rows = [];
          let ordinal = 0;
          for (const [, delta] of deltas)
            for (const row of delta.rows) {
              if (delta.name === "account") {
                const raw = Buffer.from(row.data, "hex");
                rows.push({ ordinal, present: row.present === 1, raw, value: session.decodeRow("account", raw) });
              }
              ordinal++;
            }
          observation = { status: "observed", facts: selected.provider.observeBlockAbi({
            traces: session.decodeTraces(Buffer.from(result.traces, "hex")),
            accountRows: rows
          }, source) };
        }
        const receipt = await observations.prepare({
          schemaVersion: 1,
          protocol: profile,
          source: { ...source, inputSha256: captureSha256 },
          capture: sections,
          observation
        });
        await bindings.prepareObservationLink({ schemaVersion: 1, selectionId, observationId: receipt.id, observationDigest: receipt.digest });
        await coordinator.admit(selectionId, generation);
        await coordinator.drain();
        positions.push(source);
        observed.push(receipt.id);
      }
    } finally {
      session.close?.();
    }
  }
  await advance(initialThrough);
  const options = { client: memory.client, chain, chainId: inputCapture.chainId, profile, provider: selected.provider };
  memory.calls.length = 0;
  return { memory, options, coordinator, positions, observed, advance, source: new PortableProjectionSource(options) };
}

export { hash, read, original, forward, capture, follow, schemaJson, frames };

export async function preparedStatefulInputs() {
  const selected = await loadChainProtocol({ provider: "extension", package: "@eosrio/hyperion-wire-plugin", profileId: capture.profileId });
  const abi = {
    version: "sysio::abi/1.3",
    structs: [{ name: "record", base: "", fields: [{ name: "id", type: "uint64" }, { name: "owner", type: "name" }] }],
    actions: [{ name: "update", type: "record", ricardian_contract: "" }],
    tables: [{
      name: "records",
      type: "record",
      index_type: "",
      key_names: [],
      key_types: [],
      table_id: 0,
      secondary_indexes: [{ name: "owner", key_type: "uint64", table_id: 65535 }]
    }]
  };
  const abiHex = Buffer.from(selected.provider.contractCodec.encodeAbi(abi)).toString("hex");
  const value = { id: "18446744073709551615", owner: "alice" };
  const rawValue = Buffer.from(selected.provider.contractCodec.encodeValue(selected.provider.contractCodec.decodeAbi(Buffer.from(abiHex, "hex")), "record", value)).toString("hex");
  const p = await prepared({ 2: { abiHex } }, 3, ({ source, result, provider, schema, session }) => {
    if (source.blockNum !== 3)
      return false;
    const traces = session.decodeTraces(Buffer.from(result.traces, "hex"));
    const action = traces[0][1].action_traces[0][1];
    action.receiver = "target";
    action.receipt[1].receiver = "target";
    action.act.account = "target";
    action.act.name = "update";
    action.act.data = rawValue;
    result.traces = Buffer.from(provider.contractCodec.encodeValue(schema, "transaction_trace[]", traces)).toString("hex");
    const row = (stream, value, present) => ({
      present,
      data: Buffer.from(provider.contractCodec.encodeValue(schema, stream, value)).toString("hex")
    });
    const primary = { code: "target", payer: "payer", table_id: 0, key: "000001", value: rawValue };
    result.deltas = Buffer.from(provider.contractCodec.encodeValue(schema, "table_delta[]", [
      ["table_delta_v0", { name: "contract_row_kv", rows: [
        row("contract_row_kv", ["contract_row_kv_v0", primary], 1),
        row("contract_row_kv", ["contract_row_kv_v0", { ...primary, value: "" }], 0)
      ] }],
      ["table_delta_v0", { name: "contract_index_kv", rows: [row("contract_index_kv", [
        "contract_index_kv_v0",
        { code: "target", payer: "otherpayer", table_id: 65535, sec_key: "0000", pri_key: "000001" }
      ], 1)] }]
    ])).toString("hex");
    return true;
  });
  return { p, value, rawValue, abiHex };
}
