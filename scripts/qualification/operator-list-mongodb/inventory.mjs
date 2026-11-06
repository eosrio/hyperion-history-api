// Source/artifact bytes only; no network, database, process or service operations.
import assert from 'node:assert/strict';
import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {sha} from './contract.mjs';
export function inventory(directory, {textLF = false, maximumFiles = 1024, maximumBytes = 64 * 1024 * 1024} = {}) {
    const rows = []; let total = 0;
    const visit = path => {
        const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false, 'Qualification inventory refuses symlinks');
        if (stat.isDirectory()) {for (const name of readdirSync(path).sort()) visit(join(path, name));}
        else {assert.equal(stat.isFile(), true);
            total += stat.size; assert.ok(rows.length < maximumFiles && total <= maximumBytes, 'Qualification inventory bound exceeded');
            let bytes = readFileSync(path); assert.equal(bytes.length, stat.size, 'Qualification file changed during inventory');
            // Only tracked text inputs use Git-LF canonicalization. Emissions/dependencies remain byte-exact.
            if (textLF) bytes = Buffer.from(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes).replaceAll('\r\n', '\n'));
            rows.push({path: relative(directory, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes)});}
    };
    visit(directory); return rows;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    assert.equal(process.argv.length, 2, 'Inventory uses only this checkout\'s native adapter dist');
    const files = inventory(resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/backend-mongodb/dist'));
    console.log(JSON.stringify({schemaVersion: 1, scope: 'native-operator-list-compiled-inventory', sha256: sha(JSON.stringify(files)), files}, null, 2));
}
