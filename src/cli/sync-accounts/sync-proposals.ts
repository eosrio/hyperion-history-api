import { APIClient, Name, PackedTransaction, Serializer, UInt64 } from "@wharfkit/antelope";
import { get } from "lodash";
import { getProposalsHandler } from "../../api/routes/v2-state/get_proposals/get_proposals.js";
import { promises } from "dns";
import { abi } from "../../indexer/definitions/index-templates.js";
import { log } from "console";

const url = "http://localhost:8888";

const api = new APIClient({ url });

const abiCacheMap = new Map<string, any>();

let accounts = 0;

async function getProposals(scope) {
    let lb: UInt64 | undefined = undefined;
    let more = false;
    const proposals: any[] = [];
    do {
        const result = await api.v1.chain.get_table_rows({
            code: "eosio.msig",
            table: "proposal",
            scope: scope,
            limit: 10,
            lower_bound: lb ? lb : undefined
        });
        lb = result.next_key;
        more = result.more;
        // return result.rows;

        for (const proposal of result.rows) {
            const trx = PackedTransaction.from({ packed_trx: proposal.packed_transaction }).getTransaction();
            delete proposal.packed_transaction;
            const transaction = { ...Serializer.objectify(trx) };
            transaction.actions = [];
            if (trx.actions.length > 0) {
                for (const action of trx.actions) {

                    try {
                        let abi = abiCacheMap.get(action.account.toString());
                        if (!abi) {
                            abi = await api.v1.chain.get_abi(action.account.toString());
                            abiCacheMap.set(action.account.toString(), abi);
                        }
                        const decodedData = Serializer.objectify(action.decodeData(abi.abi));
                        const mergedAction = Serializer.objectify(action);
                        mergedAction.data = decodedData;
                        transaction.actions.push(mergedAction);
                    } catch (error: any) {
                        console.log(`Failed to deserialize action ${action.account}::${action.name} - ${error.message}`);
                        transaction.actions.push(Serializer.objectify(action));
                    }

                }
            }
            proposals.push({ ...proposal, trx: transaction });
        }
    } while (more);
    return proposals;
}

async function getApprovals(scope) {
    let lb: UInt64 | undefined = undefined;
    let more = false;
    const approvals: any[] = [];

    do {
        const result = await api.v1.chain.get_table_rows({
            code: "eosio.msig",
            table: "approvals2",
            scope: scope,
            limit: 10,
            lower_bound: lb ? lb : undefined
        });
        lb = result.next_key;
        more = result.more;
        // return result.rows;

        for (const proposal of result.rows) {
            approvals.push(proposal);
        }
    } while (more);

    return approvals;
}


async function* scan() {
    let lb = '';
    do {
        const result = await api.v1.chain.get_table_by_scope({
            code: "eosio.msig",
            table: "proposal",
            limit: 300,
            lower_bound: Name.from(lb).value.toString()
        });
        for (const row of result.rows) {
            try {
                const scope = row.scope.toString();
                const [proposals, approvals] = await Promise.all([getProposals(scope), getApprovals(scope)]);

                const proposalMap = new Map();
                for (const proposal of proposals) {
                    proposalMap.set(proposal.proposal_name, { ...proposal });
                }

                for (const approval of approvals) {
                    const proposalMerge = proposalMap.get(approval.proposal_name);
                    if (proposalMerge) {
                        proposalMerge.proposer = scope;
                        proposalMerge.version = approval.version;
                        proposalMerge.requested_approvals = approval.requested_approvals;
                        proposalMerge.provided_approvals = approval.provided_approvals;
                    }
                }

                for (const entry of proposalMap.values()) {
                    yield entry;
                }
            } catch (error: any) {
                console.log(row, error.message);
            }
        }
        lb = result.more;
        // console.log(`NEXT >>> ${lb} | ${Name.from(lb).value.toString()}`);
    } while (lb !== '');
}

async function main() {
    for await (const data of scan()) {
        accounts++;
        if (data.proposer === 'onurbtesteee') {
            console.log(data);
            console.log(`action`, data.trx.actions)
        }
    }
    console.log(`Total Accounts ${accounts}`);
}

main().catch(console.log);
