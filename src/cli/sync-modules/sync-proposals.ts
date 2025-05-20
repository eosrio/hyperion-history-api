import {Name, PackedTransaction, Serializer, UInt64} from "@wharfkit/antelope";
import {cargo} from "async";
import {Collection} from "mongodb";
import {IProposal} from "../../interfaces/table-proposal.js";

import {Synchronizer} from "./synchronizer.js";

export class ProposalSynchronizer extends Synchronizer<IProposal> {
    private proposalsCollection!: Collection<IProposal>;
    private abiCacheMap: Map<string, any> = new Map();

    constructor(chain: string) {
        super(chain, 'proposals');
    }

    protected async setupMongo() {
        await super.setupMongo('proposals', [
            {fields: {proposal_name: 1}},
            {fields: {proposer: 1}},
            {fields: {expiration: -1}},
            {fields: {"provided_approvals.actor": 1}},
            {fields: {"requested_approvals.actor": 1}}
        ]);

        this.proposalsCollection = this.collection as Collection<IProposal>;
    }

    private async getProposals(scope: string) {
        let lb: UInt64 | undefined = undefined;
        let more = false;
        const proposals: any[] = [];
        do {
            const result = await this.client.v1.chain.get_table_rows({
                code: "eosio.msig",
                table: "proposal",
                scope: scope,
                limit: 10,
                lower_bound: lb
            });
            lb = result.next_key;
            more = result.more;

            for (const proposal of result.rows) {
                const trx = PackedTransaction.from({packed_trx: proposal.packed_transaction}).getTransaction();
                delete proposal.packed_transaction;
                const transaction = {...Serializer.objectify(trx)};
                transaction.actions = [];
                for (const action of trx.actions) {
                    try {
                        let abi = this.abiCacheMap.get(action.account.toString());
                        if (!abi) {
                            abi = await this.client.v1.chain.get_abi(action.account.toString());
                            this.abiCacheMap.set(action.account.toString(), abi);
                        }
                        const decodedData = Serializer.objectify(action.decodeData(abi.abi));
                        transaction.actions.push({...Serializer.objectify(action), data: decodedData});
                    } catch (error: any) {
                        console.log(`Proposal: ${proposal.proposal_name} - Failed to decode action ${action.account}::${action.name} - ${error.message}`);
                        transaction.actions.push(Serializer.objectify(action));
                    }
                }
                proposals.push({...proposal, expiration: new Date(transaction.expiration), trx: transaction});
            }
        } while (more);
        return proposals;
    }

    private async getApprovals(scope: string) {
        let lb: UInt64 | undefined = undefined;
        let more = false;
        const approvals: any[] = [];
        do {
            const result = await this.client.v1.chain.get_table_rows({
                code: "eosio.msig",
                table: "approvals2",
                scope: scope,
                limit: 10,
                lower_bound: lb
            });
            lb = result.next_key;
            more = result.more;
            approvals.push(...result.rows);
        } while (more);
        return approvals;
    }

    private async* scan() {
        let lb = '';
        do {
            const result = await this.client.v1.chain.get_table_by_scope({
                code: "eosio.msig",
                table: "proposal",
                limit: 300,
                lower_bound: Name.from(lb).value.toString()
            });
            for (const row of result.rows) {
                const scope = row.scope.toString();
                const [proposals, approvals] = await Promise.all([this.getProposals(scope), this.getApprovals(scope)]);
                const proposalMap = new Map();

                for (const proposal of proposals) {
                    proposalMap.set(proposal.proposal_name, {...proposal});
                }
                for (const approval of approvals) {
                    const proposalMerge = proposalMap.get(approval.proposal_name);
                    if (proposalMerge) {
                        proposalMerge.proposer = scope;
                        proposalMerge.version = approval.version;
                        proposalMerge.requested_approvals = approval.requested_approvals.map(el => {
                            return {actor: el.level.actor, permission: el.level.permission, time: el.time};
                        });
                        proposalMerge.provided_approvals = approval.provided_approvals.map(el => {
                            return {actor: el.level.actor, permission: el.level.permission, time: el.time};
                        });
                    }
                }
                for (const entry of proposalMap.values()) {
                    this.totalItems++;
                    yield entry;
                }
            }
            lb = result.more;
        } while (lb !== '');
    }

    public async run() {
        const info = await this.client.v1.chain.get_info();
        this.currentBlock = info.head_block_num.toNumber();

        await this.setupMongo();

        const isMongoEnabled = this.connections.mongodb?.enabled === true;
        console.log(`MongoDB Enabled: ${isMongoEnabled}`);

        try {
            if (this.proposalsCollection) {
                const cargoQueue = cargo((docs: any[], cb) => {
                    this.proposalsCollection.bulkWrite(docs.map(doc => ({
                        updateOne: {
                            filter: {proposal_name: doc.proposal_name, proposer: doc.proposer},
                            update: {$set: doc},
                            upsert: true
                        }
                    }))).finally(() => cb());
                }, 1000);

                for await (const data of this.scan()) {
                    cargoQueue.push(data).catch(console.log);
                }

                await cargoQueue.drain();
                console.log(`Total Proposals Processed: ${this.totalItems}`);
                await this.mongoClient?.close();
            } else {
                console.log(`Elastic Enable`);
                const bulkResponse = await this.elastic.helpers.bulk({
                    datasource: this.scan(),
                    onDocument: (doc) => [{
                        index: {
                            _index: this.indexName,
                            _id: `${doc.proposer}-${doc.proposal_name}`
                        }
                    }, doc]
                });
                console.log(`${bulkResponse.successful} proposals`);
            }
        } catch (e) {
            console.log(e);
            throw e;
        }
    }
}

