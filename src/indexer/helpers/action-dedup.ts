import { ActionTrace } from "../../interfaces/action-trace.js";

/**
 * Groups processed action traces by merging notification receipts.
 *
 * In Antelope, when an action notifies other accounts (e.g. eosio.token::transfer),
 * the same action appears multiple times — once per receiver — with the same
 * `act_digest` and `action_ordinal` but different `receiver`.
 *
 * These notification traces should be merged into a single document with
 * multiple receipts (the `receipts` array).
 *
 * However, genuinely distinct duplicate actions (same content, different
 * `action_ordinal`) must be kept as separate documents.
 *
 * The grouping key is `act_digest + ":" + action_ordinal` to distinguish
 * between these two cases.
 *
 * @param processedTraces - Array of parsed action traces with receipt data
 * @returns Array of grouped action traces with merged receipts
 */
export function groupActionTraces(processedTraces: ActionTrace[]): ActionTrace[] {
    const finalTraces: ActionTrace[] = [];

    if (processedTraces.length > 1) {
        const traceGroups: Record<string, any[]> = {};

        // collect receipts grouped by act_digest + action_ordinal
        for (const trace of processedTraces) {
            const groupKey = `${trace.receipt.act_digest}:${trace.action_ordinal}`;
            if (traceGroups[groupKey]) {
                traceGroups[groupKey].push(trace.receipt);
            } else {
                traceGroups[groupKey] = [trace.receipt];
            }
        }

        // merge receipts into the first trace instance per group
        for (const trace of processedTraces) {
            const groupKey = `${trace.receipt.act_digest}:${trace.action_ordinal}`;
            if (traceGroups[groupKey]) {
                trace['receipts'] = [];
                for (const receipt of traceGroups[groupKey]) {
                    trace['code_sequence'] = receipt['code_sequence'];
                    delete receipt['code_sequence'];
                    trace['abi_sequence'] = receipt['abi_sequence'];
                    delete receipt['abi_sequence'];
                    trace['receipts'].push(receipt);
                }
                delete traceGroups[groupKey];
                delete trace['receipt'];
                delete trace['receiver'];
                finalTraces.push(trace);
            }
        }

    } else if (processedTraces.length === 1) {

        // single action on trx
        const trace = processedTraces[0];
        trace['code_sequence'] = trace['receipt'].code_sequence;
        trace['abi_sequence'] = trace['receipt'].abi_sequence;
        trace['act_digest'] = trace['receipt'].act_digest;

        delete trace['receipt']['code_sequence'];
        delete trace['receipt']['abi_sequence'];
        trace['receipts'] = [trace['receipt']];
        delete trace['receipt'];
        finalTraces.push(trace);
    }

    return finalTraces;
}
