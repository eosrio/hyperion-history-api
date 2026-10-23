import type {ProjectionReadView} from '@eosrio/hyperion-sdk/projection';

export const STATE_RESPONSE_HEADERS = Object.freeze([
    'hyperion-state-block-num', 'hyperion-state-block-id', 'hyperion-state-last-valid',
]);

/** Metadata belongs to the served view. This slice serves no last-valid fallback and stores no response cache. */
export function stateResponseHeaders(view: ProjectionReadView): Record<string, string> {
    return {'hyperion-state-block-num': String(view.checkpoint.blockNum), 'hyperion-state-block-id': view.checkpoint.blockId,
        'hyperion-state-last-valid': 'false', 'cache-control': 'no-store'};
}
