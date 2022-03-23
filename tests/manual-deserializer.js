import {Serialize} from 'eosjs';

const data = "35379A53C0D54598469555CB00000C4946995AB5DD711BF6DAC3FB3AEA4FD76C0BF01070C119C74A5C8B4ED33C9600000000000000000000000000000000000000000000000000000000000000008318EAB311683DA5004B6606DF9B6BA8DDA2BA7BF84FE55505C00EBD9240C4FAF00D00000000";

const buffer = Buffer.from(data, 'hex');

const arr = [];

const sb = new Serialize.SerialBuffer({
    textDecoder: new TextDecoder(),
    textEncoder: new TextEncoder(),
    array: new Uint8Array(buffer)
})

sb.readPos = 0;
console.log('Timestamp:', sb.getUint32())
const producer = sb.getName();
console.log('Producer:', producer);
console.log('Confirmed:', sb.getUint16());
console.log('Previous:', sb.getUint8Array(32));
console.log('TX Mroot:', sb.getUint8Array(32));
console.log('Action Mroot:', sb.getUint8Array(32));
console.log('SV:', sb.getUint32());
console.log(sb.getVarint32());
console.log(sb.getVaruint32());
console.log(sb);
// console.log('PSV:', sb.getUint32());