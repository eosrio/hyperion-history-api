// noinspection HttpUrlsUsage

import {Command} from "commander";
import path from "node:path";
import {cp, mkdir, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {JsonRpc} from "enf-eosjs";
import WebSocket from 'ws';
import {Client} from "@elastic/elasticsearch";
import * as readline from "node:readline";
import * as amqp from "amqplib";
import {btoa} from "node:buffer";
import {default as IORedis} from "ioredis";
import {HyperionConnections} from "../interfaces/hyperionConnections.js";
import {HyperionConfig} from "../interfaces/hyperionConfig.js";
import {copyFileSync, rmSync} from "fs";

const program = new Command();
const configDir = path.join(path.resolve(), 'config');
const chainsDir = path.join(configDir, 'chains');

async function getConnections(): Promise<HyperionConnections | null> {
    try {
        const connectionsJsonFile = await readFile(path.join(configDir, 'connections.json'));
        return JSON.parse(connectionsJsonFile.toString());
    } catch (e: any) {
        console.log(e.message)
        return null;
    }
}

async function getExampleConfig(): Promise<HyperionConfig> {
    const exampleChainData = await readFile(path.join(chainsDir, 'example.config.json'));
    return JSON.parse(exampleChainData.toString());
}

async function getExampleConnections(): Promise<HyperionConnections | null> {
    try {
        const connectionsJsonFile = await readFile(path.join(configDir, 'example-connections.json'));
        return JSON.parse(connectionsJsonFile.toString());
    } catch (e: any) {
        return null;
    }
}

async function listChains(flags) {

    const dirData = await readdir(chainsDir);
    const connections = await getConnections();
    if (!connections) return;
    const exampleChain = await getExampleConfig();

    const configuredTable: any[] = [];
    const pendingTable: any[] = [];
    for (const file of dirData.filter(f => f.endsWith('.json'))) {
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
                    chain_id: chainConn?.chain_id.substring(0, 16) + '...'
                });
            } else {
                pendingTable.push(common);
            }
        } catch (e: any) {
            console.log(`Failed to parse ${file} - ${e.message}`);
        }
    }

    console.log(' >>>> Fully Configured Chains');
    console.table(configuredTable);

    if (!flags.valid && pendingTable.length > 0) {
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
    if (!connections) return;

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
        // @ts-ignore
        const jsonRpc = new JsonRpc(options.http, {fetch});
        const info = await jsonRpc.get_info();
        jsonData.api.chain_api = options.http;
        connections.chains[shortName].chain_id = info.chain_id;
        connections.chains[shortName].http = options.http;
        if (info.server_version_string && info.server_version_string.includes('2.1')) {
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
                } catch (e: any) {
                    console.log(e.message);
                    resolve(false);
                }
                ws.close();
            });
            ws.on("error", err => {
                console.log(err.message);
                ws.close();
                resolve(false);
            });
        });
        if (status) {
            connections.chains[shortName].ship = options.ship;
        } else {
            console.log(`Invalid SHIP Endpoint [${options.ship}]`);
            process.exit(0);
        }
    }

    const fullNameArr: string[] = [];
    shortName.split('-').forEach((word: string) => {
        fullNameArr.push(word[0].toUpperCase() + word.slice(1));
    });
    const fullChainName = fullNameArr.join(' ');

    jsonData.api.chain_name = fullChainName;
    connections.chains[shortName].name = fullChainName;

    console.log(connections.chains[shortName]);

    console.log('Saving connections.json...');
    await writeFile(path.join(configDir, 'connections.json'), JSON.stringify(connections, null, 2));
    console.log(`Saving config/chains/${shortName}.config.json...`);
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
    const backupDir = path.join(configDir, 'backups');
    if (!existsSync(backupDir)) {
        await mkdir(backupDir);
    }

    const connections = await getConnections();
    if (!connections) return;

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
    } catch (e: any) {
        console.log(e.message);
        console.log('Failed to create backups! Aborting!');
        process.exit(1);
    }

    console.log(`Deleting ${targetPath}`);
    await rm(targetPath);
    delete connections.chains[shortName];
    console.log('Saving connections.json...');
    await writeFile(path.join(configDir, 'connections.json'), JSON.stringify(connections, null, 2));
    console.log(`✅ ${shortName} removal completed!`);
}

async function checkES(conn: HyperionConnections): Promise<boolean> {
    console.log(`\n[info] [ES] - Testing elasticsearch connection...`);
    let es_url;
    const _es = conn.elasticsearch;
    if (!_es.protocol) {
        _es.protocol = 'http';
    }
    if (_es.user !== '') {
        es_url = `${_es.protocol}://${_es.user}:${_es.pass}@${_es.host}`;
    } else {
        es_url = `${_es.protocol}://${_es.host}`
    }
    const client = new Client({
        node: es_url,
        tls: {rejectUnauthorized: false}
    });
    try {
        const result = await client.cat.health();
        console.log(`[info] [ES] - ${result}`.trim());
        console.log('[info] [ES] - Connection established!');
        return true;
    } catch (reason: any) {
        console.log('[error] [ES] - ' + reason.message);
        return false;
    }
}

async function checkAMQP(conn: HyperionConnections): Promise<boolean> {
    console.log(`\n[info] [RABBIT:AMQP] - Testing rabbitmq amqp connection...`);
    let frameMaxValue = '0x10000';
    if (conn.amqp.frameMax) {
        frameMaxValue = conn.amqp.frameMax;
    }
    const u = encodeURIComponent(conn.amqp.user);
    const p = encodeURIComponent(conn.amqp.pass);
    const v = encodeURIComponent(conn.amqp.vhost)
    const amqp_url = `amqp://${u}:${p}@${conn.amqp.host}/${v}?frameMax=${frameMaxValue}`;
    try {
        const connection = await amqp.connect(amqp_url);
        if (connection) {
            console.log('[info] [RABBIT:AMQP] - Connection established!');
            await connection.close();
            console.log(`\n[info] [RABBIT:HTTP] - Testing rabbitmq http api connection...`);
            const apiUrl = `${conn.amqp.protocol}://${conn.amqp.api}/api/nodes`;

            let headers = new Headers();
            headers.set('Authorization', 'Basic ' + btoa(conn.amqp.user + ":" + conn.amqp.pass));
            const data = await fetch(apiUrl, {
                method: 'GET',
                headers: headers
            });
            const resp = await data.json();
            if (resp.length > 0) {
                for (const node of resp) {
                    console.log(`[info] [RABBIT:HTTP] - Node name: ${node.name} (running: ${node.running})`);
                    if (!node.running) {
                        return false;
                    }
                }
                return true;
            } else {
                return false;
            }
        } else {
            return false;
        }
    } catch (reason: any) {
        console.log('[error] [RABBIT] - ' + reason.message);
        return false;
    }
}

async function checkRedis(conn: HyperionConnections) {
    console.log(`\n[info] [REDIS] - Testing redis connection...`);
    try {
        const ioRedisClient = new IORedis.default(conn.redis);
        const pingResult = await ioRedisClient.ping();
        if (pingResult === 'PONG') {
            console.log('[info] [REDIS] - Connection established!');
            ioRedisClient.disconnect();
            return true;
        } else {
            console.log('[error] [REDIS] - PONG expected, got: ' + pingResult);
            return false;
        }
    } catch (reason: any) {
        console.log('[error] [REDIS] - ' + reason.message);
        return false;
    }
}

async function initConfig() {
    const connections = await getConnections();

    if (connections) {
        console.log('connections.json already created!\n use "./hyp-config connections reset" to revert to default');
        return;
    }

    const exampleConn = await getExampleConnections();

    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));

    const conn = exampleConn;

    if (!conn) return;
    conn.chains = {};

    // check rabbitmq
    let amqp_state = false;
    while (!amqp_state) {
        amqp_state = await checkAMQP(conn);
        if (!amqp_state) {

            const amqp_user = await prompt('\n > Enter the RabbitMQ user (or press ENTER to use "guest"): ');
            if (amqp_user) {
                conn.amqp.user = amqp_user as string;
            } else {
                conn.amqp.user = 'guest'
            }

            const amqp_pass = await prompt(' > Enter the RabbitMQ password (or press ENTER to use "guest"): ');
            if (amqp_pass) {
                conn.amqp.pass = amqp_pass as string;
            } else {
                conn.amqp.pass = 'guest'
            }

            const amqp_vhost = await prompt(' > Enter the RabbitMQ vhost (or press ENTER to use "hyperion"): ');
            if (amqp_vhost) {
                conn.amqp.vhost = amqp_vhost as string;
            } else {
                conn.amqp.vhost = 'hyperion'
            }

            console.log('\n------ current RabbitMQ config -----');
            console.log(conn.amqp);
            console.log('--------------------------------------');
        }
    }

    console.log(`\n RabbitMQ ✅`);

    // check elasticsearch
    let elastic_state = false;
    while (!elastic_state) {
        elastic_state = await checkES(conn);
        if (!elastic_state) {

            const es_user = await prompt('\n > Enter the elasticsearch user (or press ENTER to use "elastic"): ');
            if (es_user) {
                conn.elasticsearch.user = es_user as string;
            } else {
                conn.elasticsearch.user = 'elastic'
            }

            const es_pass = await prompt(' > Enter the elasticsearch password: ');
            if (es_pass) {
                conn.elasticsearch.pass = es_pass as string;
            }

            const es_proto = await prompt(' > Do you want to use http or https?\n1 = http\n2 = https (default)\n');
            if (es_proto === "1") {
                conn.elasticsearch.protocol = 'http';
            } else {
                conn.elasticsearch.protocol = 'https';
            }

            console.log('\n------ current elasticsearch config -----');
            console.log(conn.elasticsearch);
            console.log('-------------------------------------------');
        }
    }

    console.log(`\n Elasticsearch ✅`);

    // check redis connection
    let redis_state = false;
    while (!redis_state) {
        redis_state = await checkRedis(conn);
        if (!redis_state) {
            const redis_host = await prompt('\n > Enter the Redis Server address (or press ENTER to use "127.0.0.1"): ');
            if (redis_host) {
                conn.redis.host = redis_host as string;
            } else {
                conn.redis.host = '127.0.0.1';
            }

            const redis_port = await prompt(' > Enter the Redis Server port (or press ENTER to use "6379"): ');
            if (redis_port) {
                conn.redis.port = parseInt(redis_port as string);
            } else {
                conn.redis.port = 6379;
            }

            console.log('\n------ current redis config -----');
            console.log(conn.redis);
            console.log('-----------------------------------');
        }
    }

    console.log(`\n Redis ✅`);

    console.log('Init completed! Saving configuration...');

    await writeFile(path.join(configDir, 'connections.json'), JSON.stringify(conn, null, 2));

    console.log('✅ ✅');
    rl.close();
}

async function resetConnections() {
    const connPath = path.join(configDir, 'connections.json');
    try {
        if (existsSync(connPath)) {
            const rl = readline.createInterface({input: process.stdin, output: process.stdout});
            const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));
            const confirmation = await prompt('Are you sure you want to reset the connection configuration? Type "YES" to confirm.\n');
            if (confirmation === 'YES') {
                copyFileSync(connPath, path.join(configDir, 'connections.json.bak'));
                rmSync(connPath);
                console.log('connections.json removed, please use "./hyp-config init" to reconfigure');
            } else {
                console.log('Operation canceled. No files were removed.');
            }
            rl.close();
        } else {
            console.log(`The connections.json file is not present, please run "./hyp-config init" to configure it.`);
        }
    } catch (e: any) {
        console.log(e);
    }
}

async function testConnections() {
    const connPath = path.join(configDir, 'connections.json');
    if (existsSync(connPath)) {
        try {
            const conn = await getConnections();
            if (conn) {
                const results = {
                    redis: await checkRedis(conn),
                    elasticsearch: await checkES(conn),
                    rabbitmq: await checkAMQP(conn)
                }
                console.log('\n------ Testing Completed -----');
                console.table(results);
            } else {
                console.log(`The connections.json was not found!.`);
            }
        } catch (e: any) {
            console.log(e.message);
        }
    } else {
        console.log(`The connections.json file is not present, please run "./hyp-config init" to configure it.`);
    }
}

// main program
(() => {

    const connections = program.command('connections');

    // ./hyp-config connections init
    connections
        .command('init')
        .description('create and test the connections.json file')
        .action(initConfig);

    // ./hyp-config connections test
    connections
        .command('test')
        .description('test connections to the hyperion infrastructure')
        .action(testConnections);

    // ./hyp-config connections reset
    connections
        .command('reset')
        .description('remove the connections.json file')
        .action(resetConnections);

    const list = program.command('list').alias('ls');

    // ./hyp-config list chains
    list
        .command('chains')
        .option('--valid', 'only show valid chains')
        .option('--fix-missing-fields', 'set defaults on missing fields')
        .description('list configured chains')
        .action(listChains);

    const newCmd = program.command('new').alias('n');

    // ./hyp-config new chain [shortName]
    newCmd
        .command('chain <shortName>')
        .description('initialize new chain config based on example')
        .option('--http <http_endpoint>', 'define chain api http endpoint')
        .option('--ship <ship_endpoint>', 'define state history ws endpoint')
        .action(newChain);

    const remove = program.command('remove').alias('rm');

    // ./hyp-config remove chain [shortName]
    remove
        .command('chain <shortName>')
        .description('backup and delete chain configuration')
        .action(rmChain);

    // process current command
    program.parse(process.argv);
})();