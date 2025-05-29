import { Name, PublicKey } from "@wharfkit/antelope";
import { cargo } from "async";
import { Collection } from "mongodb";
import { IPermission } from "../../interfaces/table-permissions.js";
import { Synchronizer } from "./synchronizer.js";

export class PermissionsSynchronizer extends Synchronizer<IPermission> {
    private processedScopes: number = 0;
    private permissionsCollection?: Collection<IPermission>;
    private systemTokenContract = 'eosio.token';

    constructor(chain: string) {
        super(chain, 'permissions');
    }

    protected async setupMongo() {
        await super.setupMongo('permissions', [
            { fields: { account: 1, perm_name: 1 }, options: { unique: true } },
            { fields: { block_num: 1 }, options: { unique: false } },
            { fields: { account: 1 }, options: { unique: false } },
            { fields: { perm_name: 1 }, options: { unique: false } },
            { fields: { parent: 1 }, options: { unique: false } },
            { fields: { "linked_actions.account": 1 }, options: { unique: false } },
            { fields: { "linked_actions.action": 1 }, options: { unique: false } }
        ]);

        this.permissionsCollection = this.collection as Collection<IPermission>;
    }

    private async *scan() {
        let lowerBound: string = '';
        do {
            const scopes = await this.client.v1.chain.get_table_by_scope({
                table: "accounts",
                code: this.systemTokenContract,
                limit: 1000,
                lower_bound: Name.from(lowerBound).value.toString()
            });
            const rows = scopes.rows;
            for (const row of rows) {
                yield row.scope.toString();
            }
            lowerBound = scopes.more;
        } while (lowerBound !== '');
        this.processedScopes++;
    }

    public async run(): Promise<void> {

        const info = await this.client.v1.chain.get_info();
        this.currentBlock = info.head_block_num.toNumber();

        await this.setupMongo();

        if (!this.permissionsCollection) {
            throw new Error("Permissions collection is not initialized.");
        }

        console.log(`Starting permissions synchronization for ${this.chain} at block ${this.currentBlock}.`);
        this.totalItems = 0;
        this.processedScopes = 0;
        console.log(`Processing scopes for permissions...`);

        const cargoQueue = cargo((docs: any[], cb) => {
            this.permissionsCollection!.bulkWrite(docs.map(doc => {
                return {
                    updateOne: {
                        filter: {
                            account: doc.account,
                            perm_name: doc.perm_name
                        },
                        update: {
                            $set: doc
                        },
                        upsert: true
                    }
                };
            })).finally(() => {
                cb();
            });
        }, 1000);


        for await (const accountName of this.scan()) {
            if (accountName) {
                const info = await this.client.call({
                    path: "/v1/chain/get_account",
                    params: {
                        account_name: accountName
                    }
                }) as any;
                if (info.permissions) {
                    for (const perm of info.permissions) {
                        if (perm.required_auth && perm.required_auth.keys && perm.required_auth.keys.length > 0) {
                            perm.required_auth.keys = perm.required_auth.keys.map((key: any) => {
                                const publicKey = PublicKey.from(key.key);
                                return {
                                    key: publicKey.toString(),
                                    weight: key.weight
                                };
                            });
                        } else {
                            perm.required_auth.keys = [];
                        }
                        const permissionData: IPermission = {
                            block_num: this.currentBlock,
                            account: accountName,
                            perm_name: perm.perm_name,
                            parent: perm.parent,
                            required_auth: perm.required_auth,
                            linked_actions: perm.linked_actions || [],
                            last_updated: info.head_block_time ?? ""
                        };
                        // if (permissionData.linked_actions && permissionData.linked_actions.length > 0) {
                        //     console.dir(permissionData, { depth: Infinity });
                        // }
                        this.totalItems++;
                        cargoQueue.push(permissionData).catch(console.error);
                    }
                }
            }
        }
        await cargoQueue.drain();
        console.log(`Processed ${this.totalItems} permissions for ${this.processedScopes} scopes.`);
        await this.mongoClient?.close();
    }
}