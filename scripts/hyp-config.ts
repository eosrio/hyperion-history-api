import {Command} from "commander";
import path from "path";
import {cp, mkdir, readdir, readFile, rm, writeFile} from "fs/promises";
import {HyperionConfig} from "../interfaces/hyperionConfig";
import {HyperionConnections} from "../interfaces/hyperionConnections";
import {existsSync} from "fs";
import {JsonRpc} from "eosjs";
import fetch from "cross-fetch";
import WebSocket from 'ws';

const program = new Command();
const chainsDir = path.join(path.resolve(), 'chains');

async function getConnections(): Promise<HyperionConnections> {
    const connectionsJsonFile = await readFile(path.join(path.resolve(), 'connections.json'));
    return JSON.parse(connectionsJsonFile.toString());
}

async function getExampleConfig(): Promise<HyperionConfig> {
    const exampleChainData = await readFile(path.join(chainsDir, 'example.config.json'));
    return JSON.parse(exampleChainData.toString());
}


async function listChains(flags) {

    const dirdata = await readdir(chainsDir);
    const connections = await getConnections();
    const exampleChain = await getExampleConfig();

    const configuredTable = [];
    const pendingTable = [];
    for (const file of dirdata.filter(f => f.endsWith('.json'))) {
        if (file === 'example.config.json') {
            continue;
        }
        try {
            const fileData = await readFile(path.join(chainsDir, file));
            const jsonData: HyperionConfig = JSON.parse(fileData.toString());
            const chainName = jsonData.settings.chain;
            const chainConn = connections.chains[chainName];
            const fullChainName = jsonData.api.chain_name;

            // validate configs with example
            let missingSections = 0;
            let missingFields = 0;
            for (const key in exampleChain) {
                if (!jsonData[key]) {
                    if (flags.fixMissingFields) {
                        jsonData[key] = exampleChain[key];
                    } else {
                        console.log(`⚠ Section ${key} missing on ${file}`);
                        missingSections++;
                    }
                } else {
                    for (const subKey in exampleChain[key]) {
                        if (!jsonData[key].hasOwnProperty(subKey)) {
                            if (flags.fixMissingFields) {
                                jsonData[key][subKey] = exampleChain[key][subKey];
                            } else {
                                console.log(`⚠ Field ${subKey} missing from ${key} on ${file} (default = ${exampleChain[key][subKey]})`);
                                missingFields++;
                            }
                        }
                    }
                }
            }

            if (flags.fixMissingFields) {
                await writeFile(path.join(chainsDir, file), JSON.stringify(jsonData, null, 2));
            }

            const common = {
                full_name: fullChainName,
                name: chainName,
                parser: jsonData.settings.parser,
                abi_scan: jsonData.indexer.abi_scan_mode,
                live_reader: jsonData.indexer.live_reader,
                start_on: jsonData.indexer.start_on,
                stop_on: jsonData.indexer.stop_on
            };

            if (chainConn) {
                configuredTable.push({
                    ...common,
                    nodeos_http: chainConn?.http,
                    nodeos_ship: chainConn?.ship,
                    chain_id: chainConn?.chain_id.substr(0,16) + '...'
                });
            } else {
                pendingTable.push(common);
            }
        } catch (e) {
            console.log(`Failed to parse ${file} - ${e.message}`);
        }
    }

    console.log(' >>>> Fully Configured Chains');
    console.table(configuredTable);

    if (!flags.valid) {
        console.log(' >>>> Pending Configuration Chains');
        console.table(pendingTable);
    }
}

async function newChain(shortName, options) {
    console.log(`Creating new config for ${shortName}...`);
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (existsSync(targetPath)) {
        console.error(`Chain config for ${shortName} already defined!`);
        process.exit(0);
    }

    // read example
    const exampleChain = await getExampleConfig();

    // read connections.json
    const connections = await getConnections();

    if (connections.chains[shortName]) {
        console.log('Connections already defined!');
        console.log(connections.chains[shortName]);
        process.exit(0);
    } else {
        connections.chains[shortName] = {
            name: '',
            ship: '',
            http: '',
            chain_id: '',
            WS_ROUTER_HOST: '127.0.0.1',
            WS_ROUTER_PORT: 7001
        };
    }

    const jsonData = exampleChain;
    jsonData.settings.chain = shortName;

    if (options.http) {

        if (options.http.startsWith('http://') || options.http.startsWith('https://')) {
            console.log(`Testing connection on ${options.http}`);
        } else {
            console.error(`Invalid HTTP Endpoint [${options.http}] - Url must start with either http:// or https://`);
            process.exit(1);
        }

        // test nodeos availability
        const jsonRpc = new JsonRpc(options.http, {fetch});
        const info = await jsonRpc.get_info();
        jsonData.api.chain_api = options.http;
        connections.chains[shortName].chain_id = info.chain_id;
        connections.chains[shortName].http = options.http;
        if (info.server_version_string.includes('2.1')) {
            jsonData.settings.parser = '2.1';
        } else {
            jsonData.settings.parser = '1.8';
        }
        console.log(`Parser version set to ${jsonData.settings.parser}`);
        console.log(`Chain ID: ${info.chain_id}`)
    }

    if (options.ship) {

        if (options.ship.startsWith('ws://') || options.ship.startsWith('wss://')) {
            console.log(`Testing connection on ${options.ship}`);
        } else {
            console.error(`Invalid WS Endpoint [${options.ship}] - Url must start with either ws:// or wss://`);
            process.exit(1);
        }

        // test ship availability
        const status = await new Promise<boolean>(resolve => {
            const ws = new WebSocket(options.ship);
            ws.on("message", (data: Buffer) => {
                try {
                    const abi = JSON.parse(data.toString());
                    if (abi.version) {
                        console.log(`Received SHIP Abi Version: ${abi.version}`);
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                } catch (e) {
                    console.log(e.message);
                    resolve(false);
                }
                ws.close();
            });
            ws.on("error", err => {
                console.log(err);
                ws.close();
                resolve(false);
            });
        });
        if (status) {
            connections.chains[shortName].ship = options.ship;
        } else {
            console.log(`Invalid SHIP Endpoint [${options.ship}]`);
        }
    }

    const fullNameArr = [];
    shortName.split('-').forEach((word: string) => {
        fullNameArr.push(word.at(0).toUpperCase() + word.substr(1));
    });
    const fullChainName = fullNameArr.join(' ');

    jsonData.api.chain_name = fullChainName;
    connections.chains[shortName].name = fullChainName;

    console.log(connections.chains[shortName]);

    console.log('Saving connections.json...');
    await writeFile(path.join(path.resolve(), 'connections.json'), JSON.stringify(connections, null, 2));
    console.log(`Saving chains/${shortName}.config.json...`);
    await writeFile(targetPath, JSON.stringify(jsonData, null, 2));
}

async function rmChain(shortName) {
    console.log(`Removing config for ${shortName}...`);
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`Chain config for ${shortName} not found!`);
        process.exit(0);
    }

    // create backups
    const backupDir = path.join(path.resolve(), 'configuration_backups');
    if (!existsSync(backupDir)) {
        await mkdir(backupDir);
    }

    const connections = await getConnections();
    try {
        const chainConn = connections.chains[shortName];
        const now = Date.now();
        if (chainConn) {
            await writeFile(
                path.join(backupDir, `${shortName}_${now}_connections.json`),
                JSON.stringify(chainConn, null, 2)
            );
        }
        await cp(targetPath, path.join(backupDir, `${shortName}_${now}_config.json`));
    } catch (e) {
        console.log(e.message);
        console.log('Failed to create backups! Aborting!');
        process.exit(1);
    }

    console.log(`Deleting ${targetPath}`);
    await rm(targetPath);
    delete connections.chains[shortName];
    console.log('Saving connections.json...');
    await writeFile(path.join(path.resolve(), 'connections.json'), JSON.stringify(connections, null, 2));
    console.log(`✅ ${shortName} removal completed!`);
}

// main program
(() => {
    const list = program.command('list').alias('ls');
    list.command('chains')
        .option('--valid', 'only show valid chains')
        .option('--fix-missing-fields', 'set defaults on missing fields')
        .description('list configured chains')
        .action(listChains);

    const newCmd = program.command('new').alias('n');
    newCmd.command('chain <shortName>')
        .description('initialize new chain config based on example')
        .option('--http <http_endpoint>', 'define chain api http endpoint')
        .option('--ship <ship_endpoint>', 'define state history ws endpoint')
        .action(newChain)

    const remove = program.command('remove').alias('rm');
    remove.command('chain <shortName>')
        .description('backup and delete chain configuration')
        .action(rmChain);

    program.parse(process.argv);
})();
