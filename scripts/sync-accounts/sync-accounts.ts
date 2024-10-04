import {readFileSync} from "node:fs";
import {APIClient, Serializer} from "@wharfkit/antelope";
import {Client} from "@elastic/elasticsearch";

const chain = process.argv[2];

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

const uniqueTokenHolders = new Set();
let tokenHolderData: any[] = [];
const contractAccounts: string[] = [];
const tokenContracts: string[] = [];

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

                            if ((transferFields[i].name === "from" || transferFields[i].name === "to") && transferFields[i].type === 'account_name') {
                                transferFields[i].type = 'name';
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

async function findScopes(contract: string, accounts: any[], lb?: any) {
    const scopes = await client.v1.chain.get_table_by_scope({
        table: "accounts",
        code: contract,
        limit: 500,
        lower_bound: lb
    });
    if (scopes.rows && scopes.rows.length > 0) {
        const rows = scopes.rows;
        rows.forEach(value => {
            accounts.push({
                scope: value.scope.toString()
            });
        });
        if (scopes.more) {
            await findScopes(contract, accounts, scopes.more);
        }
    }
}

async function fillBalances(contract: string, accounts: any[]) {
    for (const account of accounts) {
        try {
            const balances = await client.v1.chain.get_currency_balance(contract, account.scope);
            account.balances = Serializer.objectify(balances);
            uniqueTokenHolders.add(account);
        } catch (e: any) {
            console.log(`Failed to check balance ${account.scope}@${contract} - ${e.message}`);
        }
    }
}

async function scanTokenContracts() {
    for (const contract of tokenContracts) {
        const accounts = [];
        await findScopes(contract, accounts);
        await fillBalances(contract, accounts);
        tokenHolderData.push([contract, accounts]);
    }
}

async function main() {
    const tRef = Date.now();

    const info = await client.v1.chain.get_info();
    const currentBlock = info.head_block_num;

    // check account table on ES
    console.log(await elastic.ping());
    const indexName = `${chain}-table-accounts-v1`;
    await getAbiHashTable();
    console.log(`Number of contract candidates: ${contractAccounts.length}`);
    await scanABIs();
    console.log(`Number of validated token contracts: ${tokenContracts.length}`);
    await scanTokenContracts();
    console.log(`Unique holders: ${uniqueTokenHolders.size}`);

    try {
        for (const entry of tokenHolderData) {
            const contract = entry[0];
            const data = entry[1];

            if (data.length === 0) {
                continue;
            }

            async function* accounts() {
                for (const account of data) {
                    try {
                        for (const balance of account.balances) {
                            const [amount, symbol] = balance.split(' ');
                            const amountFloat = parseFloat(amount);
                            const doc = {
                                amount: amountFloat,
                                block_num: currentBlock.toNumber(),
                                code: contract,
                                present: 1,
                                scope: account.scope,
                                symbol: symbol
                            };
                            yield doc;
                        }
                    } catch (e: any) {
                        console.log(`Error processing account ${account} on ${contract} - ${e.message}`);
                        console.log(account);
                    }
                }
            }

            const bulkResponse = await elastic.helpers.bulk({
                datasource: accounts(),
                onDocument: (doc) => [{index: {_id: `${doc.code}-${doc.scope}-${doc.symbol}`, _index: indexName}}, doc]
            });

            console.log(`${contract} ->> ${bulkResponse.successful} accounts`);
        }
    } catch (e) {
        console.log(e);
        process.exit();
    }

    const tFinal = Date.now();
    console.log(`Processing took: ${(tFinal - tRef)}ms`);

}

main().catch(console.log);
