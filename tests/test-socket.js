// noinspection JSUnusedGlobalSymbols,JSUnusedGlobalSymbols,JSUnusedGlobalSymbols,JSCheckFunctionSignatures,JSCheckFunctionSignatures,JSUnresolvedVariable,JSUnresolvedVariable

const {Serialize} = require('eosjs');
const WebSocket = require('ws');
const {SerialBuffer, SerializerState, getTypesFromAbi, createInitialTypes} = require('eosjs/dist/eosjs-serialize');
const txEnc = new TextEncoder();
const txDec = new TextDecoder();

const WS_SERVER = 'ws://192.168.10.239:18080';

class SocketTester {

  abi = null;
  types = null;
  tables = new Map();
  receivedCounter = 0;
  ws;

  // Connect to the State-History Plugin
  constructor({socketAddress}) {
    this.ws = new WebSocket(socketAddress, {perMessageDeflate: false});
    this.ws.on('message', data => this.onMessage(data));
  }

  // Convert JSON to binary. type identifies one of the types in this.types.
  serialize(type, value) {
    const buffer = new SerialBuffer({textEncoder: txEnc, textDecoder: txDec});
    Serialize.getType(this.types, type).serialize(buffer, value);
    return buffer.asUint8Array();
  }

  // Convert binary to JSON. type identifies one of the types in this.types.
  deserialize(type, array) {
    const buffer = new SerialBuffer({textEncoder: txEnc, textDecoder: txDec, array});
    return Serialize.getType(this.types, type).deserialize(buffer, new SerializerState({bytesAsUint8Array: true}));
  }

  // Serialize a request and send it to the plugin
  send(request) {
    this.ws.send(this.serialize('request', request));
  }

  // Receive a message
  onMessage(data) {
    try {
      if (!this.abi) {
        // First message is the protocol ABI
        this.abi = JSON.parse(data);

        for (const struct of this.abi.structs) {
          console.log(struct.name, '\n', struct.fields, '\n');
        }

        this.types = getTypesFromAbi(createInitialTypes(), this.abi);
        for (const table of this.abi.tables) {
          this.tables.set(table.name, table.type);
        }

        this.send(['get_status_request_v0', {}]);
      } else {
        const [type, response] = this.deserialize('result', data);
        if (this[type]) {
          this[type](response);
        } else {
          console.log('Unhandled Type:', type);
        }

        // Ack Block
        this.send(['get_blocks_ack_request_v0', {num_messages: 1}]);
      }
    } catch (e) {
      console.log(e);
      process.exit(1);
    }
  }

  // Report status

  get_status_result_v0(response) {
    console.log(response);
    // request from head block
    this.receivedCounter = 0;
    this.send([
      'get_blocks_request_v0', {
        max_messages_in_flight: 1,
        have_positions: [],
        irreversible_only: false,
        fetch_block: true,
        fetch_traces: true,
        fetch_deltas: true,
        start_block_num: response.head.block_num,
        end_block_num: 0xffffffff - 1,
      }]);
  }

  get_blocks_result_v1(response) {
    const block_num = response.this_block.block_num;
    this.receivedCounter++;
    try {
      const traces = this.deserialize('transaction_trace[]', response.traces);
      for (const trace of traces) {
        const tx = trace[1];
        for (const act_trace of tx.action_traces) {
          const act = act_trace[1];
          console.log(`Block: ${block_num} | Account: ${act.act.account} | Name: ${act.act.name}`);
        }
      }
    } catch (e) {
      console.log(`Block: ${block_num} | Deserialization Error: ${e.message}`);
    }
    // if (response.block[1].transactions.length > 0) {
    //   for (const tx of response.block[1].transactions) {
    //     console.log(block_num, tx);
    //   }
    // }
  }

  get_blocks_result_v0(response) {
    // console.log(response);
    const block_num = response.this_block.block_num;
    this.receivedCounter++;
    console.log(this.receivedCounter, block_num);
    // if (response.block[1].transactions.length > 0) {
    //   for (const tx of response.block[1].transactions) {
    //     console.log(block_num, tx);
    //   }
    // }
  }

}

new SocketTester({socketAddress: WS_SERVER});
