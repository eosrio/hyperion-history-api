/**
 * Re-groups actions that were indexed as separate documents per notification
 * back into the correct format: one action per unique act_digest + root ordinal,
 * with all notification receipts merged into a single receipts array.
 *
 * This handles both correctly-indexed data (already grouped) and data indexed
 * with the broken dedup that stored one document per notification.
 *
 * Notifications are distinguished from inline actions by comparing act_digest:
 * require_recipient() replays the exact same action (same digest), while
 * an inline .send() dispatches a new action (different digest).
 */
export function regroupActions(actions: any[]): any[] {
    if (actions.length <= 1) return actions;

    // Pass 1: map each action_ordinal to its act_digest so we can
    // distinguish notifications (same digest as creator) from inline
    // actions (different digest from creator)
    const digestByOrdinal = new Map<number, string>();
    for (const action of actions) {
        const ordinal = action.action_ordinal ?? 1;
        const digest = action.act_digest ?? '';
        digestByOrdinal.set(ordinal, digest);
    }

    const groups = new Map<string, any>();

    for (const action of actions) {
        const creator = action.creator_action_ordinal ?? 0;
        const ordinal = action.action_ordinal ?? 1;
        const digest = action.act_digest ?? '';

        // A notification has the same act_digest as its creator
        // (require_recipient replays the exact same action).
        // An inline action has a different act_digest from its creator
        // (dispatched via .send() with new action content).
        const isNotification = creator > 0
            && digestByOrdinal.get(creator) === digest;
        const canonical = isNotification ? creator : ordinal;
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
