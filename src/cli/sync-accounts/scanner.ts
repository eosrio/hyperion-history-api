import {APIClient, Name} from "@wharfkit/antelope";

const url = "http://192.168.0.215:18011";

const api = new APIClient({url});

let accounts = 0;

async function* scan() {
    let lb = '';
    do {
        const result = await api.v1.chain.get_table_by_scope({
            code: "eosio",
            table: "userres",
            limit: 1000,
            lower_bound: Name.from(lb).value.toString()
        });
        for (const row of result.rows) {
            const scope = row.scope.toString();
            yield scope;
        }
        lb = result.more;
        console.log(`NEXT >>> ${lb} | ${Name.from(lb).value.toString()}`);
    } while (lb !== '');
}

async function main() {
    for await (const scope of scan()) {
        console.log(scope);
        accounts++;
    }
    console.log(`Total Accounts ${accounts}`);
}

main().catch(console.log);
