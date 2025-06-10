import { Command } from 'commander';
import path from 'path';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { HyperionConfig, ScalingConfigs, HyperionConfigSchema } from '../interfaces/hyperionConfig.js';
import { HyperionConnections } from '../interfaces/hyperionConnections.js';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'fs';

import WebSocket from 'ws';
import * as readline from 'readline';
import * as amqp from 'amqplib';
import { Redis } from 'ioredis';
import { Client } from '@elastic/elasticsearch';
import { APIClient } from '@wharfkit/antelope';
import { StateHistorySocket } from '../indexer/connections/state-history.js';
import { MongoClient } from 'mongodb';
import { IndexerController } from './controller-client/controller.client.js';

interface ConnectionsInitOptions {
    amqpUser?: string;
    amqpPass?: string;
    amqpVhost?: string;
    esUser?: string;
    esPass?: string;
    esProtocol?: string;
    redisHost?: string;
    redisPort?: string;
    mongoEnabled?: string;
    mongoHost?: string;
    mongoPort?: string;
    mongoUser?: string;
    mongoPass?: string;
    mongoPrefix?: string;
    [key: string]: any;
}

type AllowedIndexValue = 1 | -1 | 'text' | 'date' | '2dsphere';

interface IndexConfig {
    [key: string]: AllowedIndexValue;
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

if (!existsSync(configDir)) {
    mkdirSync(configDir);
}
const chainsDir = path.join(configDir, 'chains');

if (!existsSync(chainsDir)) {
    mkdirSync(chainsDir);
}

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
    for (const file of files.filter((f) => f.endsWith('.json'))) {
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
        ];
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
        const scalingProps = [`Readers: ${scaling.readers}`, `DS Threads: ${scaling.ds_threads}`, `DS Pool Size: ${scaling.ds_pool_size}`];
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
    if (options.usePending) {
        console.log(`Updating pending chain config for ${shortName}...`);
    } else {
        console.log(`Creating new config for ${shortName}...`);
    }
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (existsSync(targetPath) && !options.usePending) {
        console.error(`Chain config for ${shortName} already defined! Check config/chains folder`);
        console.error(`Use --use-pending to update a pending chain configuration`);
        process.exit(0);
    }

    // When using --use-pending, we should load the existing config
    let jsonData;
    if (options.usePending && existsSync(targetPath)) {
        console.log(`Using existing pending configuration for ${shortName}...`);
        const existingConfig = await readFile(targetPath);
        jsonData = JSON.parse(existingConfig.toString());
    } else {
        // read example for a new chain
        jsonData = await getExampleConfig();
    }

    // read connections.json
    const connections = await getConnections();

    if (!connections) {
        console.log(`The connections.json file is not present, please run "./hyp-config connections init" to configure it.`);
        process.exit(1);
    }

    if (connections.chains[shortName] && !options.usePending) {
        console.error('Connections already defined! Check connections.json file!');
        console.log(connections.chains[shortName]);
        process.exit(0);
    } else if (!connections.chains[shortName]) {
        // Find the highest WS_ROUTER_PORT and control_port
        let maxWsRouterPort = 7001;
        let maxControlPort = 7002;

        Object.values(connections.chains).forEach((chain) => {
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

    // Set the chain in settings
    jsonData.settings.chain = shortName;

    // Always update the HTTP endpoint when provided
    if (options.http) {
        if (options.http.startsWith('http://') || options.http.startsWith('https://')) {
            console.log(`Testing connection on ${options.http}`);
        } else {
            console.error(`Invalid HTTP Endpoint [${options.http}] - Url must start with either http:// or https://`);
            process.exit(1);
        }

        // test nodeos availability
        try {
            const apiClient = new APIClient({ url: options.http, fetch });
            const info = await apiClient.v1.chain.get_info();
            jsonData.api.chain_api = options.http;
            connections.chains[shortName].chain_id = info.chain_id.toString();
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

    // Always update the SHIP endpoint when provided
    if (options.ship) {
        if (options.ship.startsWith('ws://') || options.ship.startsWith('wss://')) {
            console.log(`Testing connection on ${options.ship}`);
        } else {
            console.error(`Invalid WS Endpoint [${options.ship}] - Url must start with either ws:// or wss://`);
            process.exit(1);
        }

        // test ship availability
        const status = await new Promise<boolean>((resolve) => {
            const ws = new WebSocket(options.ship);
            ws.on('message', (data: Buffer) => {
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
            ws.on('error', (err) => {
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

    // When working with a pending chain, we might already have a chain name in the config
    // but we should still ensure the connections.chains entry has the name set
    if (!options.usePending || !connections.chains[shortName]?.name) {
        const fullNameArr: any[] = [];
        shortName.split('-').forEach((word: string) => {
            fullNameArr.push(word[0].toUpperCase() + word.substring(1));
        });

        const fullChainName = fullNameArr.join(' ');

        jsonData.api.chain_name = fullChainName;

        if (!connections.chains[shortName]) {
            // Create the chain entry if it doesn't exist yet
            connections.chains[shortName] = {
                name: fullChainName,
                ship: '',
                http: '',
                chain_id: '',
                WS_ROUTER_HOST: '127.0.0.1',
                WS_ROUTER_PORT: 7001,
                control_port: 7002
            };
        }

        connections.chains[shortName].name = fullChainName;
    }

    console.log(connections.chains[shortName]);

    console.log('Saving connections.json...');
    await writeFile(connectionsPath, JSON.stringify(connections, null, 2));

    if (options.usePending) {
        console.log(`Updating existing chains/${shortName}.config.json...`);
    } else {
        console.log(`Creating new chains/${shortName}.config.json...`);
    }
    await writeFile(targetPath, JSON.stringify(jsonData, null, 2));

    if (options.usePending) {
        console.log(`✅ Successfully updated pending chain ${shortName} configuration`);
    } else {
        console.log(`✅ Successfully created new chain ${shortName} configuration`);
    }
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

    if (configuredChainID.toLowerCase() === shipChainId.toLowerCase() && configuredChainID.toLowerCase() === httpChainId.toLowerCase()) {
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
            await writeFile(path.join(backupDir, `${shortName}_${now}_connections.json`), JSON.stringify(chainConn, null, 2));
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
    const v = encodeURIComponent(conn.amqp.vhost);
    const amqp_url = `amqp://${u}:${p}@${conn.amqp.host}/${v}?frameMax=${frameMaxValue}`;
    try {
        const connection = await amqp.connect(amqp_url);
        if (connection) {
            console.log('[info] [RABBIT:AMQP] - Connection established!');
            await connection.close();
            console.log(`\n[info] [RABBIT:HTTP] - Testing rabbitmq http api connection...`);
            const apiUrl = `${conn.amqp.protocol}://${conn.amqp.api}/api/nodes`;

            let headers = new Headers();
            headers.set('Authorization', 'Basic ' + btoa(conn.amqp.user + ':' + conn.amqp.pass));
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
        es_url = `${_es.protocol}://${_es.host}`;
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

// Define possible MongoDB error types
type MongoErrorType = 'AUTH' | 'CONNECTION' | 'OTHER' | 'NONE';

interface CheckMongoResult {
    success: boolean;
    errorType: MongoErrorType;
    message?: string;
}

async function checkMongoDB(conn: HyperionConnections): Promise<CheckMongoResult> {
    console.log(`\n[info] [MONGODB] - Testing MongoDB connection...`);
    const _mongo = conn.mongodb;
    if (!_mongo || !_mongo.enabled) {
        console.log('[info] [MONGODB] - MongoDB is not configured or not enabled.');
        return { success: true, errorType: 'NONE' }; // Treat as success if not enabled/configured
    }

    let uri = 'mongodb://';
    if (_mongo.user && _mongo.pass) {
        uri += `${_mongo.user}:${_mongo.pass}@`;
    }
    uri += `${_mongo.host}:${_mongo.port}`;

    const client = new MongoClient(uri);

    try {
        await client.connect();
        const adminDb = client.db('admin');

        try {
            const hostInfoResult = await adminDb.command({ hostInfo: 1 });
            if (hostInfoResult && hostInfoResult.ok === 1) {
                console.log('[info] [MONGODB] - Connection established with full authentication!');
                return { success: true, errorType: 'NONE' };
            } else {
                const errMsg = 'Failed to get hostInfo from database.';
                console.log('[error] [MONGODB] - ' + errMsg);
                return { success: false, errorType: 'OTHER', message: errMsg };
            }
        } catch (authError: any) {
            // Verifica se é um problema de autenticação
            if (authError.message?.includes('requires authentication')) {
                console.log('[error] [MONGODB] - Authentication required but not provided or invalid.');
                return { success: false, errorType: 'AUTH', message: authError.message };
            }

            // Outros erros
            console.log('[error] [MONGODB] - ' + authError.message);
            return { success: false, errorType: 'OTHER', message: authError.message };
        }
    } catch (error: any) {
        const errMsg = error.message || 'Unknown MongoDB error';
        console.log('[error] [MONGODB] - ' + errMsg);
        let errorType: MongoErrorType = 'OTHER';
        if (errMsg.includes('Authentication failed')) {
            errorType = 'AUTH';
        } else if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND') || errMsg.includes('connect timed out')) {
            errorType = 'CONNECTION';
        }
        return { success: false, errorType: errorType, message: errMsg };
    } finally {
        // Ensure client.close() is called even if connect() fails
        // Use optional chaining in case client wasn't initialized properly
        await client?.close().catch((closeErr) => {
            console.error('[error] [MONGODB] - Error closing connection:', closeErr.message);
        });
    }
}

async function initConfig(options: ConnectionsInitOptions = {}) {
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

    // Apply command line options to the configuration if provided
    if (options.amqpUser) conn.amqp.user = options.amqpUser;
    if (options.amqpPass) conn.amqp.pass = options.amqpPass;
    if (options.amqpVhost) conn.amqp.vhost = options.amqpVhost;
    if (options.esUser) conn.elasticsearch.user = options.esUser;
    if (options.esPass) conn.elasticsearch.pass = options.esPass;
    if (options.esProtocol) conn.elasticsearch.protocol = options.esProtocol;
    if (options.redisHost) conn.redis.host = options.redisHost;
    if (options.redisPort) conn.redis.port = parseInt(options.redisPort);

    // MongoDB settings are now mandatory, like Redis/ES/AMQP
    // Ensure mongodb section exists in template
    if (!conn.mongodb) {
        conn.mongodb = {
            enabled: true,
            host: '127.0.0.1',
            port: 27017,
            database_prefix: 'hyperion',
            user: '',
            pass: ''
        };
    } else {
        if (!conn.mongodb.hasOwnProperty('database_prefix')) {
            conn.mongodb.database_prefix = 'hyperion';
        }
        conn.mongodb.enabled = true;
    }

    // check rabbitmq
    let amqp_state = false;
    while (!amqp_state) {
        amqp_state = await checkAMQP(conn);
        if (!amqp_state) {
            const amqp_user = await prompt('\n > Enter the RabbitMQ user (or press ENTER to use "hyperion_user"): ');
            conn.amqp.user = amqp_user ? (amqp_user as string) : 'hyperion_user';

            const amqp_pass = await prompt(' > Enter the RabbitMQ password (or press ENTER to use "hyperion_password"): ');
            conn.amqp.pass = amqp_pass ? (amqp_pass as string) : 'hyperion_password';

            const amqp_vhost = await prompt(' > Enter the RabbitMQ vhost (or press ENTER to use "hyperion"): ');
            conn.amqp.vhost = amqp_vhost ? (amqp_vhost as string) : 'hyperion';

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
            conn.elasticsearch.user = es_user ? (es_user as string) : 'elastic';

            const es_pass = await prompt(' > Enter the elasticsearch password: ');
            if (es_pass) {
                conn.elasticsearch.pass = es_pass as string;
            }

            const es_proto = await prompt(' > Do you want to use http or https?\n1 = http(default)\n2 = https\n');
            conn.elasticsearch.protocol = es_proto === '1' ? 'http' : 'https';

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
            conn.redis.host = redis_host ? (redis_host as string) : '127.0.0.1';

            const redis_port = await prompt(' > Enter the Redis Server port (or press ENTER to use "6379"): ');
            conn.redis.port = redis_port ? parseInt(redis_port as string) : 6379;

            console.log('\n------ current redis config -----');
            console.log(conn.redis);
            console.log('-----------------------------------');
        }
    }

    console.log(`\n Redis ✅`);

    // MongoDB config (mandatory)
    let mongo_state = false;
    let mongoCheckResult: CheckMongoResult | null = null;
    while (!mongo_state) {
        console.log('\n[info] [MONGODB] - Please enter MongoDB connection details:');

        const mongo_host = await prompt(' > Enter the MongoDB Server address (or press ENTER to use "127.0.0.1"): ');
        conn.mongodb.host = mongo_host ? (mongo_host as string) : '127.0.0.1';

        const mongo_port = await prompt(' > Enter the MongoDB Server port (or press ENTER to use "27017"): ');
        conn.mongodb.port = mongo_port ? parseInt(mongo_port as string) : 27017;

        const mongo_user = await prompt(' > Enter the MongoDB user (or press ENTER for none): ');
        conn.mongodb.user = mongo_user ? (mongo_user as string) : '';

        const mongo_pass = await prompt(' > Enter the MongoDB password (or press ENTER for none): ');
        conn.mongodb.pass = mongo_pass ? (mongo_pass as string) : '';

        const mongo_prefix = await prompt(' > Enter the MongoDB database prefix (or press ENTER to use "hyperion"): ');
        conn.mongodb.database_prefix = mongo_prefix ? (mongo_prefix as string) : 'hyperion';

        // Now test the connection with the updated details
        mongoCheckResult = await checkMongoDB(conn);
        mongo_state = mongoCheckResult.success;

        if (!mongo_state) {
            // Use the specific error message from checkMongoDB if available
            const errMsg = mongoCheckResult.message || 'Connection test failed. Please check your input and ensure the server is accessible.';
            console.log(`[error] [MONGODB] - ${errMsg}`);
        }
    }
    console.log(`\n MongoDB ✅`);

    console.log('\nInit completed! Saving configuration...');

    await writeFile(connectionsPath, JSON.stringify(conn, null, 2));

    console.log('✅ ✅');
    rl.close();
}

async function testConnections() {
    if (existsSync(connectionsPath)) {
        try {
            const conn = await getConnections();
            if (conn) {
                let mongoStatus: boolean | string;
                if (!conn.mongodb || !conn.mongodb.enabled) {
                    mongoStatus = 'disabled'; // Indicate disabled status
                    // Optionally run checkMongoDB just to print the info message, but ignore its return value for the table
                    await checkMongoDB(conn);
                } else {
                    const mongoResult = await checkMongoDB(conn); // Run the check only if enabled
                    mongoStatus = mongoResult.success; // Use the actual success status
                }

                const results = {
                    redis: await checkRedis(conn),
                    elasticsearch: await checkES(conn),
                    rabbitmq: await checkAMQP(conn),
                    mongodb: mongoStatus // Assign the determined status
                };
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
            const confirmation = (await prompt('Are you sure you want to reset the connection configuration? Type "YES" to confirm.\n')) as string;
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
    const chainConfig: HyperionConfig = JSON.parse(chainJsonFile.toString());

    const contractsConfig = chainConfig.features?.contract_state?.contracts;
    const contractStateEnabled = chainConfig.features?.contract_state?.enabled ?? false;

    if (!contractStateEnabled || !contractsConfig || Object.keys(contractsConfig).length === 0) {
        console.log(`No contracts state configuration found or feature is disabled for ${shortName}.`);
        console.log(`(Contract State Enabled: ${contractStateEnabled})`);
        return;
    }

    console.log('Contracts State Configuration:');
    console.log(`(Enabled: ${contractStateEnabled})`);
    console.log('------------------------------');

    let firstAccount = true;
    for (const accountName in contractsConfig) {
        if (contractsConfig.hasOwnProperty(accountName)) {
            if (!firstAccount) {
                console.log('------------------------------');
            }
            const accountTables = contractsConfig[accountName];

            console.log(`Account: ${accountName}`);
            console.log('Tables:');

            if (Object.keys(accountTables).length === 0) {
                console.log('  (No tables configured for this account)');
            } else {
                for (const [tableName, tableConfig] of Object.entries(accountTables)) {
                    console.log(`  ${tableName}:`);
                    console.log(`    auto_index: ${tableConfig.auto_index}`);
                    console.log('    indices:');
                    console.log(customStringify(tableConfig.indices, 6));
                }
            }
            firstAccount = false;
        }
    }
}

async function addOrUpdateContractConfig(shortName: string, account: string, tables: TableInput[]) {
    console.log(`Adding/updating contract config for account '${account}' in ${shortName}...`);
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`Chain config for ${shortName} not found!`);
        process.exit(0);
    }

    const chainJsonFile = await readFile(targetPath);
    const chainConfig: HyperionConfig = JSON.parse(chainJsonFile.toString());

    if (!chainConfig.features) {
        console.warn("WARN: 'features' section missing, creating default structure.");

        chainConfig.features = {
            streaming: { enable: false, traces: false, deltas: false },
            tables: {
                proposals: true,
                accounts: true,
                voters: true,
                permissions: true,
                user_resources: true
            },
            contract_state: { enabled: false, contracts: {} },
            index_deltas: true,
            index_transfer_memo: true,
            index_all_deltas: true,
            deferred_trx: false,
            failed_trx: false,
            resource_limits: false,
            resource_usage: false,
            contract_console: false
        };
    } else if (!chainConfig.features.contract_state) {
        console.warn("WARN: 'features.contract_state' section missing, creating default.");
        chainConfig.features.contract_state = {
            enabled: false,
            contracts: {}
        };
    } else if (Object.keys(chainConfig.features.contract_state).length === 0 || !chainConfig.features.contract_state.hasOwnProperty('enabled')) {
        // When contract_state is an empty object or missing the enabled property
        console.warn("WARN: 'features.contract_state.enabled' property missing, setting to true.");
        chainConfig.features.contract_state.enabled = true;

        // Ensure contracts object exists
        if (!chainConfig.features.contract_state.contracts) {
            chainConfig.features.contract_state.contracts = {};
        }
    } else if (!chainConfig.features.contract_state.contracts) {
        console.warn("WARN: 'features.contract_state.contracts' object missing, creating.");
        chainConfig.features.contract_state.contracts = {};
    }

    let accountTables = chainConfig.features.contract_state.contracts[account];
    if (!accountTables) {
        console.log(`Account '${account}' not found in config, creating new entry.`);
        chainConfig.features.contract_state.contracts[account] = {};
        accountTables = chainConfig.features.contract_state.contracts[account];
    } else {
        console.log(`Updating existing tables for account '${account}'.`);
    }

    tables.forEach((table) => {
        console.log(`  - Processing table '${table.name}'`);
        accountTables[table.name] = {
            auto_index: table.autoIndex,
            indices: table.indices
        };
    });

    await writeFile(targetPath, JSON.stringify(chainConfig, null, 2));
    console.log(`✅ Contract config saved successfully for account '${account}' in ${shortName}.config.json`);

    await reloadConfig(shortName, account);
}

// main program
(() => {
    const connections = program.command('connections');

    connections
        .command('init')
        .description('create and test the connections.json file')
        .option('--amqp-user <user>', 'RabbitMQ username')
        .option('--amqp-pass <password>', 'RabbitMQ password')
        .option('--amqp-vhost <vhost>', 'RabbitMQ vhost')
        .option('--es-user <user>', 'Elasticsearch username')
        .option('--es-pass <password>', 'Elasticsearch password')
        .option('--es-protocol <protocol>', 'Elasticsearch protocol (http/https)')
        .option('--redis-host <host>', 'Redis server host')
        .option('--redis-port <port>', 'Redis server port')
        .option('--mongo-enabled <boolean>', 'Enable MongoDB integration (true/false)')
        .option('--mongo-host <host>', 'MongoDB server host')
        .option('--mongo-port <port>', 'MongoDB server port')
        .option('--mongo-user <user>', 'MongoDB username')
        .option('--mongo-pass <password>', 'MongoDB password')
        .option('--mongo-prefix <prefix>', 'MongoDB database prefix')
        .action(initConfig);

    // ./hyp-config connections test
    connections.command('test').description('test connections to the hyperion infrastructure').action(testConnections);

    // ./hyp-config connections reset
    connections.command('reset').description('remove the connections.json file').action(resetConnections);

    // ./hyp-config chains
    const chains = program.command('chains');

    // ./hyp-config chains list
    chains
        .command('list')
        .alias('ls')
        .option('--valid', 'only show valid chains')
        .option('--fix-missing-fields', 'set defaults on missing fields')
        .description('list configured chains')
        .action(listChains);

    // ./hyp-config chains new <shortName>
    chains
        .command('new <shortName>')
        .description('initialize new chain config based on example')
        .requiredOption('--http <http_endpoint>', 'define chain api http endpoint')
        .requiredOption('--ship <ship_endpoint>', 'define state history ws endpoint')
        .option('--use-pending', 'use existing pending chain config instead of creating a new one')
        .action(newChain);

    // ./hyp-config chains remove <shortName>
    chains.command('remove <shortName>').description('backup and delete chain configuration').action(rmChain);

    // ./hyp-config chains test <shortName>
    chains.command('test <shortName>').description('test a chain configuration').action(testChain);

    // ./hyp-config chains validate <shortName>
    chains
        .command('validate <shortName>')
        .description('validate a chain configuration using schema')
        .option('--fix', 'automatically fix missing or invalid fields using reference configuration')
        .action(validateChain);

    // DEPRECATED ./hyp-config list chains
    const list = program
        .command('list', {
            hidden: true
        })
        .alias('ls');
    list.command('chains')
        .option('--valid', 'only show valid chains')
        .option('--fix-missing-fields', 'set defaults on missing fields')
        .description('list configured chains')
        .action(listChains);

    // DEPRECATED ./hyp-config new chain <shortName>
    const newCmd = program
        .command('new', {
            hidden: true
        })
        .alias('n');
    newCmd
        .command('chain <shortName>')
        .description('initialize new chain config based on example')
        .requiredOption('--http <http_endpoint>', 'define chain api http endpoint')
        .requiredOption('--ship <ship_endpoint>', 'define state history ws endpoint')
        .action(newChain);

    // DEPRECATED ./hyp-config remove chain <shortName>
    const remove = program
        .command('remove', {
            hidden: true
        })
        .alias('rm');
    remove.command('chain <shortName>').description('backup and delete chain configuration').action(rmChain);

    const contracts = program.command('contracts');

    //List Config
    contracts.command('list <chainName>').description('list contracts config').action(listConfigContract);

    // Add to config
    contracts
        .command('add-single <chainName> <account> <table> <autoIndex> [indices]')
        .description('add or update a single table in contract config (indices as JSON string, required if autoIndex is false)')
        .action(async (chainName, account, table, autoIndex, indicesJson?: string) => {
            try {
                let indices: IndexConfig = {}; // Default to empty
                const isAutoIndex = autoIndex === 'true';
                const isManualIndex = autoIndex === 'false';

                if (isAutoIndex) {
                    // If autoIndex is true, indices are implicitly empty, ignore indicesJson
                    indices = {};
                    if (indicesJson) {
                        console.warn("WARN: 'indices' argument provided but ignored because autoIndex is true.");
                    }
                } else if (isManualIndex) {
                    // If autoIndex is false, indicesJson is required
                    if (!indicesJson) {
                        console.error("Error: 'indices' argument is required when autoIndex is false.");
                        console.error(
                            'Please provide indices as a valid JSON string, e.g., \'{"fieldName":1}\', 1 for ascending, -1 for descending.'
                        );
                        process.exit(1); // Exit if required argument is missing
                    }
                    // Parse the provided JSON
                    indices = JSON.parse(indicesJson);
                } else {
                    // Handle invalid autoIndex value
                    console.error(`Error: Invalid value for autoIndex: '${autoIndex}'. Must be 'true' or 'false'.`);
                    process.exit(1);
                }

                // Proceed with the valid indices object
                const tableInput: TableInput = {
                    name: table,
                    autoIndex: isAutoIndex, // Use the boolean value
                    indices: indices
                };
                await addOrUpdateContractConfig(chainName, account, [tableInput]);
            } catch (error: any) {
                // Catch JSON parsing errors specifically for the manual case
                if (autoIndex === 'false' && error instanceof SyntaxError) {
                    console.error(`Error parsing indices JSON: ${error.message}`);
                    console.error('Please provide indices as a valid JSON string, e.g., \'{"owner":1}\'');
                } else {
                    console.error(`An unexpected error occurred: ${error.message}`); // Handle other potential errors
                }
                process.exit(1); // Exit on error
            }
        });

    contracts
        .command('add-multiple <chainName> <account> <tablesJson>')
        .description('add or update multiple tables in contract config (tables as JSON string, indices required per table if autoIndex is false)')
        .action(async (chainName, account, tablesJson) => {
            try {
                // Define a more specific type for the input data
                type TableJsonInput = { name: string; autoIndex: boolean; indices?: IndexConfig };
                const tablesData: Array<TableJsonInput> = JSON.parse(tablesJson);

                const tables: TableInput[] = tablesData.map((t, index) => {
                    let finalIndices: IndexConfig = {};
                    const isAutoIndex = t.autoIndex === true; // Explicit check for boolean true
                    const isManualIndex = t.autoIndex === false; // Explicit check for boolean false

                    if (isAutoIndex) {
                        finalIndices = {}; // Default to empty for autoIndex
                        if (t.indices && Object.keys(t.indices).length > 0) {
                            console.warn(
                                `WARN: Table '${t.name}' (index ${index} in JSON) has autoIndex=true, but indices were provided and will be ignored.`
                            );
                        }
                    } else if (isManualIndex) {
                        // Manual index requires indices to be provided and be a non-empty object
                        if (!t.indices || typeof t.indices !== 'object' || Object.keys(t.indices).length === 0) {
                            console.error(
                                `Error: Table '${t.name}' (index ${index} in JSON) has autoIndex=false, but 'indices' are missing or empty.`
                            );
                            console.error('Please provide valid indices for this table, e.g., \'{"fieldName":1}\'');
                            process.exit(1); // Exit on error for this specific table
                        }
                        finalIndices = t.indices;
                    } else {
                        // Handle invalid autoIndex value for this specific table
                        console.error(
                            `Error: Table '${t.name}' (index ${index} in JSON) has an invalid value for autoIndex: '${t.autoIndex}'. Must be true or false.`
                        );
                        process.exit(1);
                    }

                    return {
                        name: t.name,
                        autoIndex: isAutoIndex,
                        indices: finalIndices
                    };
                });

                // If mapping completes without exiting, proceed
                await addOrUpdateContractConfig(chainName, account, tables);
            } catch (error: any) {
                if (error instanceof SyntaxError) {
                    console.error(`Error parsing tables JSON: ${error.message}`);
                    console.error(
                        'Provide tables as a valid JSON array string, e.g., \'[{"name":"table1","autoIndex":true}, {"name":"table2","autoIndex":false,"indices":{"field":1}}]\''
                    );
                } else {
                    // Handle errors potentially thrown by process.exit or other issues
                    if (!error.message?.includes('process.exit')) {
                        // Avoid double logging if exited intentionally
                        console.error(`An unexpected error occurred: ${error.message}`);
                    }
                }
                // Ensure exit if not already handled by specific checks
                if (!process.exitCode) {
                    process.exit(1);
                }
            }
        });

    // Configuration editing commands
    program
        .command('get <chain> <configPath>')
        .description('get a configuration value from chain config file')
        .action(async (chain: string, configPath: string) => {
            try {
                await getConfigValue(chain, configPath);
            } catch (error: any) {
                console.error(`Error getting config value: ${error.message}`);
                process.exit(1);
            }
        });

    program
        .command('set <chain> <configPath> <value>')
        .description('set a configuration value in chain config file')
        .action(async (chain: string, configPath: string, value: string) => {
            try {
                await setConfigValue(chain, configPath, value);
            } catch (error: any) {
                console.error(`Error setting config value: ${error.message}`);
                process.exit(1);
            }
        });

    program
        .command('set-default <chain> <configPath>')
        .description('reset a configuration value to its default from reference config')
        .action(async (chain: string, configPath: string) => {
            try {
                await setDefaultConfigValue(chain, configPath);
            } catch (error: any) {
                console.error(`Error setting default config value: ${error.message}`);
                process.exit(1);
            }
        });

    program
        .command('list-paths <chain>')
        .description('list all valid configuration paths for a chain')
        .option('--filter <category>', 'filter paths by category (e.g., api, indexer, scaling)')
        .action(async (chain: string, options: { filter?: string }) => {
            const { filter } = options;
            try {
                await showValidConfigPaths(filter);
            } catch (error: any) {
                console.error(`Error listing config paths: ${error.message}`);
                process.exit(1);
            }
        });

    program.parse(process.argv);
})();

async function reloadConfig(chainName: string, contractName: string) {
    const controller = new IndexerController(chainName);
    console.log('Reloading hyperion config...');
    await controller.reloadContractStateConfig(contractName);
    console.log(`Please use "./hyp-control sync contract-state ${chainName}" to sync the contract state`);
    controller.close();
}

// Configuration editing utility functions
function getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
        return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
}

function setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => {
        if (!current[key] || typeof current[key] !== 'object') {
            current[key] = {};
        }
        return current[key];
    }, obj);
    target[lastKey] = value;
}

function parseValue(valueStr: string): any {
    // Try to parse as JSON first (for objects, arrays, booleans, numbers, null)
    try {
        return JSON.parse(valueStr);
    } catch {
        // If JSON parsing fails, treat as string
        return valueStr;
    }
}

function formatValue(value: any): string {
    if (typeof value === 'object') {
        return JSON.stringify(value, null, 2);
    }
    return String(value);
}

function isValidConfigPath(configPath: string, referenceConfig: any): boolean {
    const value = getNestedValue(referenceConfig, configPath);
    return value !== undefined;
}

function getConfigPathType(configPath: string, referenceConfig: any): string {
    const value = getNestedValue(referenceConfig, configPath);
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

function validateValueType(value: any, expectedType: string, configPath: string): boolean {
    let actualType: string;
    if (value === null) {
        actualType = 'null';
    } else if (Array.isArray(value)) {
        actualType = 'array';
    } else {
        actualType = typeof value;
    }

    // Allow some type flexibility for common cases
    if (expectedType === 'number' && actualType === 'string' && !isNaN(Number(value))) {
        return true; // String numbers can be converted
    }
    
    if (expectedType === 'boolean' && actualType === 'string' && (value === 'true' || value === 'false')) {
        return true; // String booleans can be converted
    }

    return actualType === expectedType;
}

async function validateConfigPath(configPath: string): Promise<{isValid: boolean, expectedType?: string, referenceValue?: any}> {
    try {
        const referenceConfig = await getExampleConfig();
        const isValid = isValidConfigPath(configPath, referenceConfig);
        
        if (isValid) {
            const referenceValue = getNestedValue(referenceConfig, configPath);
            const expectedType = getConfigPathType(configPath, referenceConfig);
            return { isValid: true, expectedType, referenceValue };
        }
        
        return { isValid: false };
    } catch (error) {
        console.error('Error loading reference configuration for validation');
        return { isValid: false };
    }
}

async function getConfigValue(chainName: string, configPath: string) {
    console.log(`Getting configuration value for ${chainName}: ${configPath}`);
    
    // Validate configuration path against reference
    const validation = await validateConfigPath(configPath);
    if (!validation.isValid) {
        console.error(`Invalid configuration path '${configPath}'`);
        console.error('Please check the reference configuration for valid paths.');
        console.error('Hint: Use dot notation like "indexer.start_on" or "scaling.readers"');
        process.exit(1);
    }

    const targetPath = path.join(chainsDir, `${chainName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`Chain config for ${chainName} not found!`);
        process.exit(1);
    }

    try {
        const chainJsonFile = await readFile(targetPath);
        const chainConfig: HyperionConfig = JSON.parse(chainJsonFile.toString());

        const value = getNestedValue(chainConfig, configPath);

        if (value === undefined) {
            console.error(`Configuration path '${configPath}' not found in ${chainName}.config.json`);
            console.log(`This path exists in reference config with default value: ${formatValue(validation.referenceValue)}`);
            console.log(`You can set it using: ./hyp-config set-default ${chainName} ${configPath}`);
            process.exit(1);
        }

        console.log(`${configPath}: ${formatValue(value)}`);
        console.log(`Type: ${validation.expectedType}`);
    } catch (error: any) {
        console.error(`Error reading configuration: ${error.message}`);
        process.exit(1);
    }
}

async function setConfigValue(chainName: string, configPath: string, valueStr: string) {
    console.log(`Setting configuration value for ${chainName}: ${configPath} = ${valueStr}`);
    
    // Validate configuration path against reference
    const validation = await validateConfigPath(configPath);
    if (!validation.isValid) {
        console.error(`Invalid configuration path '${configPath}'`);
        console.error('Please check the reference configuration for valid paths.');
        console.error('Hint: Use dot notation like "indexer.start_on" or "scaling.readers"');
        process.exit(1);
    }

    const targetPath = path.join(chainsDir, `${chainName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`Chain config for ${chainName} not found!`);
        process.exit(1);
    }

    try {
        const chainJsonFile = await readFile(targetPath);
        let chainConfig: HyperionConfig = JSON.parse(chainJsonFile.toString());

        // Parse the value
        let parsedValue: any;
        try {
            parsedValue = parseValue(valueStr);
        } catch (error) {
            console.error(`Error parsing value '${valueStr}': ${error}`);
            console.error('For complex values, use JSON format like: \'{"key": "value"}\' or \'[1,2,3]\'');
            process.exit(1);
        }

        // Validate value type against reference (basic check)
        if (!validateValueType(parsedValue, validation.expectedType!, configPath)) {
            console.error(`Type mismatch for '${configPath}'`);
            console.error(`Expected: ${validation.expectedType}, but got: ${typeof parsedValue}`);
            console.error(`Reference value: ${formatValue(validation.referenceValue)}`);
            console.error(`Your value: ${formatValue(parsedValue)}`);
            process.exit(1);
        }

        // Convert string values to proper types if needed
        if (validation.expectedType === 'number' && typeof parsedValue === 'string') {
            parsedValue = Number(parsedValue);
        } else if (validation.expectedType === 'boolean' && typeof parsedValue === 'string') {
            parsedValue = parsedValue === 'true';
        }

        // Check if the path exists before setting
        const currentValue = getNestedValue(chainConfig, configPath);
        if (currentValue !== undefined) {
            console.log(`Current value: ${formatValue(currentValue)}`);
        } else {
            console.log(`Creating new configuration path: ${configPath}`);
        }

        // Set the new value
        setNestedValue(chainConfig, configPath, parsedValue);

        // Validate the entire configuration with Zod schema before saving
        console.log('🔍 Validating configuration with schema...');
        const validationResult = HyperionConfigSchema.safeParse(chainConfig);

        if (!validationResult.success) {
            console.error(`❌ Configuration validation failed after setting '${configPath}':`);
            
            // Show only errors related to the path we just changed or its vicinity
            const relevantErrors = validationResult.error.issues.filter(issue => {
                const errorPath = issue.path.join('.');
                return errorPath.startsWith(configPath) || configPath.startsWith(errorPath);
            });

            if (relevantErrors.length > 0) {
                console.error('\n🔸 Related validation errors:');
                relevantErrors.forEach(issue => {
                    const errorPath = issue.path.join('.');
                    console.error(`   • ${errorPath}: ${issue.message}`);
                });
            } else {
                // Show first few general errors if no specific ones found
                console.error('\n🔸 Schema validation errors:');
                validationResult.error.issues.slice(0, 3).forEach(issue => {
                    const errorPath = issue.path.join('.');
                    console.error(`   • ${errorPath || 'root'}: ${issue.message}`);
                });
                if (validationResult.error.issues.length > 3) {
                    console.error(`   ... and ${validationResult.error.issues.length - 3} more errors`);
                }
            }

            console.error('\n💡 The value was set but the overall configuration is invalid.');
            console.error('Please fix the validation errors or run:');
            console.error(`   ./hyp-config chains validate ${chainName} --fix`);
            process.exit(1);
        }

        // Create backup
        if (!existsSync(backupDir)) {
            await mkdir(backupDir);
        }
        const timestamp = Date.now();
        const backupPath = path.join(backupDir, `${chainName}_${timestamp}_config.json`);
        await cp(targetPath, backupPath);
        console.log(`📦 Backup created: ${backupPath}`);

        // Save the updated configuration
        await writeFile(targetPath, JSON.stringify(chainConfig, null, 2));

        console.log(`✅ Configuration updated and validated successfully!`);
        console.log(`New value: ${formatValue(parsedValue)}`);

    } catch (error: any) {
        console.error(`Error updating configuration: ${error.message}`);
        process.exit(1);
    }
}

async function setDefaultConfigValue(chainName: string, configPath: string) {
    console.log(`Setting default value for ${chainName}: ${configPath}`);
    
    // Validate configuration path against reference
    const validation = await validateConfigPath(configPath);
    if (!validation.isValid) {
        console.error(`Invalid configuration path '${configPath}'`);
        console.error('Please check the reference configuration for valid paths.');
        console.error('Hint: Use dot notation like "indexer.start_on" or "scaling.readers"');
        process.exit(1);
    }

    const targetPath = path.join(chainsDir, `${chainName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`Chain config for ${chainName} not found!`);
        process.exit(1);
    }

    try {
        // Load the reference configuration to get default values
        const exampleConfig = await getExampleConfig();
        const defaultValue = getNestedValue(exampleConfig, configPath);

        const chainJsonFile = await readFile(targetPath);
        const chainConfig: HyperionConfig = JSON.parse(chainJsonFile.toString());

        // Check current value
        const currentValue = getNestedValue(chainConfig, configPath);
        if (currentValue !== undefined) {
            console.log(`Current value: ${formatValue(currentValue)}`);
        } else {
            console.log(`Path '${configPath}' does not exist in current config`);
        }

        // Set the default value
        setNestedValue(chainConfig, configPath, defaultValue);

        // Validate the entire configuration with Zod schema before saving
        console.log('🔍 Validating configuration with schema...');
        const validationResult = HyperionConfigSchema.safeParse(chainConfig);

        if (!validationResult.success) {
            console.error(`❌ Configuration validation failed after setting '${configPath}' to default:`);
            
            // Show only errors related to the path we just changed or its vicinity
            const relevantErrors = validationResult.error.issues.filter(issue => {
                const errorPath = issue.path.join('.');
                return errorPath.startsWith(configPath) || configPath.startsWith(errorPath);
            });

            if (relevantErrors.length > 0) {
                console.error('\n🔸 Related validation errors:');
                relevantErrors.forEach(issue => {
                    const errorPath = issue.path.join('.');
                    console.error(`   • ${errorPath}: ${issue.message}`);
                });
            } else {
                // Show first few general errors if no specific ones found
                console.error('\n🔸 Schema validation errors:');
                validationResult.error.issues.slice(0, 3).forEach(issue => {
                    const errorPath = issue.path.join('.');
                    console.error(`   • ${errorPath || 'root'}: ${issue.message}`);
                });
                if (validationResult.error.issues.length > 3) {
                    console.error(`   ... and ${validationResult.error.issues.length - 3} more errors`);
                }
            }

            console.error('\n💡 The default value was set but the overall configuration is invalid.');
            console.error('Please fix the validation errors or run:');
            console.error(`   ./hyp-config chains validate ${chainName} --fix`);
            process.exit(1);
        }

        // Create backup
        if (!existsSync(backupDir)) {
            await mkdir(backupDir);
        }
        const timestamp = Date.now();
        const backupPath = path.join(backupDir, `${chainName}_${timestamp}_config.json`);
        await cp(targetPath, backupPath);
        console.log(`📦 Backup created: ${backupPath}`);

        // Save the updated configuration
        await writeFile(targetPath, JSON.stringify(chainConfig, null, 2));

        console.log(`✅ Configuration reset to default and validated successfully!`);
        console.log(`Default value: ${formatValue(defaultValue)}`);
        console.log(`Type: ${validation.expectedType}`);

    } catch (error: any) {
        console.error(`Error setting default configuration: ${error.message}`);
        process.exit(1);
    }
}

function listAllConfigPaths(obj: any, prefix: string = '', paths: string[] = []): string[] {
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const fullPath = prefix ? `${prefix}.${key}` : key;
            const value = obj[key];
            
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                // Recursively process nested objects
                listAllConfigPaths(value, fullPath, paths);
            } else {
                // This is a leaf node (primitive value, array, or null)
                paths.push(fullPath);
            }
        }
    }
    return paths;
}

async function showValidConfigPaths(filterCategory?: string) {
    try {
        const referenceConfig = await getExampleConfig();
        const allPaths = listAllConfigPaths(referenceConfig);
        
        let filteredPaths = allPaths;
        if (filterCategory) {
            filteredPaths = allPaths.filter(path => path.startsWith(filterCategory));
        }
        
        if (filteredPaths.length === 0) {
            if (filterCategory) {
                console.log(`No configuration paths found starting with '${filterCategory}'`);
                console.log('Available categories: api, indexer, settings, scaling, features, blacklists, whitelists, prefetch, hub, plugins, alerts');
            } else {
                console.log('No configuration paths found');
            }
            return;
        }
        
        console.log(`\nValid Configuration Paths${filterCategory ? ` (${filterCategory})` : ''}:`);
        console.log('=' + '='.repeat(50));
        
        // Group by top-level category for better organization
        const grouped: Record<string, string[]> = {};
        filteredPaths.forEach(path => {
            const category = path.split('.')[0];
            if (!grouped[category]) {
                grouped[category] = [];
            }
            grouped[category].push(path);
        });
        
        for (const [category, paths] of Object.entries(grouped)) {
            console.log(`\n📁 ${category.toUpperCase()}:`);
            paths.forEach(path => {
                const value = getNestedValue(referenceConfig, path);
                const type = getConfigPathType(path, referenceConfig);
                console.log(`  ${path.padEnd(40)} (${type}) = ${formatValue(value).split('\n')[0]}`);
            });
        }
        
        console.log(`\nTotal: ${filteredPaths.length} configuration paths`);
        console.log('\nUsage examples:');
        console.log('  ./hyp-config get <chain> indexer.start_on');
        console.log('  ./hyp-config set <chain> scaling.readers 2');
        console.log('  ./hyp-config set-default <chain> api.server_port');
        
    } catch (error: any) {
        console.error(`Error loading reference configuration: ${error.message}`);
        process.exit(1);
    }
}

async function validateChain(shortName: string, options: { fix?: boolean } = {}) {
    console.log(`Validating chain config for ${shortName}...`);
    const targetPath = path.join(chainsDir, `${shortName}.config.json`);

    if (!existsSync(targetPath)) {
        console.error(`❌ Chain config for ${shortName} not found at ${targetPath}`);
        process.exit(1);
    }

    try {
        // Read and parse the configuration file
        const chainJsonFile = await readFile(targetPath);
        let chainConfig = JSON.parse(chainJsonFile.toString());

        // Validate using Zod schema
        let validationResult = HyperionConfigSchema.safeParse(chainConfig);

        if (!validationResult.success && options.fix) {
            console.log(`🔧 Attempting to fix configuration issues...`);
            
            // Create backup before making changes
            const backupPath = path.join(backupDir, `${shortName}.config.backup.${Date.now()}.json`);
            if (!existsSync(backupDir)) {
                mkdirSync(backupDir, { recursive: true });
            }
            await writeFile(backupPath, JSON.stringify(chainConfig, null, 2));
            console.log(`📦 Backup created: ${backupPath}`);
            
            // Load reference configuration
            const referenceConfig = await getExampleConfig();
            let fixedFields = 0;
            
            // Define default values for fields that might not be in reference config
            const defaultValues: any = {
                api: {
                    provider_logo: ""
                },
                settings: {
                    ship_request_rev: ""
                }
            };
            
            // Helper function to set missing values from reference or defaults
            function fixMissingFields(obj: any, ref: any, defaults: any, path: string = '') {
                // First, apply reference values
                for (const key in ref) {
                    const currentPath = path ? `${path}.${key}` : key;
                    
                    if (obj[key] === undefined) {
                        obj[key] = JSON.parse(JSON.stringify(ref[key])); // Deep clone
                        console.log(`   ✓ Fixed missing field: ${currentPath} = ${JSON.stringify(ref[key])}`);
                        fixedFields++;
                    } else if (typeof ref[key] === 'object' && ref[key] !== null && !Array.isArray(ref[key])) {
                        // Recursively fix nested objects
                        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                            const nestedDefaults = defaults && defaults[key] ? defaults[key] : {};
                            fixMissingFields(obj[key], ref[key], nestedDefaults, currentPath);
                        }
                    }
                }
                
                // Then, apply default values for fields not in reference
                for (const key in defaults) {
                    const currentPath = path ? `${path}.${key}` : key;
                    
                    if (obj[key] === undefined) {
                        obj[key] = JSON.parse(JSON.stringify(defaults[key])); // Deep clone
                        console.log(`   ✓ Fixed missing field: ${currentPath} = ${JSON.stringify(defaults[key])} (default)`);
                        fixedFields++;
                    } else if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
                        // Recursively fix nested objects
                        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                            const refNested = ref && ref[key] ? ref[key] : {};
                            fixMissingFields(obj[key], refNested, defaults[key], currentPath);
                        }
                    }
                }
            }

            // Apply fixes
            fixMissingFields(chainConfig, referenceConfig, defaultValues);

            // Re-validate after fixes
            validationResult = HyperionConfigSchema.safeParse(chainConfig);

            if (validationResult.success) {
                // Save the fixed configuration
                await writeFile(targetPath, JSON.stringify(chainConfig, null, 2));
                console.log(`💾 Fixed configuration saved to ${targetPath}`);
                console.log(`🎉 Successfully fixed ${fixedFields} field(s)!`);
            } else {
                console.log(`⚠️  Fixed ${fixedFields} field(s), but some issues remain.`);
            }
        }

        if (validationResult.success) {
            console.log(`✅ Chain config for ${shortName} is valid!`);
            
            // Show summary of configuration
            console.log('\n📋 Configuration Summary:');
            console.log(`   Chain: ${validationResult.data.settings.chain}`);
            console.log(`   API Port: ${validationResult.data.api.server_port}`);
            console.log(`   Stream Port: ${validationResult.data.api.stream_port}`);
            console.log(`   Indexer Enabled: ${validationResult.data.indexer.enabled ?? 'true'}`);
            console.log(`   API Enabled: ${validationResult.data.api.enabled ?? 'true'}`);
            console.log(`   Debug Mode: ${validationResult.data.settings.debug}`);
        } else {
            console.error(`❌ Chain config for ${shortName} has validation errors:`);
            
            // Group errors by path for better readability
            const errorsByPath: { [path: string]: string[] } = {};
            
            validationResult.error.issues.forEach(issue => {
                const path = issue.path.join('.');
                if (!errorsByPath[path]) {
                    errorsByPath[path] = [];
                }
                errorsByPath[path].push(issue.message);
            });

            Object.entries(errorsByPath).forEach(([path, messages]) => {
                console.error(`\n🔸 ${path || 'root'}:`);
                messages.forEach(message => {
                    console.error(`   • ${message}`);
                });
            });

            if (!options.fix) {
                console.error(`\n💡 To automatically fix missing fields, run:`);
                console.error(`   ./hyp-config chains validate ${shortName} --fix`);
                console.error(`\n   This will create a backup and apply reference defaults for missing fields.`);
            } else {
                console.error(`\n💡 Some issues could not be automatically fixed. Please review and fix manually.`);
                console.error(`   Check the backup file if you need to restore the original configuration.`);
            }
            process.exit(1);
        }
    } catch (error: any) {
        console.error(`❌ Failed to validate chain config for ${shortName}:`);
        if (error.name === 'SyntaxError') {
            console.error(`   Invalid JSON format: ${error.message}`);
        } else {
            console.error(`   Error: ${error.message}`);
        }
        process.exit(1);
    }
}
