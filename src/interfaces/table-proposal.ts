import {Document} from "mongodb";

export interface IProposal extends Document {
    proposal_name: string;
    proposer: string;
    version: number;
    expiration: Date;
    trx: any;
    requested_approvals: Array<{
        actor: string;
        permission: string;
        time: string;
    }>;
    provided_approvals: Array<{
        actor: string;
        permission: string;
        time: string;
    }>;
}
