import type {ProjectionReadView} from '@eosrio/hyperion-sdk/projection';
import type {StatefulOwnerFinality} from '../../indexer/projection/stateful-config.js';

export const STATE_RESPONSE_HEADERS = Object.freeze([
    'hyperion-state-block-num', 'hyperion-state-block-id', 'hyperion-state-last-valid', 'hyperion-state-finality',
]);

/** Metadata belongs to the served view. This slice serves no last-valid fallback and stores no response cache. */
export function stateResponseHeaders(view: Pick<ProjectionReadView, 'checkpoint'>, finality?: StatefulOwnerFinality): Record<string, string> {
    return {'hyperion-state-block-num': String(view.checkpoint.blockNum), 'hyperion-state-block-id': view.checkpoint.blockId,
        'hyperion-state-last-valid': 'false', ...(finality ? {'hyperion-state-finality': finality} : {}), 'cache-control': 'no-store'};
}
