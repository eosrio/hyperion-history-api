import type {Socket} from 'socket.io';
import type {HistoryAcceptance, HistoryBatch, HistoryStart, StreamHistoryDelivery} from './history-delivery.js';

/** Retains the legacy wire shape and its per-batch Socket.IO acknowledgement. */
export class SocketIOHistoryDelivery implements StreamHistoryDelivery {
    constructor(readonly connection: Socket) {}

    begin(start: HistoryStart): void {
        this.connection.emit('message', {
            reqUUID: start.requestId,
            type: 'trace_init',
            mode: 'history',
            first_block: start.firstBlock,
            results: start.totalResults
        });
    }

    deliver(batch: HistoryBatch, timeoutMs: number): Promise<HistoryAcceptance> {
        return this.connection.timeout(timeoutMs).emitWithAck('message', {
            reqUUID: batch.requestId,
            type: `${batch.kind}_trace`,
            mode: 'history',
            messages: batch.messages,
            filtered: batch.filtered
        });
    }
}
