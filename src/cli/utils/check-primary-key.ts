import {ABI, APIClient, Asset, Name, UInt64} from '@wharfkit/antelope';
import {createHash} from "node:crypto"


export async function findAndValidatePrimaryKey(contractName: string, tableName: string, client: APIClient) {
    console.log(`🔍 Attempting to find and validate PK for ${contractName}::${tableName}`);

    let abi: ABI;
    let table: ABI.Table | undefined;
    let struct: ABI.Struct | undefined;
    let candidateFields: any[] = [];

    try {
        const abiResponse = await client.v1.chain.get_abi(contractName);
        if (!abiResponse.abi) {
            console.error('❌ Could not fetch ABI.');
            return;
        }

        abi = ABI.from(abiResponse.abi);

        table = abi.tables.find((t) => t.name.toString() === tableName);
        if (!table) {
            console.error(`❌ Table "${tableName}" not found in ABI.`);
            return;
        }

        struct = abi.structs.find((s) => s.name.toString() === table!.type.toString());
        if (!struct) {
            console.error(`❌ Struct "${table.type}" for table "${tableName}" not found in ABI.`);
            return;
        }

        console.log(`ℹ️ Table uses struct "${struct.name}" and primary index type "${table.index_type.toString()}"`);

        for (const field of struct.fields) {
            console.log(`  -> Field: ${field.name} (${field.type})`);
            switch (field.type) {
                case 'name':
                case 'i64':
                case 'asset':
                    candidateFields.push({name: field.name.toString(), type: field.type.toString()});
                    console.log(`  -> Candidate (Type Match): ${field.name} (${field.type})`);
                    break;

            }
        }

    } catch (error: any) {
        console.error('❌ Error during ABI processing or candidate identification:', error.message || error);
        return;
    }

    // Find scope logic, search first using the contract name
    let foundScope: string | null = null;
    let selfScopeAttempt = false;
    try {
        console.log(`\n🔎 Searching for a non-empty scope for table ${tableName}...`);
        const limitPerScopeCall = 1000;
        let lowerBoundScope: string = contractName;
        do {
            const scopeResponse = await client.v1.chain.get_table_by_scope({
                code: contractName,
                table: tableName,
                limit: limitPerScopeCall,
                lower_bound: Name.from(lowerBoundScope).value.toString()
            });
            const scopeRows = scopeResponse.rows;
            for (const scopeInfo of scopeRows) {
                if (scopeInfo.count.toNumber() > 0) {
                    foundScope = Name.from(scopeInfo.scope).toString();
                    console.log(`  -> Found non-empty scope: "${foundScope}" (count: ${scopeInfo.count.toNumber()})`);
                    break;
                }
            }
            if (foundScope) {
                break;
            }
            if (lowerBoundScope === contractName && !selfScopeAttempt) {
                selfScopeAttempt = true;
                lowerBoundScope = '';
            } else {
                lowerBoundScope = scopeResponse.more;
            }
        } while (lowerBoundScope !== '');

        if (!foundScope) {
            console.warn(`⚠️ Could not find any non-empty scope for ${contractName}::${tableName}. Cannot perform data validation.`);
            console.log(`ℹ️ Based on convention, the primary key *should* be: ${candidateFields[0]?.name ?? 'N/A'}`);
            return;
        }
    } catch (error: any) {
        console.error(`❌ Error during get_table_by_scope call:`, error.message || error);
        console.warn(`⚠️ Could not automatically find a scope. Cannot perform data validation.`);
        console.log(`ℹ️ Based on convention, the primary key *should* be: ${candidateFields[0]?.name ?? 'N/A'}`);
        return;
    }


    try {
        // Fetch Sample Row (remains the same)
        console.log(`\nFetching sample row from scope "${foundScope}"...`);
        const sampleRowResponse = await client.v1.chain.get_table_rows({
            code: contractName,
            table: tableName,
            scope: foundScope,
            limit: 1,
            json: true,
        });

        if (!sampleRowResponse.rows || sampleRowResponse.rows.length === 0) {
            console.warn(`⚠️ Could not fetch a sample row from scope "${foundScope}". Cannot validate.`);
            console.log(`ℹ️ Based on convention, the primary key *should* be: ${candidateFields[0]?.name ?? 'N/A'}`);
            return;
        }

        const sampleRowData = sampleRowResponse.rows[0];
        // console.log('ℹ️ Sample row data fetched:', sampleRowData);

        // create sha256 hash of the sample row data
        const sampleRowDataHash = createHash('sha256').update(Buffer.from(JSON.stringify(sampleRowData))).digest('hex');
        // console.log('ℹ️ Sample row data hash:', sampleRowDataHash.toString());

        // Validation Loop
        let validatedPkField: string | null = null;
        let validatedPkFieldType: string | null = null;

        for (const candidate of candidateFields) {
            console.log(`\n🧪 Validating candidate field: "${candidate.name}"`);

            const keyValue = sampleRowData[candidate.name];
            if (keyValue === undefined || keyValue === null) {
                console.warn(`  ⚠️ Value for field "${candidate.name}" not found in sample row. Skipping.`);
                continue;
            }

            let formattedKeyValue: Name | UInt64 = UInt64.from(0);

            switch (candidate.type) {
                case 'asset':
                    // Handle asset type
                    formattedKeyValue = Asset.from(keyValue).symbol.code.value;
                    break;
                case 'name':
                    // Handle name type
                    formattedKeyValue = Name.from(keyValue);
                    break;
                case 'i64':
                    // Handle i64 type
                    formattedKeyValue = UInt64.from(keyValue);
                    break;
            }

            try {
                const validationResponse = await client.v1.chain.get_table_rows({
                    code: contractName,
                    table: tableName,
                    scope: foundScope,
                    lower_bound: formattedKeyValue,
                    upper_bound: formattedKeyValue,
                    limit: 1,
                    json: true,
                });
                // --------------------------------------------------

                if (validationResponse.rows && validationResponse.rows.length === 1) {
                    const returnedRow = validationResponse.rows[0];
                    const returnedValueHash = createHash('sha256').update(Buffer.from(JSON.stringify(returnedRow))).digest('hex');
                    // console.log('ℹ️ Returned row data:', returnedRow);

                    if (returnedValueHash.toString() === sampleRowDataHash.toString()) {
                        console.log(`✅ SUCCESS: Field "${candidate.name}" behaves like the primary key.`);
                        validatedPkField = candidate.name;
                        validatedPkFieldType = candidate.type;
                        break; // Found it!
                    } else {
                        console.warn(`  ⚠️ Hash mismatch between sample row and returned row for field "${candidate.name}".`);
                    }
                } else {
                    console.log(`  -> FAILED: Query returned ${validationResponse.rows?.length ?? 0} rows. Not the PK.`);
                }
            } catch (error: any) {
                console.error(`  -> ERROR during validation query for "${candidate.name}" with typed bound ${candidate.type}:`, error.message || error);
                if (error.details) console.error('  -> Error Details:', JSON.stringify(error.details));
            }
        }

        // Output Result (remains the same)
        console.log('\n--- Validation Complete ---');
        if (validatedPkField) {
            console.log(`✅ Validated Primary Key Field: ${validatedPkField} (${validatedPkFieldType})`);
            return {
                field: validatedPkField,
                type: validatedPkFieldType,
            };
        } else {
            console.warn(`⚠️ Could not validate a primary key field using data checks for scope "${foundScope}".`);
            console.log(`ℹ️ Based purely on convention, the primary key *should* be: ${candidateFields[0]?.name ?? 'N/A'}`);
            console.log(`   (This could happen if data changed during validation, or due to a non-standard PK implementation).`);
        }
    } catch (error: any) {
        console.error('❌ An unexpected error occurred during row fetching or validation:', error.message || error);
    }
    return {
        field: null,
        type: null,
    };
}

// (async () => {
//     console.log(`🚀 Starting PK Finder...`);
//     // console.log(await findAndValidatePrimaryKey("eosio.token", "accounts"));
//     // console.log(await findAndValidatePrimaryKey("eosio.msig", "proposal"));
//     console.log(await findAndValidatePrimaryKey("eosio", "producers"));
// })();
