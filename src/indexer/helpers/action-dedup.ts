import { ActionTrace } from "../../interfaces/action-trace.js";

/**
 * Groups processed action traces by merging notification receipts.
 *
 * In Antelope, when an action notifies other accounts (e.g. eosio.token::transfer),
 * the same action appears multiple times — once per receiver — with the same
 * `act_digest` but different `action_ordinal` and `receiver`. The
 * `creator_action_ordinal` links each notification back to the parent action.
 *
 * These notification traces should be merged into a single document with
 * multiple receipts (the `receipts` array).
 *
 * However, genuinely distinct duplicate actions (same content and `act_digest`,
 * but independent root actions with `creator_action_ordinal === 0`) must be
 * kept as separate documents.
 *
 * The grouping key is `act_digest + ":" + canonical_ordinal` where:
 * - Root actions (creator_action_ordinal === 0): canonical = action_ordinal
 * - Notifications (creator > 0, same act_digest as creator): canonical = creator_action_ordinal
 * - Inline actions (creator > 0, different act_digest from creator): canonical = action_ordinal
 *
 * Notifications are distinguished from inline actions by comparing act_digest:
 * require_recipient() replays the exact same action (same digest), while
 * an inline .send() dispatches a new action (different digest).
 *
 * This ensures notifications merge with their parent, inline actions become
 * heads of their own notification chains, and genuinely distinct duplicate
 * actions remain separate (fixes #148 without breaking notifications).
 *
 * @param processedTraces - Array of parsed action traces with receipt data
 * @returns Array of grouped action traces with merged receipts
 */
export function groupActionTraces(processedTraces: ActionTrace[]): ActionTrace[] {
    const finalTraces: ActionTrace[] = [];

    if (processedTraces.length > 1) {

        // Pass 1: map each action_ordinal to its act_digest so we can
        // distinguish notifications (same digest as creator) from inline
        // actions (different digest from creator)
        const digestByOrdinal: Record<number, string> = {};
        for (const trace of processedTraces) {
            digestByOrdinal[trace.action_ordinal] = trace.receipt.act_digest;
        }

        // Compute the canonical ordinal for grouping
        const getCanonical = (trace: ActionTrace): number => {
            const creator = trace.creator_action_ordinal;
            // A notification has the same act_digest as its creator
            // (require_recipient replays the exact same action).
            // An inline action has a different act_digest from its creator
            // (dispatched via .send() with new action content).
            if (creator > 0 && digestByOrdinal[creator] === trace.receipt.act_digest) {
                return creator; // notification: group with parent
            }
            return trace.action_ordinal; // root or inline action: own group
        };

        const traceGroups: Record<string, any[]> = {};

        // collect receipts grouped by act_digest + canonical ordinal
        for (const trace of processedTraces) {
            const groupKey = `${trace.receipt.act_digest}:${getCanonical(trace)}`;
            if (traceGroups[groupKey]) {
                traceGroups[groupKey].push(trace.receipt);
            } else {
                traceGroups[groupKey] = [trace.receipt];
            }
        }

        // merge receipts into the first trace instance per group
        for (const trace of processedTraces) {
            const groupKey = `${trace.receipt.act_digest}:${getCanonical(trace)}`;
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
