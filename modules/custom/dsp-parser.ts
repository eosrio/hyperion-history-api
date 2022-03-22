import DSPoolWorker from "../../workers/ds-pool";
import flatstr from 'flatstr';

export async function parseDSPEvent(worker: DSPoolWorker, data: any) {
    const parsedEvents = [];
    const events = data.console.split("\n");
    for (const event of events) {
        if (event !== '') {
            try {
                parsedEvents.push(JSON.parse(event));
            } catch (e:any) {
            }
        }
    }
    delete data.console;
    if (parsedEvents.length > 0) {
        const payload = {
            ...data,
            dsp_events: parsedEvents
        }
        console.log(payload);
        worker.ch.sendToQueue(`${worker.chain}:dsp`, Buffer.from(flatstr(JSON.stringify(payload))));
    }
}
