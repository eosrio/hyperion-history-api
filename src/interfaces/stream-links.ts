import {RequestFilter} from "./stream-requests.js";

/**
 * ActionLink interface represents a subscription connection between a client and a relay socket
 * for handling action events in the blockchain. It maintains the connection details, filtering options,
 * and metadata required for processing and routing action messages to subscribed clients.
 */
export interface ActionLink {
    /**
     * Type of link - 'action' for action event subscriptions
     */
    type: 'action';

    /**
     * ID of the relay socket handling this subscription
     */
    relay: string;

    /**
     * Unique ID for this request
     */
    reqUUID: string;

    /**
     * Client socket ID
     */
    client: string;

    /**
     * Filters to apply on action messages
     */
    filters?: RequestFilter[];

    /**
     * Account to filter actions by
     */
    account: string;

    /**
     * Timestamp when this subscription was created
     */
    added_on: number;

    /**
     * Logic operation to apply on filters ('and' or 'or')
     */
    filter_op?: 'and' | 'or';
}

/**
 * DeltaLink interface represents a subscription connection between a client and a relay socket
 * for handling delta events in the blockchain. It maintains the connection details, filtering options,
 * and metadata required for processing and routing delta messages from the blockchain to subscribed clients.
 */
export interface DeltaLink {
    /**
     * Type of link - 'delta' for delta event subscriptions
     */
    type: 'delta';

    /**
     * ID of the relay socket handling this subscription
     */
    relay: string;

    /**
     * Unique ID for this request
     */
    reqUUID: string;

    /**
     * Client socket ID
     */
    client: string;

    /**
     * Optional filters to apply on delta messages
     */
    filters?: RequestFilter[];

    /**
     * Optional payer account to filter deltas by
     */
    payer?: string;

    /**
     * Timestamp when this subscription was created
     */
    added_on: number;

    /**
     * Logic operation to apply on filters ('and' or 'or')
     */
    filter_op?: 'and' | 'or';
}
