/** Event-only transport for actual StateHistorySocket callbacks; no listener/network. */
import {EventEmitter} from 'node:events';
export const sockets = [];
export default class ControlledWebSocket extends EventEmitter {
    constructor(url) {super(); this.url = url; this.sent = []; this.closes = 0; sockets.push(this);}
    send(bytes) {this.sent.push(Buffer.from(bytes));}
    close() {this.closes++;}
}
