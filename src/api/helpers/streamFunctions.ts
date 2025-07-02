import {checkMetaFilter} from "../../indexer/helpers/common_functions.js";
import {RequestFilter, StreamActionsRequest, StreamDeltasRequest} from "../../interfaces/stream-requests.js";

export function processActionRequests(
    actionClientMap: Map<string, Map<string, Map<string, StreamActionsRequest>>>,
    actionName: string,
    account: string,
    message: string,
    targetClients: Map<string, string[]>
): void {
    if (!actionClientMap.has(actionName)) return;
    actionClientMap.get(actionName)?.forEach((requests, clientId) => {
        // console.log(requests);

        if (!targetClients.has(clientId)) {
            targetClients.set(clientId, []);
        }

        requests.forEach((request, uuid) => {
            if (checkActionFilters(request, account, message)) {
                targetClients.get(clientId)?.push(uuid);
            }
        });
    });
}

export function processTableRequests(
    tableClientMap: Map<string, Map<string, Map<string, StreamDeltasRequest>>>,
    tableId: string,
    payer: string,
    scope: string,
    message: string,
    targetClients: Map<string, string[]>
): void {
    if (!tableClientMap.has(tableId)) return;

    tableClientMap.get(tableId)?.forEach((requests, clientId) => {

        if (!targetClients.has(clientId)) {
            targetClients.set(clientId, []);
        }

        requests.forEach((request, uuid) => {
            if (scope && request.scope && request.scope !== scope) return;
            if (checkDeltaFilters(request, payer, message)) {
                targetClients.get(clientId)?.push(uuid);
            }
        });

        // check if the client has any valid requests before removing it
        const targetClient = targetClients.get(clientId);
        if (targetClient && targetClient.length === 0) {
            targetClients.delete(clientId);
        }
    });
}

export function checkActionFilters(request: StreamActionsRequest, account: string, msg: string): boolean {
    let allow: boolean;
    if (request.account) {
        allow = request.account === account;
    } else {
        allow = true;
    }
    if (allow && request.filters && request.filters?.length > 0) {
        const parsedMsg = JSON.parse(msg);
        if (request.filter_op === 'or') {
            allow = request.filters.some((f: RequestFilter) => checkMetaFilter(f, parsedMsg, 'action'));
        } else {
            allow = request.filters.every((f: RequestFilter) => checkMetaFilter(f, parsedMsg, 'action'));
        }
    }
    return allow;
}

export function checkDeltaFilters(request: StreamDeltasRequest, payer: string, msg: string): boolean {
    let allow: boolean;
    if (request.payer) {
        allow = request.payer === payer;
    } else {
        allow = true;
    }
    if (allow && request.filters && request.filters?.length > 0) {
        const parsedMsg = JSON.parse(msg);
        if (request.filter_op === 'or') {
            allow = request.filters.some((f: RequestFilter) => checkMetaFilter(f, parsedMsg, 'delta'));
        } else {
            allow = request.filters.every((f: RequestFilter) => checkMetaFilter(f, parsedMsg, 'delta'));
        }
    }
    return allow;
}
