import {Message} from "amqplib";
import {omit} from "radash";
import {createHash} from "node:crypto";
import {flatMap, makeDelOp, makeScriptedOp, MaxBlockCb, MMap, RouterFunction} from "./elastic-routes.js";

export function buildAbiBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload: Message, body: any) => {
        const id = body['block'] + body['account'];
        console.log('buildAbiBulk', id);
        messageMap.set(id, omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}

export function buildActionBulk(
    payloads: Message[],
    messageMap: MMap,
    maxBlockCb: MaxBlockCb,
    routerFunc: RouterFunction | null,
    indexName: string
): any[] {
    if (routerFunc) {
        return flatMap(payloads, (payload: Message, body: any) => {
            const id = body['global_sequence'];
            messageMap.set(id, omit(payload, ['content']));
            return [{
                index: {
                    _id: id,
                    _index: `${indexName}-${routerFunc(body.block_num)}`
                }
            }, body];
        });
    } else {
        return [];
    }
}

export function buildBlockBulk(
    payloads: Message[],
    messageMap: MMap
): any[] {
    return flatMap(payloads, (payload: Message, body: any) => {
        const id = body['block_num'];
        messageMap.set(id, omit(payload, ['content']));
        return [{
            index: {
                _id: id
            }
        }, body];
    });
}

export function buildDeltaBulk(
    payloads: Message[],
    messageMap: MMap,
    maxBlockCb: MaxBlockCb,
    routerFunc: RouterFunction | null,
    indexName: string
): any[] {
    if (routerFunc) {
        let maxBlock = 0;
        const flat_map = flatMap(payloads, (payload: Message, body: any) => {
            if (maxBlock < body.block_num) {
                maxBlock = body.block_num;
            }
            const id = `${body.block_num}-${body.code}-${body.scope}-${body.table}-${body.primary_key}`;
            messageMap.set(id, omit(payload, ['content']));
            return [{
                index: {
                    _id: id,
                    _index: `${indexName}-${routerFunc(body.block_num)}`
                }
            }, body];
        });
        maxBlockCb(maxBlock);
        return flat_map;
    } else {
        return [];
    }
}

export function buildDynamicTableBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload: Message, body: any) => {
        const id = payload.properties.messageId;
        messageMap.set(payload.properties.messageId.id, omit(payload, ['content']));
        if (body.present === 0) {
            return makeDelOp(id);
        } else {
            return makeScriptedOp(id, body);
        }
    });
}

export function buildTableProposalsBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload: Message, body: any) => {
        const id = `${body.proposer}-${body.proposal_name}-${body.primary_key}`;
        messageMap.set(id, omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

export function buildTableAccountsBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.code}-${body.scope}-${body.symbol}`;
        messageMap.set(id, omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

export function buildTableVotersBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.voter}`;
        messageMap.set(id, omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

export function buildLinkBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.account}-${body.permission}-${body.code}-${body.action}`;
        messageMap.set(id, omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

export function buildPermBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.owner}-${body.name}`;
        messageMap.set(id, omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

export function buildResLimitBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.owner}`;
        messageMap.set(id, omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

export function buildResUsageBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.owner}`;
        messageMap.set(id, omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

export function buildGenTrxBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const hash = createHash('sha256')
            .update(body.sender + body.sender_id + body.payer)
            .digest()
            .toString("hex");
        const id = `${body.block_num}-${hash}`;
        messageMap.set(id, omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}

export function buildTrxErrBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = body.trx_id.toLowerCase();
        delete body.trx_id;
        messageMap.set(id, omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}
