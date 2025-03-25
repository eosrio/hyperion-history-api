import {APIClient, Name, PackedTransaction, Serializer, UInt64} from "@wharfkit/antelope";
import {Client} from "@elastic/elasticsearch";
import {MongoClient} from "mongodb";
import {readFileSync} from "fs";
import {join} from "path";
import {cargo} from "async";

const chain = process.argv[2];
if (!chain) {
    console.log("Please select a chain to run on!");
    process.exit();
}

console.log('MultiSig Proposals Synchronizer');

const configDir = join(import.meta.dirname, '../../../config');
const connections = JSON.parse(readFileSync(join(configDir, "connections.json")).toString());

const endpoint = connections.chains[chain].http;
const api = new APIClient({url: endpoint});

if (!endpoint) {
    console.log("No HTTP Endpoint!");
    process.exit();
}

const _es = connections.elasticsearch;
const elastic = new Client({
    node: `${_es.protocol}://${_es.host}`,
    auth: {username: _es.user, password: _es.pass},
    tls: _es.protocol === 'https' ? {rejectUnauthorized: false} : undefined
});

const _mongo = connections.mongodb;
const mongoClient = new MongoClient(`mongodb://${_mongo.host}:${_mongo.port}`);
const proposalsCollection = mongoClient.db(`${_mongo.database_prefix}_${chain}`).collection("proposals");


const abiCacheMap = new Map<string, any>();
let accounts = 0;


async function getProposals(scope: string) {
    let lb: UInt64 | undefined = undefined;
    let more = false;
    const proposals: any[] = [];
    do {
        const result = await api.v1.chain.get_table_rows({
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
                    let abi = abiCacheMap.get(action.account.toString());
                    if (!abi) {
                        abi = await api.v1.chain.get_abi(action.account.toString());
                        abiCacheMap.set(action.account.toString(), abi);
                    }
                    const decodedData = Serializer.objectify(action.decodeData(abi.abi));
                    transaction.actions.push({...Serializer.objectify(action), data: decodedData});
                } catch (error: any) {
                    console.log(`Proposal: ${proposal.proposal_name} - Failed to decode action ${action.account}::${action.name} - ${error.message}`);
                    transaction.actions.push(Serializer.objectify(action));
                }
            }
            // console.log("Proposal:", proposal);
            // console.log("Transaction Expiration:", transaction.expiration, typeof transaction.expiration);
            proposals.push({...proposal, expiration: new Date(transaction.expiration), trx: transaction});
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
            lower_bound: lb
        });
        lb = result.next_key;
        more = result.more;
        approvals.push(...result.rows);
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
            const scope = row.scope.toString();
            const [proposals, approvals] = await Promise.all([getProposals(scope), getApprovals(scope)]);
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

                yield entry;
            }
        }
        lb = result.more;
    } while (lb !== '');
}

async function main() {
    const isMongoEnabled = _mongo?.enabled === true;
    console.log(`MongoDB Enabled: ${isMongoEnabled}`);
    try {
        await mongoClient.connect();
        if (isMongoEnabled && proposalsCollection) {

            await proposalsCollection.createIndexes([
                {key: {proposal_name: 1}},
                {key: {proposer: 1}},
                {key: {expiration: -1}},
                {key: {"provided_approvals.actor": 1}},
                {key: {"requested_approvals.actor": 1}}
            ]);

            const cargoQueue = cargo((docs: any[], cb) => {
                proposalsCollection.bulkWrite(docs.map(doc => ({
                    updateOne: {
                        filter: {proposal_name: doc.proposal_name, proposer: doc.proposer},
                        update: {$set: doc},
                        upsert: true
                    }
                }))).finally(() => cb());
            }, 1000); // 1k docs per batch

            for await (const data of scan()) {
                accounts++;
                cargoQueue.push(data).catch(console.log);
            }

            await cargoQueue.drain();
        } else {
            console.log(`Elastic Enable`)
            const bulkResponse = await elastic.helpers.bulk({
                datasource: scan(),
                onDocument: (doc) => [{
                    index: {
                        _index: `${chain}-table-proposals-v1`,
                        _id: `${doc.proposer}-${doc.proposal_name}`
                    }
                }, doc]
            });
            accounts = bulkResponse.total;
        }

        console.log(`Total Proposals Processed: ${accounts}`);
    } finally {
        await mongoClient.close();
    }
}

main().catch(console.log);
