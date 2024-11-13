import {APIClient, Name, UInt64} from "@wharfkit/antelope";
import {Client} from "@elastic/elasticsearch";
import { join } from "path";
import { readFileSync } from "fs";
import { HyperionConnections } from "../../interfaces/hyperionConnections.js";
import { Collection, MongoClient } from "mongodb";
import { IVoter } from "../../interfaces/table-voter.js";
import { cargo } from "async";

const chain = process.argv[2];
const indexName = `${chain}-table-voters-v1`;

if (!chain) {
    console.log("Please select a chain run on!");
    process.exit();
}

console.log('Hyperion Account State Synchronizer');


const configDir = join(import.meta.dirname, '../../../config');

const connections = JSON.parse(readFileSync(join(configDir, "connections.json")).toString()) as HyperionConnections;

const _es = connections.elasticsearch;

const elastic = new Client({
    node: `${_es.protocol}://${_es.host}`,
    auth: {
        username: _es.user,
        password: _es.pass
    },
    pingTimeout: 100,
    tls: _es.protocol === 'https' ? {
        rejectUnauthorized: false
    } : undefined
});





const url = "http://localhost:8888";

const client = new APIClient({url});

let accounts = 0;

let currentBlock = 0;

let totalAccounts = 0;

const info = await client.v1.chain.get_info();
currentBlock = info.head_block_num.toNumber();

const uniqueAccounts = new Set<string>();

async function* scan() {
    let lb: UInt64 | undefined = undefined;
    let more = false;
    do {
        const result = await client.v1.chain.get_table_rows({
            code: "eosio",
            table: "voters",
            scope: "eosio",
            limit: 300,
            lower_bound: lb ? lb : undefined
        });

        for (const voter of result.rows) {

            const data = {
                block_num: currentBlock,
                is_proxy: voter.is_proxy === 1,
                last_vote_weight: voter.last_vote_weight,
                primary_key: Name.from(voter.owner).value.toString(),
                producers: voter.producers,
                proxied_vote_weight: voter.proxied_vote_weight,
                proxy: voter.proxy,
                staked: voter.staked,
                voter: voter.owner,
            }
            totalAccounts++;
            yield data;
        }
        lb = result.next_key;
        more = result.more;
        // console.log(`NEXT >>> ${lb} | ${Name.from(lb).value.toString()}`);
    } while (more);
}

async function main() {
    const _mongo = connections.mongodb;
    let mongoClient: MongoClient | undefined;
    let voterCollection: Collection<IVoter> | undefined;
    if (_mongo && _mongo.enabled) {
        let uri = "mongodb://";
        if (_mongo.user && _mongo.pass) {
            uri += `${_mongo.user}:${_mongo.pass}@${_mongo.host}:${_mongo.port}`;
        } else {
            uri += `${_mongo.host}:${_mongo.port}`;
        }
        mongoClient = new MongoClient(uri);
        await mongoClient.connect();
        voterCollection = mongoClient.db(`${_mongo.database_prefix}_${chain}`).collection('voters');
        await voterCollection.createIndex({voter: 1}, {unique: true});
        await voterCollection.createIndex({producers: 1}, {unique: false});
        await voterCollection.createIndex({is_proxy: 1}, {unique: false});
        const ping = await mongoClient?.db(`admin`).command({ping: 1});
        console.log(ping)
        console.log(`fim`)
    }

 

    try {
        if (voterCollection) {
            // console.log(`Votercolection`, voterCollection)
            const cargoQueue = cargo((docs: any[], cb) => {
                voterCollection.bulkWrite(docs.map(doc => {
                    return {
                        updateOne: {
                            filter: {
                                voter: doc.voter
                            },
                            update: {
                                $set: {
                                    block_num: doc.block_num,
                                    is_proxy: doc.is_proxy,
                                    last_vote_weight: doc.last_vote_weight,
                                    producers: doc.producers,
                                    proxied_vote_weight: doc.proxied_vote_weight,
                                    proxy: doc.proxy,
                                    staked: doc.staked,
                                }
                            },
                            upsert: true
                        }
                    };
                })).finally(() => {
                    cb();
                });
            }, 1000);

            for await (const doc of scan()) {
                cargoQueue.push(doc).catch(console.log);
            }

            await cargoQueue.drain();

            console.log(`Processed ${totalAccounts} accounts`);
            await mongoClient?.close();

        } else {
            const bulkResponse = await elastic.helpers.bulk({
                flushBytes: 1000000,
                datasource: scan(),
                onDocument: (doc) => [{index: {_id: doc.voter, _index: indexName}}, doc],
                onDrop: (doc) => console.log('doc', doc),
            });
            console.log(`bulkResponse`,bulkResponse);
            console.log(`${bulkResponse.successful} accounts`);
        }

    } catch (e) {
        console.log(e);
        process.exit();
    }
   
   
   
   
   
   
   
   
   
   
   
   
   


    // for await (const voter of scan()) {
    //     console.log(voter);
    //     accounts++;
    //     if(uniqueAccounts.has(voter.voter)) {
    //         console.log(`Duplicate Account: ${voter}`);
    //         process.exit();
    //     }
    //     uniqueAccounts.add(voter.voter);
    // }
    // console.log(`Total Accounts ${accounts}`);
}

main().catch(console.log);
