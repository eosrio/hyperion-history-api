import {readFileSync} from "node:fs";
import {APIClient, Name, Serializer} from "@wharfkit/antelope";
import {Client} from "@elastic/elasticsearch";

const chain = process.argv[2];
const indexName = `${chain}-table-accounts-v1`;

if (!chain) {
    console.log("Please select a chain run on!");
    process.exit();
}

console.log('Hyperion Account State Synchronizer');

const connections = JSON.parse(readFileSync("./connections.json").toString());

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

let endpoint: string = '';
if (connections && connections.chains) {
    endpoint = connections.chains[chain].http;
}

if (!endpoint) {
    console.log("No HTTP Endpoint!");
    process.exit();
}

const client = new APIClient({
    url: endpoint
});

let totalScopes = 0;
let processedScopes = 0;
const contractAccounts: string[] = [];
const tokenContracts: string[] = [];
let totalAccounts = 0;
let currentBlock = 0;
let currentContract = '';
let currentScope = '';

async function getAbiHashTable(lb?: any) {
    const data = await client.v1.chain.get_table_rows({
        table: 'abihash',
        code: 'eosio',
        scope: 'eosio',
        limit: 100,
        lower_bound: lb
    });
    if (data.rows) {
        for (let row of data.rows) {
            contractAccounts.push(row.owner);
        }
        if (data.next_key) {
            await getAbiHashTable(data.next_key);
        } else {
            console.log("End of search");
        }
    }
}

const transferFields = [
    {
        name: "from",
        type: "name",
    }, {
        name: "to",
        type: "name",
    }, {
        name: "quantity",
        type: "asset",
    }, {
        name: "memo",
        type: "string",
    }
];

async function scanABIs() {
    for (const contract of contractAccounts) {
        try {
            const abi = await client.v1.chain.get_abi(contract);
            const tables = new Set(abi.abi?.tables?.map(value => value.name));
            if (tables.has("accounts") && tables.has("stat")) {
                const actions = new Set(abi.abi?.actions?.map(value => value.name));
                if (actions.has("transfer")) {
                    const transferType = abi.abi?.structs?.find(s => s.name === 'transfer');
                    if (transferType && transferType.fields) {
                        const fields = transferType.fields;
                        let valid = true;
                        for (let i = 0; i < transferFields.length; i++) {
                            if ((fields[i].name === "from" || fields[i].name === "to") && fields[i].type === 'account_name') {
                                valid = true;
                                continue;
                            }
                            if (fields[i].name !== transferFields[i].name || fields[i].type !== transferFields[i].type) {
                                console.error(`Invalid token contract ${contract} ->> ${fields.map(f => (f.name + "(" + f.type + ")").padEnd(24, " ")).join('  ')}`);
                                valid = false;
                                break;
                            }
                        }
                        if (valid) {
                            tokenContracts.push(contract);
                        }
                    }
                }
            }
        } catch (e: any) {
            console.log(`Error processing contract: ${contract} - ${e.message}`);
        }
    }
}

async function* processContracts(tokenContracts: string[]) {
    for (const contract of tokenContracts) {
        currentContract = contract;
        let lowerBound: string = '';
        do {
            const scopes = await client.v1.chain.get_table_by_scope({
                table: "accounts",
                code: contract,
                limit: 1000,
                lower_bound: Name.from(lowerBound).value.toString()
            });
            const rows = scopes.rows;
            for (const row of rows) {
                try {
                    const account = row.scope.toString();
                    const result = await client.v1.chain.get_currency_balance(contract, account);
                    currentScope = account;
                    const balances = Serializer.objectify(result);
                    for (const balance of balances) {
                        const [amount, symbol] = balance.split(' ');
                        const amountFloat = parseFloat(amount);
                        totalAccounts++;
                        const doc = {
                            amount: amountFloat,
                            block_num: currentBlock,
                            code: contract,
                            present: 1,
                            scope: account,
                            symbol: symbol
                        };
                        yield doc;
                    }
                } catch (e: any) {
                    console.log(`Failed to check balance ${row.scope}@${contract} - ${e.message}`);
                }
            }
            lowerBound = scopes.more;
        } while (lowerBound !== '');
        processedScopes++;
    }
}

async function main() {
    const tRef = Date.now();
    const info = await client.v1.chain.get_info();
    currentBlock = info.head_block_num.toNumber();
    console.log(await elastic.ping());
    await getAbiHashTable();
    console.log(`Number of contract candidates: ${contractAccounts.length}`);
    await scanABIs();
    console.log(`Number of validated token contracts: ${tokenContracts.length}`);
    totalScopes += tokenContracts.length;
    const progress = setInterval(() => {
        console.log(`Progress: ${processedScopes}/${totalScopes} (${((processedScopes / totalScopes) * 100).toFixed(2)}%) - ${currentScope}@${currentContract} - ${totalAccounts} accounts`);
    }, 1000);
    try {
        const bulkResponse = await elastic.helpers.bulk({
            flushBytes: 1000000,
            datasource: processContracts(tokenContracts),
            onDocument: (doc) => [{index: {_id: `${doc.code}-${doc.scope}-${doc.symbol}`, _index: indexName}}, doc]
        });
        console.log(`${bulkResponse.successful} accounts`);
    } catch (e) {
        console.log(e);
        process.exit();
    }
    clearInterval(progress);
    const tFinal = Date.now();
    console.log(`Processing took: ${(tFinal - tRef)}ms`);
}

main().catch(console.log);
