import { Command } from "commander";
import path from "path";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { HyperionConfig, ScalingConfigs } from "../interfaces/hyperionConfig.js";
import { HyperionConnections } from "../interfaces/hyperionConnections.js";
import { copyFileSync, existsSync, rmSync } from "fs";
import { JsonRpc } from "eosjs";

import WebSocket from 'ws';
import * as readline from "readline";
import * as amqp from "amqplib";
import { Redis } from "ioredis";
import { Client } from "@elastic/elasticsearch";
import { APIClient } from "@wharfkit/antelope";
import { StateHistorySocket } from "../indexer/connections/state-history.js";
import { mongodb } from "@fastify/mongodb";
import { MongoClient } from "mongodb";

interface IndexConfig {
    [key: string]: number;
}

interface TableConfig {
    auto_index: boolean;
    indices: IndexConfig;
}

interface ContractsState {
    account: string;
    tables: {
        [tableName: string]: TableConfig;
    };
}

interface ChainConfig {
    features: {
        contracts_state: ContractsState[];
    };
}

interface TableInput {
    name: string;
    autoIndex: boolean;
    indices: IndexConfig;
}

const program = new Command();
const rootDir = path.join(import.meta.dirname, '../../');
const referencesDir = path.join(rootDir, 'references');
const configDir = path.join(rootDir, 'config');
const chainsDir = path.join(configDir, 'chains');
const connectionsPath = path.join(configDir, 'connections.json');
const exampleConnectionsPath = path.join(referencesDir, 'connections.ref.json');
const exampleChainDataPath = path.join(referencesDir, 'config.ref.json');
const backupDir = path.join(configDir, 'configuration_backups');

async function getConnections(): Promise<HyperionConnections | null> {
    if (existsSync(connectionsPath)) {
        const connectionsJsonFile = await readFile(connectionsPath);
        return JSON.parse(connectionsJsonFile.toString());
    } else {
        return null;
    }
}

async function getExampleConfig(): Promise<HyperionConfig> {
    const exampleChainData = await readFile(exampleChainDataPath);
    return JSON.parse(exampleChainData.toString());
}

async function listChains(flags) {
    const connections = await getConnections();

    if (!connections) {
        console.log(`The connections.json file is not present, please run "./hyp-config connections init" to configure it.`);
        process.exit(1);
    }

    const exampleChain = await getExampleConfig();

    const configuredTable: any[] = [];
    const pendingTable: any[] = [];
    const files = await readdir(chainsDir);
    for (const file of files.filter(f => f.endsWith('.json'))) {

        // skip example config
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
                stop_on: jsonData.indexer.stop_on,
                purge_queues: jsonData.indexer.purge_queues,
                public_api: jsonData.api.server_name,
                scaling: jsonData.scaling
            };

            if (chainConn) {
                configuredTable.push({
                    ...common,
                    nodeos_http: chainConn?.http,
                    nodeos_ship: chainConn?.ship,
                    chain_id: chainConn?.chain_id
                });
            } else {
                pendingTable.push(common);
            }
        } catch (e: any) {
            console.log(`Failed to parse ${file} - ${e.message}`);
        }
    }

    console.log('\n:::: CONFIGURED CHAINS ::::');
    let idx = 0;
    const tab = `• `;
    for (const chain of configuredTable) {
        idx++;
        // print header with chain name in cyan
        const headerString = `#${idx} - ${chain.full_name} - ${chain.chain_id}`;
        console.log(`\x1b[36m${headerString}\x1b[0m`);

        // Alias
        console.log(tab + `Alias: ${chain.name}`);

        // Indexer Settings
        const props = [
            `Start On: ${chain.start_on}`,
            `Stop On: ${chain.stop_on}`,
            `ABI Scan: ${chain.abi_scan}`,
            `Live Reader: ${chain.live_reader}`,
            `Purge Queues: ${chain.purge_queues}`
        ]
        console.log(`\x1b[33m${tab}${props.join(' | ')}\x1b[0m`);

        // Scaling Settings
        // "readers": 1,
        //     "ds_queues": 1,
        //     "ds_threads": 1,
        //     "ds_pool_size": 1,
        //     "indexing_queues": 1,
        //     "ad_idx_queues": 1,
        //     "dyn_idx_queues": 1,
        const scaling: ScalingConfigs = chain.scaling;
        const scalingProps = [
            `Readers: ${scaling.readers}`,
            `DS Threads: ${scaling.ds_threads}`,
            `DS Pool Size: ${scaling.ds_pool_size}`
        ];
        console.log(`\x1b[33m${tab}Scaling -> [${scalingProps.join(' | ')}]\x1b[0m`);

        const queueProps = [
            `Deserializer: ${scaling.ds_queues}`,
            `Indexing: ${scaling.indexing_queues}`,
            `Actions/Deltas Idx: ${scaling.ad_idx_queues}`,
            `Dynamic Idx: ${scaling.dyn_idx_queues}`
        ];
        console.log(`\x1b[33m${tab}Queues --> [${queueProps.join(' | ')}]\x1b[0m`);

        // Public API
        if (chain.public_api) {
            console.log(tab + `Public API Endpoint: ${chain.public_api}`);
        } else {
            console.log(tab + `Public API Endpoint: \x1b[31mNot Configured\x1b[0m`);
        }

        // Parser Version
        if (chain.parser) {
            console.log(tab + `Parser Version: ${chain.parser}`);
        } else {
            console.log(tab + `Parser Version: \x1b[31mNot Configured\x1b[0m`);
        }

        // HTTP / Chain API Endpoint
        if (chain.nodeos_http) {
            console.log(tab + `HTTP: ${chain.nodeos_http}`);
        } else {
            console.log(tab + `HTTP: \x1b[31mNot Configured\x1b[0m`);
        }

        // SHIP / State History Endpoint
        if (chain.nodeos_ship) {
            if (Array.isArray(chain.nodeos_ship)) {
                let j = 0;
                for (const ship of chain.nodeos_ship) {
                    j++;
                    if (typeof ship === 'object') {
                        console.log(tab.repeat(2) + `SHIP ${j}: ${ship.label} - ${ship.url}`);
                    } else {
                        console.log(tab.repeat(2) + `SHIP ${j}: ${ship}`);
                    }
                }
            } else {
                console.log(tab + `SHIP SERVER: ${chain.nodeos_ship}`);
            }
        } else {
            console.log(tab + `SHIP SERVER: \x1b[31mNot Configured\x1b[0m`);
        }

        // print chain details in table
        // console.table(chain);
        console.log('-'.repeat(headerString.length) + '\n');
    }

    if (!flags.valid) {
        if (pendingTable.length > 0) {
            console.log('\n:::: CHAINS PENDING CONFIGURATION ::::');
            console.table(pendingTable);
        }
    }
}

async function newChain(shortName: string, options) {
    console.log(`Creating new config for ${shortName}...`);
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (existsSync(targetPath)) {
        console.error(`Chain config for ${shortName} already defined! Check config/chains folder`);
        process.exit(0);
    }

    // read example
    const exampleChain = await getExampleConfig();

    // read connections.json
    const connections = await getConnections();

    if (!connections) {
        console.log(`The connections.json file is not present, please run "./hyp-config connections init" to configure it.`);
        process.exit(1);
    }

    if (connections.chains[shortName]) {
        console.error('Connections already defined! Check connections.json file!');
        console.log(connections.chains[shortName]);
        process.exit(0);
    } else {
        // Find the highest WS_ROUTER_PORT and control_port
        let maxWsRouterPort = 7001;
        let maxControlPort = 7002;

        Object.values(connections.chains).forEach(chain => {
            if (chain.WS_ROUTER_PORT > maxWsRouterPort) {
                maxWsRouterPort = chain.WS_ROUTER_PORT;
            }
            if (chain.control_port > maxControlPort) {
                maxControlPort = chain.control_port;
            }
        });

        const isFirstChain = Object.keys(connections.chains).length === 0;
        const newWsRouterPort = isFirstChain ? maxWsRouterPort : maxWsRouterPort + 10;
        const newControlPort = isFirstChain ? maxControlPort : maxControlPort + 10;

        connections.chains[shortName] = {
            name: '',
            ship: '',
            http: '',
            chain_id: '',
            WS_ROUTER_HOST: '127.0.0.1',
            WS_ROUTER_PORT: newWsRouterPort,
            control_port: newControlPort
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
        try {
            const jsonRpc = new JsonRpc(options.http, { fetch });
            const info = await jsonRpc.get_info();
            jsonData.api.chain_api = options.http;
            connections.chains[shortName].chain_id = info.chain_id;
            connections.chains[shortName].http = options.http;
            if (info.server_version_string) {
                if (info.server_version_string.includes('v3')) {
                    jsonData.settings.parser = '3.2';
                } else if (info.server_version_string.includes('v2.1')) {
                    jsonData.settings.parser = '2.1';
                } else {
                    jsonData.settings.parser = '3.2';
                }
            } else {
                jsonData.settings.parser = '3.2';
            }
            console.log(`Parser version set to ${jsonData.settings.parser}`);
            console.log(`Chain ID: ${info.chain_id}`);
        } catch (e: any) {
            console.error(`Invalid HTTP Endpoint [${options.http}] - ${e.message}`);
            process.exit(1);
        }
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

    const fullNameArr: any[] = [];
    shortName.split('-').forEach((word: string) => {
        fullNameArr.push(word[0].toUpperCase() + word.substring(1));
    });

    const fullChainName = fullNameArr.join(' ');

    jsonData.api.chain_name = fullChainName;
    connections.chains[shortName].name = fullChainName;

    console.log(connections.chains[shortName]);

    console.log('Saving connections.json...');
    await writeFile(connectionsPath, JSON.stringify(connections, null, 2));
    console.log(`Saving chains/${shortName}.config.json...`);
    await writeFile(targetPath, JSON.stringify(jsonData, null, 2));
}

async function testChain(shortName: string) {
    console.log(`Testing chain ${shortName}`);

    // read connections.json
    const connections = await getConnections();

    if (!connections) {
        console.log(`The connections.json file is not present, please run "./hyp-config connections init" to configure it.`);
        process.exit(1);
    }

    const configuredChainID = connections.chains[shortName].chain_id;

    // HTTP TEST
    const httpEndpoint = connections.chains[shortName].http;
    console.log(`Checking HTTP endpoint: ${httpEndpoint}`);
    let httpChainId = '';
    try {
        const apiClient = new APIClient({ url: httpEndpoint });
        const info = await apiClient.v1.chain.get_info();
        httpChainId = info.chain_id.toString();
    } catch (e: any) {
        console.log(`Failed to connect to ${httpEndpoint} - ${e.message}`);
        process.exit();
    }


    // SHIP WS TEST
    console.log(`Checking SHIP endpoints...`);
    const shipEndpoints = connections.chains[shortName].ship;
    const shs = new StateHistorySocket(shipEndpoints);
    const servers = await shs.validateShipServers(httpChainId);

    if (!servers || servers.length === 0) {
        console.log(`Failed to connect to SHIP endpoints!`);
        process.exit();
    }

    for (const server of servers) {
        console.log(server.node.label, server.node.url, server.traceBeginBlock, server.traceEndBlock);
    }

    const shipChainId = servers[0].chainId;

    // CHAIN ID MATCH
    console.log(`Checking chain ID match...`);

    if (configuredChainID.toLowerCase() === shipChainId.toLowerCase()
        && configuredChainID.toLowerCase() === httpChainId.toLowerCase()) {
        console.log(`Chain ID Verification: PASS - ${configuredChainID}`);
    } else {
        if (httpChainId !== shipChainId) {
            console.error('[Critical Error] Chain ID mismatch between HTTP and SHIP servers');
        } else {
            console.error('[Critical Error] Configuration Chain ID is not the same as both servers');
        }
        console.error(`Configured ID: ${configuredChainID.toLowerCase()}`);
        console.error(`HTTP Endpoint: ${httpChainId.toLowerCase()}`);
        console.error(`SHIP Endpoint: ${shipChainId.toLowerCase()}`);
        process.exit(1);
    }
}

async function rmChain(shortName: string) {
    console.log(`Removing config for ${shortName}...`);
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`Chain config for ${shortName} not found!`);
        process.exit(0);
    }

    // create backups
    if (!existsSync(backupDir)) {
        await mkdir(backupDir);
    }

    const connections = await getConnections();

    if (!connections) {
        console.log(`The connections.json file is not present, please run "./hyp-config connections init" to configure it.`);
        process.exit(1);
    }

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
    await writeFile(connectionsPath, JSON.stringify(connections, null, 2));
    console.log(`✅ ${shortName} removal completed!`);
}

async function getExampleConnections(): Promise<HyperionConnections | null> {
    try {
        const connectionsJsonFile = await readFile(exampleConnectionsPath);
        return JSON.parse(connectionsJsonFile.toString());
    } catch (e: any) {
        return null;
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
    // console.log(`Prepared client: ${es_url}`);
    const client = new Client({
        node: es_url,
        tls: {
            rejectUnauthorized: false
        }
    });
    try {
        const result = await client.cat.health();
        console.log(`[info] [ES] - ${result}`);
        console.log('[info] [ES] - Connection established!');
        return true;
    } catch (reason: any) {
        console.log('[error] [ES] - ' + reason.message);
        return false;
    }
}

async function checkRedis(conn: HyperionConnections) {
    console.log(`\n[info] [REDIS] - Testing redis connection...`);
    try {
        const ioRedisClient = new Redis(conn.redis);
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

async function checkMongoDB(conn: HyperionConnections): Promise<boolean> {
    console.log(`\n[info] [MONGODB] - Testing MongoDB connection...`);
    const _mongo = conn.mongodb;
    if (!_mongo || !_mongo.enabled) {
        console.log('[info] [MONGODB] - MongoDB is not enabled in the configuration.');
        return false;
    }

    let uri = "mongodb://";
    if (_mongo.user && _mongo.pass) {
        uri += `${_mongo.user}:${_mongo.pass}@`;
    }
    uri += `${_mongo.host}:${_mongo.port}`;

    const client = new MongoClient(uri);

    try {
        await client.connect();
        const adminDb = client.db('admin');
        const result = await adminDb.command({ ping: 1 });
        if (result && result.ok === 1) {
            console.log('[info] [MONGODB] - Connection established!');
            return true;
        } else {
            console.log('[error] [MONGODB] - Failed to ping the database.');
            return false;
        }
    } catch (error: any) {
        console.log('[error] [MONGODB] - ' + error.message);
        return false;
    } finally {
        await client.close();
    }
}

async function initConfig() {
    const connections = await getConnections();

    if (connections) {
        console.log('connections.json already created!\n use "./hyp-config connections reset" to revert to default');
        return;
    }

    const exampleConn = await getExampleConnections();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = (query: string) => new Promise((resolve) => rl.question(query, resolve));

    const conn = exampleConn;

    if (!conn) {
        console.log('No example-connections.json to use as reference!');
        process.exit(1);
    }
    conn.chains = {};

    // check rabbitmq
    let amqp_state = false;
    while (!amqp_state) {
        amqp_state = await checkAMQP(conn);
        if (!amqp_state) {

            const amqp_user = await prompt('\n > Enter the RabbitMQ user (or press ENTER to use "hyperion_user"): ');
            if (amqp_user) {
                conn.amqp.user = amqp_user as string;
            } else {
                conn.amqp.user = 'hyperion_user'
            }

            const amqp_pass = await prompt(' > Enter the RabbitMQ password (or press ENTER to use "hyperion_password"): ');
            if (amqp_pass) {
                conn.amqp.pass = amqp_pass as string;
            } else {
                conn.amqp.pass = 'hyperion_password'
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

    await writeFile(connectionsPath, JSON.stringify(conn, null, 2));

    console.log('✅ ✅');
    rl.close();
}

async function testConnections() {
    if (existsSync(connectionsPath)) {
        try {
            const conn = await getConnections();
            if (conn) {
                const results = {
                    redis: await checkRedis(conn),
                    elasticsearch: await checkES(conn),
                    rabbitmq: await checkAMQP(conn),
                    mongodb: await checkMongoDB(conn)
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
        console.log(`The connections.json file is not present, please run "./hyp-config connections init" to configure it.`);
    }
}

async function resetConnections() {
    try {

        // create backups
        if (!existsSync(backupDir)) {
            await mkdir(backupDir);
        }

        if (existsSync(connectionsPath)) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const prompt = (query: string) => new Promise((resolve) => rl.question(query, resolve));
            const confirmation = await prompt('Are you sure you want to reset the connection configuration? Type "YES" to confirm.\n') as string;
            if (confirmation.toUpperCase() === 'YES') {
                copyFileSync(connectionsPath, path.join(backupDir, 'connections.json.bak'));
                rmSync(connectionsPath);
                console.log('connections.json removed, please use "./hyp-config connections init" to reconfigure');
            } else {
                console.log('Operation canceled. No files were removed.');
            }
            rl.close();
        } else {
            console.log(`The connections.json file is not present, please run "./hyp-config connections init" to configure it.`);
        }
    } catch (e: any) {
        console.log(e);
    }
}

function customStringify(obj: any, indent = 0): string {
    const indentStr = ' '.repeat(indent);
    let result = '';

    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
            result += `${indentStr}${key}:\n${customStringify(value, indent + 2)}`;
        } else {
            result += `${indentStr}${key}: ${value}\n`;
        }
    }

    return result;
}

async function listConfigContract(shortName: string) {
    console.log(`Listing Contracts config for ${shortName}...`);
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`Chain config for ${shortName} not found!`);
        process.exit(0);
    }

    const chainJsonFile = await readFile(targetPath);
    const chainConfig: ChainConfig = JSON.parse(chainJsonFile.toString());
    const contracts_state = chainConfig.features.contracts_state;

    if (!contracts_state || contracts_state.length === 0) {
        console.log('No contracts state configuration found.');
        return;
    }

    console.log('Contracts State Configuration:');
    console.log('------------------------------');

    contracts_state.forEach((contractState, index) => {
        console.log(`Contract State ${index + 1}:`);
        console.log(`Account: ${contractState.account}`);
        console.log('Tables:');

        for (const [tableName, tableConfig] of Object.entries(contractState.tables)) {
            console.log(`  ${tableName}:`);
            console.log(`    auto_index: ${tableConfig.auto_index}`);
            console.log('    indices:');
            console.log(customStringify(tableConfig.indices, 6));
        }

        if (index < contracts_state.length - 1) {
            console.log('------------------------------');
        }
    });
}

async function addOrUpdateContractConfig(shortName: string, account: string, tables: TableInput[]) {
    console.log(`Adding/updating contract config for ${shortName}...`);
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`Chain config for ${shortName} not found!`);
        process.exit(0);
    }

    const chainJsonFile = await readFile(targetPath);
    const chainConfig: ChainConfig = JSON.parse(chainJsonFile.toString());

    if (!chainConfig.features.contracts_state) {
        chainConfig.features.contracts_state = [];
    }

    let accountConfig = chainConfig.features.contracts_state.find(cs => cs.account === account);

    if (!accountConfig) {
        accountConfig = {
            account: account,
            tables: {}
        };
        chainConfig.features.contracts_state.push(accountConfig);
    }

    tables.forEach(table => {
        accountConfig.tables[table.name] = {
            auto_index: table.autoIndex,
            indices: table.indices
        };
    });

    await writeFile(targetPath, JSON.stringify(chainConfig, null, 2));
    console.log(`Contract config added/updated successfully for account ${account}`);
}


// main program
(() => {

    const connections = program.command('connections');

    // ./hyp-config connections init
    connections.command('init')
        .description('create and test the connections.json file')
        .action(initConfig);

    // ./hyp-config connections test
    connections.command('test')
        .description('test connections to the hyperion infrastructure')
        .action(testConnections);

    // ./hyp-config connections reset
    connections.command('reset')
        .description('remove the connections.json file')
        .action(resetConnections);

    // ./hyp-config chains
    const chains = program.command('chains');

    // ./hyp-config chains list
    chains.command('list')
        .alias('ls')
        .option('--valid', 'only show valid chains')
        .option('--fix-missing-fields', 'set defaults on missing fields')
        .description('list configured chains')
        .action(listChains);

    // ./hyp-config chains new <shortName>
    chains.command('new <shortName>')
        .description('initialize new chain config based on example')
        .requiredOption('--http <http_endpoint>', 'define chain api http endpoint')
        .requiredOption('--ship <ship_endpoint>', 'define state history ws endpoint')
        .action(newChain)

    // ./hyp-config chains remove <shortName>
    chains.command('remove <shortName>')
        .description('backup and delete chain configuration')
        .action(rmChain);


    // ./hyp-config chains test <shortName>
    chains.command('test <shortName>')
        .description('test a chain configuration')
        .action(testChain);


    // DEPRECATED ./hyp-config list chains
    const list = program.command('list', {
        hidden: true
    }).alias('ls');
    list.command('chains')
        .option('--valid', 'only show valid chains')
        .option('--fix-missing-fields', 'set defaults on missing fields')
        .description('list configured chains')
        .action(listChains);

    // DEPRECATED ./hyp-config new chain <shortName>
    const newCmd = program.command('new', {
        hidden: true
    }).alias('n');
    newCmd.command('chain <shortName>')
        .description('initialize new chain config based on example')
        .requiredOption('--http <http_endpoint>', 'define chain api http endpoint')
        .requiredOption('--ship <ship_endpoint>', 'define state history ws endpoint')
        .action(newChain)

    // DEPRECATED ./hyp-config remove chain <shortName>
    const remove = program.command('remove', {
        hidden: true
    }).alias('rm');
    remove.command('chain <shortName>')
        .description('backup and delete chain configuration')
        .action(rmChain);

    
    const contracts = program.command('contracts');

    //List Config
    contracts.command('list <chainName>')
        .description('list contracts config')
        .action(listConfigContract)

    // Add to config
    contracts.command('add-single <chainName> <account> <table> <autoIndex> <indices>')
    .description('add or update a single table in contract config')
    .action(async (chainName, account, table, autoIndex, indices) => {
        const tableInput: TableInput = {
            name: table,
            autoIndex: autoIndex === 'true',
            indices: JSON.parse(indices)
        };
        await addOrUpdateContractConfig(chainName, account, [tableInput]);
    });

contracts.command('add-multiple <chainName> <account> <tablesJson>')
    .description('add or update multiple tables in contract config')
    .action(async (chainName, account, tablesJson) => {
        try {
            const tables: TableInput[] = JSON.parse(tablesJson);
            await addOrUpdateContractConfig(chainName, account, tables);
        } catch (error) {
            console.error('Error parsing tables JSON:', error);
        }
    });


    program.parse(process.argv);

})();
