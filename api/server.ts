import {hLog} from "../helpers/common_functions";
import {ConfigurationModule} from "../modules/config";
import {ConnectionManager} from "../connections/manager.class";
import {HyperionConfig} from "../interfaces/hyperionConfig";
import IORedis from 'ioredis';
import fastify from 'fastify'
import {registerPlugins} from "./plugins";
import {AddressInfo} from "net";
import {registerRoutes} from "./routes";
import {generateOpenApiConfig} from "./config/open_api";
import {createWriteStream, existsSync, mkdirSync, readFileSync} from "fs";
import {SocketManager} from "./socketManager";
import {HyperionModuleLoader} from "../modules/loader";
import {extendedActions} from "./routes/v2-history/get_actions/definitions";
import {io, Socket} from "socket.io-client";
import {CacheManager} from "./helpers/cacheManager";

import {bootstrap} from 'global-agent';
bootstrap();

class HyperionApiServer {

    private hub: Socket;
    private readonly fastify;
    private readonly chain: string;
    private readonly conf: HyperionConfig;
    private readonly manager: ConnectionManager;
    private readonly cacheManager: CacheManager;

    socketManager: SocketManager;
    mLoader: HyperionModuleLoader;

    constructor() {

        const package_json = JSON.parse(readFileSync('./package.json').toString());
        hLog(`--------- Hyperion API ${package_json.version} ---------`);

        const cm = new ConfigurationModule();
        this.conf = cm.config;
        this.chain = this.conf.settings.chain;
        process.title = `hyp-${this.chain}-api`;
        this.manager = new ConnectionManager(cm);
        this.manager.calculateServerHash();
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
                res: (reply) => {
                    return {
                        statusCode: reply.statusCode
                    };
                },
                req: (request) => {
                    return {
                        method: request.method,
                        url: request.url,
                        ip: request.headers['x-real-ip']
                    }
                }
            }
        };

        this.fastify = fastify({
            ignoreTrailingSlash: false,
            trustProxy: true,
            pluginTimeout: 5000,
            logger: this.conf.api.access_log ? loggerOpts : false
        });

        this.fastify.decorate('cacheManager', this.cacheManager);

        this.fastify.decorate('manager', this.manager);

        // import get_actions query params from custom modules
        const extendedActionsSet: Set<string> = new Set([...extendedActions]);
        for (const qPrefix of this.mLoader.extendedActions) {
            extendedActionsSet.add(qPrefix);
        }
        this.fastify.decorate('allowedActionQueryParamSet', extendedActionsSet);

        // define chain api url for /v1/chain/ redirects
        let chainApiUrl: string = this.conf.api.push_api;
        if (chainApiUrl === null || chainApiUrl === "") {
            chainApiUrl = this.manager.conn.chains[this.chain].http;
        }
        this.fastify.decorate('chain_api', chainApiUrl);

        // define optional push api url for /v1/chain/push_transaction
        if (this.conf.api.push_api) {
            this.fastify.decorate('push_api', this.conf.api.push_api);
        }

        hLog(`Chain API URL: "${this.fastify.chain_api}" | Push API URL: "${this.fastify.push_api}"`);

        const ioRedisClient = new IORedis(this.manager.conn.redis);

        const pluginParams = {
            fastify_elasticsearch: {
                client: this.manager.elasticsearchClient
            },
            fastify_redis: this.manager.conn.redis,
            fastify_eosjs: this.manager,
        } as any;

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
            pluginParams.fastify_rate_limit = {
                max: rateLimiterRPM,
                allowList: rateLimiterWhitelist,
                timeWindow: '1 minute',
                redis: ioRedisClient
            }
        }

        if (this.conf.features.streaming.enable) {
            this.activateStreaming();
        }

        const docsConfig = generateOpenApiConfig(this.manager.config);
        if (docsConfig) {
            pluginParams.fastify_swagger = docsConfig;
        }

        registerPlugins(this.fastify, pluginParams);

        this.addGenericTypeParsing();
    }

    activateStreaming() {
        console.log('Importing stream module');
        import('./socketManager').then((mod) => {
            const connOpts = this.manager.conn.chains[this.chain];

            let _port = 57200;
            if (connOpts.WS_ROUTER_PORT) {
                _port = connOpts.WS_ROUTER_PORT;
            }

            let _host = "127.0.0.1";
            if (connOpts.WS_ROUTER_HOST) {
                _host = connOpts.WS_ROUTER_HOST;
            }

            this.socketManager = new mod.SocketManager(
                this.fastify,
                `http://${_host}:${_port}`,
                this.manager.conn.redis
            );
            this.socketManager.startRelay();
        });
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
            payload.on('error', (err) => {
                console.log('---- Content Parsing Error -----');
                console.log(err);
            });
        });
    }

    async init() {

        await this.mLoader.init();

        // add custom plugin routes
        for (const plugin of this.mLoader.plugins) {
            if (plugin.hasApiRoutes) {
                hLog(`Adding routes for plugin: ${plugin.internalPluginName}`);
                plugin.addRoutes(this.fastify);
                plugin.chainName = this.chain;
            }
        }

        registerRoutes(this.fastify);

        // register documentation when ready
        this.fastify.ready().then(async () => {
            await this.fastify.swagger();
        }, (err) => {
            hLog('an error happened', err)
        });

        try {
            await this.fastify.listen({
                host: this.conf.api.server_addr,
                port: this.conf.api.server_port
            });
            hLog(`${this.chain} hyperion api ready and listening on port ${(this.fastify.server.address() as AddressInfo).port}`);
            this.startHyperionHub();
        } catch (err) {
            hLog(err);
            process.exit(1)
        }
    }

    startHyperionHub() {
        if (this.conf.hub) {
            const url = this.conf.hub.inform_url;
            hLog(`Connecting API to Hyperion Hub`);
            this.hub = io(url, {
                query: {
                    key: this.conf.hub.publisher_key,
                    client_mode: 'false'
                }
            });
            this.hub.on('connect', () => {
                hLog(`Hyperion Hub connected!`);
                this.emitHubApiUpdate();
            });
        }
    }

    private emitHubApiUpdate() {
        this.hub.emit('hyp_info', {
            type: 'api',
            production: this.conf.hub.production,
            location: this.conf.hub.location,
            chainId: this.manager.conn.chains[this.chain].chain_id,
            providerName: this.conf.api.provider_name,
            explorerEnabled: this.conf.plugins.explorer?.enabled,
            providerUrl: this.conf.api.provider_url,
            providerLogo: this.conf.api.provider_logo,
            chainLogo: this.conf.api.chain_logo_url,
            chainCodename: this.chain,
            chainName: this.conf.api.chain_name,
            endpoint: this.conf.api.server_name,
            features: this.conf.features,
            filters: {
                blacklists: this.conf.blacklists,
                whitelists: this.conf.whitelists
            }
        });
    }
}

const server = new HyperionApiServer();

server.init().catch(hLog);
