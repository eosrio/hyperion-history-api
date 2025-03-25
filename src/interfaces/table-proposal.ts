export interface ITransaction {
    expiration: string;
    ref_block_num: number;
    ref_block_prefix: number;
    max_net_usage_words: number;
    max_cpu_usage_ms: number;
    delay_sec: number;
    context_free_actions: any[];
    actions: Array<{
        account: string;
        name: string;
        authorization: Array<{
            actor: string;
            permission: string;
        }>;
        data: {
            payer: string;
            receiver: string;
            quant: string;
        };
    }>;
    transaction_extensions: any[];
}

export interface IApproval {
    actor: string;
    permission: string;
    time: string;
}


export interface IProposal {
    proposal_name: string;
    expiration: string;
    trx: ITransaction;
    amount: number | string;
    code: string;
    scope: string;
    proposer: string;
    version: number;
    requested_approvals: IApproval[];
    provided_approvals: IApproval[];
}




