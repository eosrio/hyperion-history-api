import {ArchiveEntry, ArchivesConfig} from "../../interfaces/hyperionConfig.js";
import {hLog} from "../../indexer/helpers/common_functions.js";

/**
 * ArchiveRegistry
 * ----------------
 * Live-capable registry of cold-tier archives. An archive owns a contiguous,
 * inclusive block range [first_block, last_block] for which the live
 * Elasticsearch indices no longer carry the full payload (action `act.data` or
 * delta `value`) — that payload was dropped to save storage and can be
 * re-served on demand from the archive.
 *
 * This component is intentionally a small, instantiable class (NOT a hardcoded
 * const) so that:
 *   - entries are loaded from config (`api.archives`), and
 *   - the same shape can later be refreshed live and surfaced to QRY Network
 *     state reporting via {@link list}.
 *
 * Resolution is O(n) over the configured archives, which is fine for the
 * handful of archive shards a deployment is expected to have. Ranges are
 * assumed non-overlapping; if they overlap, the first matching entry (in
 * config order) wins.
 *
 * Two independent registries exist per chain: one for actions, one for deltas.
 * Build them from the same `ArchivesConfig` via the static factory helpers.
 */
export class ArchiveRegistry {

    private readonly entries: ArchiveEntry[];
    private readonly enabled: boolean;
    private readonly timeoutMs: number;
    private readonly maxBatch: number;

    constructor(opts: {
        entries?: ArchiveEntry[];
        enabled?: boolean;
        timeout_ms?: number;
        max_batch?: number;
    } = {}) {
        // Normalize: drop trailing slashes from URLs and ignore malformed entries. An entry must
        // have a non-empty url and a well-ordered finite range (first_block <= last_block) — an
        // inverted range would silently own zero blocks, so we drop it AND warn rather than let it
        // pass as a phantom archive that hydrates nothing.
        this.entries = (opts.entries ?? [])
            .filter(e => {
                const ok = !!e && typeof e.url === 'string' && e.url.length > 0
                    && Number.isFinite(e.first_block) && Number.isFinite(e.last_block)
                    && e.first_block <= e.last_block;
                if (!ok) {
                    hLog(`[archive-registry] ignoring invalid archive entry ${JSON.stringify(e)} `
                        + `— need a non-empty url and finite first_block <= last_block`);
                }
                return ok;
            })
            .map(e => ({
                url: e.url.replace(/\/+$/, ''),
                first_block: e.first_block,
                last_block: e.last_block
            }));
        // A registry is only "enabled" if hydration is on AND there is at least one usable archive.
        this.enabled = (opts.enabled ?? false) && this.entries.length > 0;
        this.timeoutMs = opts.timeout_ms && opts.timeout_ms > 0 ? opts.timeout_ms : 2000;
        // Spec hard cap is 20000 items per POST; never exceed it even if misconfigured higher.
        const requested = opts.max_batch && opts.max_batch > 0 ? opts.max_batch : 20000;
        this.maxBatch = Math.min(requested, 20000);
    }

    /** Build the registry that serves action `act.data` from `api.archives`. */
    static forActions(cfg?: ArchivesConfig): ArchiveRegistry {
        return new ArchiveRegistry({
            entries: cfg?.actions,
            enabled: cfg?.enabled,
            timeout_ms: cfg?.timeout_ms,
            max_batch: cfg?.max_batch
        });
    }

    /** Build the registry that serves delta `value`/`data` from `api.archives`. */
    static forDeltas(cfg?: ArchivesConfig): ArchiveRegistry {
        return new ArchiveRegistry({
            entries: cfg?.deltas,
            enabled: cfg?.enabled,
            timeout_ms: cfg?.timeout_ms,
            max_batch: cfg?.max_batch
        });
    }

    /** True when hydration is on and at least one archive is configured. */
    isEnabled(): boolean {
        return this.enabled;
    }

    /** Per-request HTTP timeout (ms) to use when calling an archive. */
    getTimeoutMs(): number {
        return this.timeoutMs;
    }

    /** Hard cap on the number of items to send in a single POST to an archive. */
    getMaxBatch(): number {
        return this.maxBatch;
    }

    /**
     * Returns the base URL of the archive that owns `block_num`, or `null` if
     * the block is hot (still fully served from Elasticsearch / not covered by
     * any archive). When the registry is disabled, always returns `null`.
     */
    archiveFor(block_num: number): string | null {
        if (!this.enabled || !Number.isFinite(block_num)) {
            return null;
        }
        for (const e of this.entries) {
            if (block_num >= e.first_block && block_num <= e.last_block) {
                return e.url;
            }
        }
        return null;
    }

    /**
     * Returns a copy of the configured archive entries. Intended to feed QRY
     * Network state reporting (and diagnostics) later. Always a fresh array of
     * fresh objects so callers cannot mutate internal state.
     */
    list(): ArchiveEntry[] {
        return this.entries.map(e => ({...e}));
    }
}
