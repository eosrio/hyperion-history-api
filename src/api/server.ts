import {getFirstIndexedBlock, getLastResult, hLog, waitUntilReady} from "../indexer/helpers/common_functions.js";
import {ConfigurationModule} from "../indexer/modules/config.js";
import {ConnectionManager} from "../indexer/connections/manager.class.js";
import {HyperionConfig} from "../interfaces/hyperionConfig.js";
import {Redis} from 'ioredis';
import fastify, {FastifyInstance, FastifyReply} from 'fastify'
import {registerPlugins} from "./plugins.js";
import {AddressInfo} from "net";
import {registerRoutes} from "./routes.js";
import {generateOpenApiConfig} from "./config/open_api.js";
import {createWriteStream, existsSync, mkdirSync, readFileSync} from "fs";
import {SocketManager} from "./socketManager.js";
import {HyperionModuleLoader} from "../indexer/modules/loader.js";
import {extendedActions} from "./routes/v2-history/get_actions/definitions.js";
import {CacheManager} from "./helpers/cacheManager.js";

import {bootstrap} from 'global-agent';
import {FastifySwaggerUiOptions} from "@fastify/swagger-ui";
import {QRYBasePublisher} from "./qry-hub/base-publisher.js";
import {getApiUsageHistory} from "./helpers/functions.js";
import {WebSocket} from "ws";
import {StateHistorySocket} from "../indexer/connections/state-history.js";
import {AlertManagerOptions, AlertsManager} from "../indexer/modules/alertsManager.js";
import {join} from "node:path";
import {FastifyMongodbOptions} from "@fastify/mongodb";

import {createContext, runInContext} from "node:vm";
import fastifyHttpProxy from "@fastify/http-proxy";


class HyperionApiServer {

    private readonly fastify: FastifyInstance;
    private readonly pluginParams: any;
    private readonly chain: string;
    private readonly conf: HyperionConfig;
    private readonly manager: ConnectionManager;

    private readonly cacheManager: CacheManager;
    socketManager?: SocketManager;
    mLoader: HyperionModuleLoader;

    qryPublisher?: QRYBasePublisher;

    lastSentTimestamp = "";
    private indexerController?: WebSocket;
    private alerts?: AlertsManager;

    constructor() {

        const package_json = JSON.parse(readFileSync('./package.json').toString());
        hLog(`--------- Hyperion API ${package_json.version} ---------`);

        const cm = new ConfigurationModule();
        this.conf = cm.config;

        if (this.conf.settings.use_global_agent) {
            bootstrap();
        }

        this.chain = this.conf.settings.chain;
        process.title = `hyp-${this.chain}-api`;

        this.manager = new ConnectionManager(cm);
        this.manager.calculateServerHash();
        this.manager.prepareMongoClient();

        this.initAlerts();

        this.mLoader = new HyperionModuleLoader(cm);
        this.cacheManager = new CacheManager(this.conf);

        if (!existsSync('./logs/' + this.chain)) {
            mkdirSync('./logs/' + this.chain, {recursive: true});
        }

        const logStream = createWriteStream('./logs/' + this.chain + '/api.access.log');

        const loggerOpts = {
            stream: logStream,
            redact: ['req.headers.authorization'],
            level: 'info',
            prettyPrint: true,
            serializers: {
                res: (reply: { statusCode: any; }) => {
                    return {
                        statusCode: reply.statusCode
                    };
                },
                req: (request: any) => {
                    return {
                        method: request.method,
                        url: request.url,
                        ip: request.headers['x-real-ip']
                    }
                }
            }
        };

        this.fastify = fastify({
            exposeHeadRoutes: false,
            ignoreTrailingSlash: false,
            trustProxy: true,
            pluginTimeout: 5000,
            logger: this.conf.api.access_log ? loggerOpts : false,
            // logger: true,
            ajv: {
                customOptions: {
                    strict: false,
                    allowUnionTypes: true
                }
            }
        });

        this.fastify.decorate('cacheManager', this.cacheManager);

        this.fastify.decorate('manager', this.manager);

        const chainConnections = this.manager.conn.chains[this.chain];
        const shs = new StateHistorySocket(chainConnections.ship);
        this.fastify.decorate('shs', shs);

        // import get_actions query params from custom modules
        const extendedActionsSet: Set<string> = new Set([...extendedActions]);
        for (const qPrefix of this.mLoader.extendedActions) {
            extendedActionsSet.add(qPrefix);
        }
        this.fastify.decorate('allowedActionQueryParamSet', extendedActionsSet);

        // define chain api url for /v1/chain/ redirects
        let chainApiUrl: string = this.conf.api.chain_api ?? "";
        if (chainApiUrl === null || chainApiUrl === "") {
            chainApiUrl = this.manager.conn.chains[this.chain].http;
        }

        this.fastify.decorate('chain_api', chainApiUrl);

        // define optional push api url for /v1/chain/push_transaction
        if (this.conf.api.push_api) {
            this.fastify.decorate('push_api', this.conf.api.push_api);
        }

        hLog(`Chain API URL: "${this.fastify.chain_api}" | Push API URL: "${this.fastify.push_api}"`);

        // check for locally installed explorer
        this.configureExplorer();


        const ioRedisClient = new Redis(this.manager.conn.redis);

        const staticAssetsDir = join(import.meta.dirname, '../../', 'static');

        // hLog(`Static Assets Dir: ${staticAssetsDir}`);

        // decorate fastify with the elasticsearch client
        this.fastify.decorate('elastic', this.manager.elasticsearchClient);

        this.pluginParams = {
            fastify_redis: this.manager.conn.redis,
            fastify_eosjs: this.manager,
            fastify_antelope: {
                manager: this.manager
            },
            chain_id: '',
            fastify_static: {
                root: staticAssetsDir,
                index: false,
                prefix: '/static/'
            }
        } as any;

        if (this.manager.mongodbClient) {
            this.pluginParams.fastify_mongo = {client: this.manager.mongodbClient} as FastifyMongodbOptions;
        }

        if (!this.conf.api.disable_rate_limit) {
            let rateLimiterWhitelist = ['127.0.0.1'];
            if (this.conf.api.rate_limit_allow && this.conf.api.rate_limit_allow.length > 0) {
                const tempSet = new Set<string>(['127.0.0.1', ...this.conf.api.rate_limit_allow]);
                rateLimiterWhitelist = [...tempSet];
            }
            let rateLimiterRPM = 1000;
            if (this.conf.api.rate_limit_rpm) {
                rateLimiterRPM = this.conf.api.rate_limit_rpm;
            }
            this.pluginParams.fastify_rate_limit = {
                max: rateLimiterRPM,
                allowList: rateLimiterWhitelist,
                timeWindow: '1 minute',
                redis: ioRedisClient
            }
        }

        if (this.conf.features.streaming.enable) {
            this.activateStreaming();
        }

        const headerLogo = readFileSync(join(staticAssetsDir, 'logo-hyperion-white-horz.svg'));

        const customCss = readFileSync(join(staticAssetsDir, 'theme', 'custom-swagger-theme.css')).toString();

        const docsConfig = generateOpenApiConfig(this.manager.config);
        if (docsConfig) {
            this.pluginParams.fastify_swagger = docsConfig;
            this.pluginParams.fastify_swagger_ui = {
                logo: {
                    type: 'image/svg+xml',
                    content: headerLogo,
                    href: '/docs',
                    target: '_self'
                },
                theme: {
                    css: [{filename: 'theme.css', content: customCss}]
                },
                routePrefix: '/docs',
                uiConfig: {
                    docExpansion: "list",
                    deepLinking: true
                },
                staticCSP: false,
                validatorUrl: 'https://validator.swagger.io/validator',
                transformStaticCSP: (header: string) => {
                    console.log(header);
                    return header;
                },
            } as FastifySwaggerUiOptions;
        }
    }

    activateStreaming() {
        const connOpts = this.manager.conn.chains[this.chain];
        let _port = 57200;
        if (connOpts.WS_ROUTER_PORT) {
            _port = connOpts.WS_ROUTER_PORT;
        }
        let _host = "127.0.0.1";
        if (connOpts.WS_ROUTER_HOST) {
            _host = connOpts.WS_ROUTER_HOST;
        }
        if (_host === "0.0.0.0") {
            hLog(`[ERROR] WS Router Host is set to 0.0.0.0, please use a fixed IP address instead. Can't start streaming.`);
            return;
        }
        this.socketManager = new SocketManager(
            this.fastify,
            `http://${_host}:${_port}`,
            this.manager.conn.redis
        );
        this.socketManager.startRelay();
    }

    private addGenericTypeParsing() {
        this.fastify.addContentTypeParser('*', (request, payload, done) => {
            let data = '';
            payload.on('data', chunk => {
                data += chunk;
            });
            payload.on('end', () => {
                done(null, data);
            });
            payload.on('error', (err: any) => {
                console.log('---- Content Parsing Error -----');
                console.log(err);
            });
        });
    }

    async init() {

        const rpc = this.manager.nodeosJsonRPC;
        await waitUntilReady(async () => {
            try {
                const chain_data = await rpc.get_info();
                if (chain_data && chain_data.chain_id) {
                    this.pluginParams.chain_id = chain_data.chain_id;
                    return true;
                } else {
                    return false;
                }
            } catch (e: any) {
                hLog(e.message);
                return false;
            }
        }, 20, 5000, () => {
            hLog('Failed to validate chain api!');
            process.exit(1);
        });
        hLog('Chain API validated!');

        // Wait for Elasticsearch availability
        await waitUntilReady(async () => {
            try {
                const esInfo = await this.manager.elasticsearchClient.info();
                hLog(`Elasticsearch: ${esInfo.version.number} | Lucene: ${esInfo.version.lucene_version}`);
                this.fastify.decorate('elastic_version', esInfo.version.number);
                return true;
            } catch (e: any) {
                console.log(e.message);
                return false;
            }
        }, 10, 5000, () => {
            hLog('Failed to check elasticsearch version!');
            process.exit();
        });

        await registerPlugins(this.fastify, this.pluginParams);

        // Wait for MongoDB availability
        await waitUntilReady(async () => {
            try {
                this.manager.prepareMongoClient();
                if (this.manager.mongodbClient) {
                    await this.manager.mongodbClient.connect();
                    const buildInfo = await this.manager.mongodbClient.db("admin").command({buildInfo: 1});
                    hLog(`MongoDB: ${buildInfo.version}`);
                    return true;
                } else {
                    return false;
                }
            } catch (e: any) {
                console.log(e.message);
                return false;
            }
        }, 10, 5000, () => {
            hLog('Failed to check mongodb version!');
            process.exit();
        })

        this.addGenericTypeParsing();

        await this.mLoader.init();

        hLog('Registering plugins...');
        // add custom plugin routes
        for (const plugin of this.mLoader.plugins) {
            if (plugin.hasApiRoutes) {
                hLog(`Adding routes for plugin: ${plugin.internalPluginName}`);
                plugin.addRoutes(this.fastify);
                plugin.chainName = this.chain;
            }
        }

        // FASTIFY ROUTES
        this.registerHomeRoute();
        this.registerQryHubRoutes();
        registerRoutes(this.fastify);

        try {


            try {
                await this.fastify.ready();
                this.fastify.swagger();
            } catch (e: any) {
                hLog(`Failed to load Swagger UI: ${e.message}`);
            }

            await this.fastify.listen({host: this.conf.api.server_addr, port: this.conf.api.server_port});
            const listeningAddress = this.fastify.server.address() as AddressInfo;
            if (listeningAddress.address === '0.0.0.0') {
                hLog(`Hyperion API for "${this.chain}" ready and listening on port ${listeningAddress.port} (all interfaces)`);
            } else {
                hLog(`Hyperion API for "${this.chain}" ready and listening on port http://${listeningAddress.address}:${listeningAddress.port}`);
            }
            hLog(`API Public Url: ${this.conf.api.server_name}`);
            this.alerts?.emit('ApiStart', {
                hyperion_version: this.manager.current_version,
                public_url: this.conf.api.server_name,
                chain_id: this.pluginParams.chain_id,
                message: "API Server Started"
            });

            await this.startQRYHub();

            this.setupIndexerController();

            // remove ES status key
            await this.fastify.redis.del(`${this.chain}::es_status`);

        } catch (err) {
            hLog(err);
            process.exit(1)
        }
    }

    async getPast24HoursUsage(): Promise<{ ct: number, ts: string }[]> {
        const stats = await getApiUsageHistory(this.fastify);
        const dataPoints: any[] = [];
        if (stats.buckets && stats.buckets.length > 0) {
            for (const bucket of stats.buckets) {
                // check if the bucket is older than 1 hour
                if (bucket.timestamp < (Date.now() - 3600000)) {
                    let hits = 0;
                    const responses = bucket.responses["200"];
                    if (responses) {
                        Object.keys(responses).forEach((k) => {
                            hits += responses[k];
                        });
                    }
                    dataPoints.push({ct: hits, ts: bucket.timestamp});
                }
            }
        }
        return dataPoints;
    }

    registerQryHubRoutes() {
        this.fastify.get('/.qry/usage', {schema: {hide: true}}, async () => {
            return this.getPast24HoursUsage();
        });

        this.fastify.get('/.qry/first', {schema: {hide: true}}, async () => {
            const tRef = process.hrtime.bigint();
            const firstBlock = await getFirstIndexedBlock(this.fastify.elastic, this.chain, this.conf.settings.index_partition_size);
            const tEnd = process.hrtime.bigint();
            const timeNano = tEnd - tRef;
            const timeMs = parseInt(timeNano.toString()) / 1000000;
            return {
                query_time_ms: timeMs,
                first: firstBlock
            };
        });

        this.fastify.get('/.qry/get_first_block_histogram', {schema: {hide: true}}, async (request, reply) => {
            let firstBlock = -1;
            const tRef = process.hrtime.bigint();

            const times: { name: string, time: number }[] = [];

            const elastic = this.fastify.elastic;

            const indices = await elastic.cat.indices({
                index: this.chain + '-action-*',
                s: 'index',
                v: true,
                format: 'json'
            });

            const getIndicesTime = this.logTime(tRef);
            times.push({name: 'get_indices', time: getIndicesTime});
            console.log(`Time to get indices: ${getIndicesTime}ms`);

            const firstIndex = indices[0].index;

            if (!firstIndex) {
                return reply.status(500).send({
                    first: firstBlock,
                    times: times,
                    error: 'No indices found'
                });
            }

            const parts = firstIndex.split('-');
            const blockChunk = parts[parts.length - 1];
            const blockChunkSize = this.conf.settings.index_partition_size || 10000000;
            const startBlock = (parseInt(blockChunk) - 1) * blockChunkSize;
            const endBlock = startBlock + blockChunkSize;

            const histogramInterval = 100000;

            const tRefHistogram = process.hrtime.bigint();
            const histogramData = await elastic.search<any, any>({
                index: this.chain + '-block-*',
                size: 0,
                query: {
                    range: {
                        block_num: {
                            gte: startBlock,
                            lte: endBlock
                        }
                    }
                },
                aggs: {
                    block_histogram: {
                        histogram: {
                            field: 'block_num',
                            interval: histogramInterval,
                            min_doc_count: 1,
                            order: {
                                "_key": "asc"
                            }
                        }
                    }
                }
            });

            const histogramTime = this.logTime(tRefHistogram);
            times.push({name: 'histogram', time: histogramTime});
            console.log(`Time to get histogram: ${histogramTime}ms`);

            if (!histogramData.aggregations) {
                return reply.status(500).send({
                    first: firstBlock,
                    times: times,
                    error: 'Failed to calculate histogram'
                });
            }

            const buckets = histogramData.aggregations.block_histogram.buckets;

            const firstBucket = buckets[0];

            // perform a search to get the first block in the index using a range query
            const tRefSearch = process.hrtime.bigint();
            const results = await elastic.search<any>({
                index: this.chain + '-block-*',
                size: 1,
                query: {range: {block_num: {gte: firstBucket.key, lt: firstBucket.key + histogramInterval}}},
                sort: [{block_num: {order: "asc"}}]
            });

            const searchTime = this.logTime(tRefSearch);
            times.push({name: 'search', time: searchTime});
            console.log(`Time to search: ${searchTime}ms`);

            firstBlock = getLastResult(results);

            const timeMs = this.logTime(tRef);
            console.log(`Total request time: ${timeMs}ms`);
            return {
                query_time_ms: timeMs,
                first: firstBlock,
                times: times,
            };
        });
    }

    logTime(tRef: bigint): number {
        const tEnd = process.hrtime.bigint();
        const timeNano = tEnd - tRef;
        return parseInt(timeNano.toString()) / 1000000;
    }

    registerHomeRoute() {
        this.fastify.get('/', {
            schema: {
                summary: 'Basic API Status',
                description: 'Basic API status information',
                tags: ['status'],
            }
        }, (_, reply: FastifyReply) => {
            if (this.fastify.manager.config.api.explorer?.home_redirect) {
                reply.redirect('/explorer');
            } else {
                reply.send({
                    version: this.manager.current_version,
                    version_hash: this.manager.getServerHash(),
                    chain: this.chain,
                    chain_id: this.manager.conn.chains[this.chain].chain_id
                });
            }
        });
    }

    async publishLastApiUsageCount() {
        const stats = await getApiUsageHistory(this.fastify);
        let totalValidHits = 0;
        if (stats.buckets && stats.buckets.length > 1) {
            const recentBucket = stats.buckets[1];
            if (recentBucket) {
                if (this.lastSentTimestamp !== recentBucket.timestamp) {
                    const validHits = recentBucket.responses["200"];
                    if (validHits) {
                        Object.keys(validHits).forEach((k) => {
                            totalValidHits += validHits[k];
                        });
                    }
                    if (this.qryPublisher) {
                        this.qryPublisher.publishApiUsage(totalValidHits, recentBucket.timestamp);
                    }
                    this.lastSentTimestamp = recentBucket.timestamp;
                }
            }
        }
    }

    async publishApiUsage() {
        const dataPoints = await this.getPast24HoursUsage();
        if (this.qryPublisher && dataPoints && dataPoints[0]) {
            this.lastSentTimestamp = dataPoints[0].ts;
            // console.log(`Last Data Point: ${this.lastSentTimestamp}`);
            this.qryPublisher.publishPastApiUsage(dataPoints);
        }
    }

    async startQRYHub() {
        if (this.conf.hub && this.conf.hub.instance_key && this.conf.hub.enabled) {
            this.qryPublisher = new QRYBasePublisher({
                hubUrl: "api.hub.qry.network",
                instancePrivateKey: this.conf.hub.instance_key,
                metadata: {
                    version: this.manager.current_version,
                    commit_hash: this.manager.last_commit_hash,
                    api: {
                        limits: this.conf.api.limits,
                        tx_cache_expiration_sec: this.conf.api.tx_cache_expiration_sec,
                        disable_tx_cache: this.conf.api.disable_tx_cache
                    },
                    blacklists: this.conf.blacklists,
                    whitelists: this.conf.whitelists,
                    features: this.conf.features,
                },
                onMetadataRequest: () => {
                    // publish usage stats only on first connection
                    if (this.lastSentTimestamp === "") {
                        // publish past 24 hours of usage
                        this.publishApiUsage().catch(hLog);
                        // publish last hour of usage every minute
                        setInterval(async () => {
                            await this.publishLastApiUsageCount();
                        }, 60 * 1000);
                    }

                    if (this.indexerController?.OPEN) {
                        this.qryPublisher?.publishIndexerStatus("active");
                    } else {
                        this.qryPublisher?.publishIndexerStatus("offline");
                    }
                }
            });
            console.log('\x1b[36m%s\x1b[0m', `Instance Key: ${this.qryPublisher.publicKey.toString()}`);
            hLog(`Connecting API to QRY Hub...`);
            await this.qryPublisher.connect();
        }
    }

    setupIndexerController() {
        let controllerUrl = this.manager.config.hub?.custom_indexer_controller;
        let controlPort = this.manager.conn.chains[this.conf.settings.chain].control_port;
        if (!controlPort) {
            controlPort = 7002;
        }

        if (!controllerUrl || controllerUrl === '') {
            controllerUrl = `localhost:${controlPort}`;
        }

        const indexerControlURL = `ws://${controllerUrl}/local`;
        hLog(`Connecting to Indexer at: ${indexerControlURL}`);
        this.indexerController = new WebSocket(indexerControlURL);

        this.indexerController.on('open', async () => {
            hLog('Connected to Hyperion Controller');
            this.qryPublisher?.publishIndexerStatus("active");
        });

        this.indexerController.on('error', (err) => {
            hLog(`Failed to connect to indexer: ${err.message}`);
        });

        this.indexerController.on('close', () => {
            hLog('Disconnected from Hyperion Controller');
            this.qryPublisher?.publishIndexerStatus("offline");
            this.alerts?.emit('IndexerError', {message: "Indexer disconnected"});
            setTimeout(() => {
                this.setupIndexerController();
            }, 5000);
        });
    }

    private initAlerts() {
        let alertManagerConf: AlertManagerOptions | null = null;
        if (this.conf.alerts && this.conf.alerts.enabled) {
            alertManagerConf = this.conf.alerts;
        } else {
            if (this.manager.conn.alerts && this.manager.conn.alerts.enabled) {
                alertManagerConf = this.manager.conn.alerts;
            }
        }
        if (alertManagerConf) {
            import('../indexer/modules/alertsManager.js').then((module) => {
                const AlertsManager = module.AlertsManager;
                this.alerts = new AlertsManager(alertManagerConf, this.chain);
            }).catch(reason => {
                hLog(`Failed to load alerts manager: ${reason}`);
            });
        }
    }

    private configureExplorer() {
        if (this.manager.config.api.explorer) {

            if (this.manager.config.api.explorer.upstream) {
                this.fastify.register(fastifyHttpProxy, {
                    upstream: this.manager.config.api.explorer.upstream,
                    rewritePrefix: '/explorer',
                    prefix: '/explorer',
                    replyOptions: {
                        rewriteRequestHeaders: (_, headers) => {
                            return {
                                ...headers,
                                'x-hyperion-chain': this.manager.chain,
                                'x-hyperion-server': this.manager.config.api.server_name
                            };
                        }
                    }
                });
            }

            const explorerPath = join(import.meta.dirname, '../../', 'explorer');
            if (existsSync(explorerPath)) {
                // load explorer theme data
                if (this.manager.config.api.explorer.theme) {
                    const themeData: Record<string, any> = {};
                    this.fastify.decorate('explorerTheme', themeData);
                    const themesPath = join(explorerPath, 'themes');
                    if (existsSync(themesPath)) {
                        const themeFile = join(themesPath, this.manager.config.api.explorer.theme + '.theme.mjs');
                        if (existsSync(themeFile)) {
                            const themeSourceData = readFileSync(themeFile).toString();

                            // create VM context to run theme data
                            const context = {themeData: {}};
                            createContext(context);
                            // run theme data in context
                            runInContext(themeSourceData, context);

                            if (Object.keys(context.themeData).length > 0) {
                                for (const key in context.themeData) {
                                    themeData[key] = context.themeData[key];
                                }
                            } else {
                                hLog(`Failed to load theme data from ${themeFile}`);
                            }

                        }
                    }
                }
            }
        }
    }
}

const server = new HyperionApiServer();

server.init().catch(hLog);
