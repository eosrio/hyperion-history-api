/**
 * Re-groups actions that were indexed as separate documents per notification
 * back into the correct format: one action per unique act_digest + root ordinal,
 * with all notification receipts merged into a single receipts array.
 *
 * This handles both correctly-indexed data (already grouped) and data indexed
 * with the broken dedup that stored one document per notification.
 */
export function regroupActions(actions: any[]): any[] {
    if (actions.length <= 1) return actions;

    const groups = new Map<string, any>();

    for (const action of actions) {
        // determine canonical ordinal: notifications group with their parent
        const creator = action.creator_action_ordinal ?? 0;
        const ordinal = action.action_ordinal ?? 1;
        const canonical = creator > 0 ? creator : ordinal;
        const digest = action.act_digest ?? '';
        const key = `${digest}:${canonical}`;

        if (groups.has(key)) {
            // merge receipts into existing group
            const existing = groups.get(key);
            if (action.receipts && action.receipts.length > 0) {
                for (const receipt of action.receipts) {
                    // avoid duplicates (already-grouped data)
                    const isDup = existing.receipts.some(
                        (r: any) => r.receiver === receipt.receiver
                    );
                    if (!isDup) {
                        existing.receipts.push(receipt);
                    }
                }
            }
        } else {
            // ensure receipts array exists
            if (!action.receipts) {
                action.receipts = [];
            }
            groups.set(key, action);
        }
    }

    return [...groups.values()];
}
