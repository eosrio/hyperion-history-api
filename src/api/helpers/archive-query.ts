/**
 * Parse the `?hydrate=` query param shared by the v2 routes that support
 * cold-tier archive hydration (get_actions, get_transaction, get_deltas).
 *
 * Hydration is ON by default. It is considered DISABLED only when the caller
 * explicitly opts out with a falsy value: `?hydrate=false`, `?hydrate=0`, or
 * `?hydrate=no`. Anything else (absent, `true`, `1`, etc.) keeps it enabled.
 *
 * Note this is orthogonal to the existing `?simple=` mode — simple responses
 * are still hydrated unless `?hydrate=false` is passed.
 *
 * @returns true when hydration should be SKIPPED for this request.
 */
export function isHydrationDisabled(query: any): boolean {
    if (!query) {
        return false;
    }
    const raw = query.hydrate;
    if (raw === undefined || raw === null) {
        return false;
    }
    if (raw === false) {
        return true;
    }
    if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        return v === 'false' || v === '0' || v === 'no';
    }
    return false;
}
