import {Asset, Struct} from "@wharfkit/antelope";

export class TokenAccount extends Struct {
    static abiName = "accounts";
    static abiFields = [
        {
            name: "balance",
            type: Asset
        }
    ];
    balance!: Asset
}
