import {hLog} from "../helpers/common_functions";
import {ConfigurationModule} from "../modules/config";
import {ConnectionManager} from "../connections/manager.class";
import {HyperionConfig} from "../interfaces/hyperionConfig";
import {IncomingMessage, Server, ServerResponse} from "http";
import * as Fastify from 'fastify';
import * as Redis from 'ioredis';
import {registerPlugins} from "./plugins";
import {AddressInfo} from "net";
import {registerRoutes} from "./routes";
import {generateOpenApiConfig} from "./config/open_api";
import {createWriteStream, existsSync, mkdirSync, writeFileSync} from "fs";
import {SocketManager} from "./socketManager";
import got from "got";
import {join} from "path";

class HyperionApiServer {

    private conf: HyperionConfig;
    private readonly manager: ConnectionManager;
    private readonly fastify: Fastify.FastifyInstance<Server, IncomingMessage, ServerResponse>;
    private readonly chain: string;
    socketManager: SocketManager;

    constructor() {
        const cm = new ConfigurationModule();
        this.conf = cm.config;
        this.chain = this.conf.settings.chain;
        process.title = `hyp-${this.chain}-api`;
        this.manager = new ConnectionManager(cm);
        this.manager.calculateServerHash();
        this.manager.getHyperionVersion();

        if (!existsSync('./logs/' + this.chain)) {
            mkdirSync('./logs/' + this.chain, {recursive: true});
        }

        const logStream = createWriteStream('./logs/' + this.chain + '/api.access.log');
        this.fastify = Fastify({
            ignoreTrailingSlash: false,
            trustProxy: true,
            logger: this.conf.api.access_log ? {
                stream: logStream,
                redact: ['req.headers.authorization'],
                level: 'info',
                serializers: {
                    res: (res) => {
                        return {
                            status: res.statusCode
                        };
                    },
                    req: (req) => {
                        return {
                            method: req.method,
                            url: req.url,
                            ip: req.headers['x-real-ip']
                        }
                    }
                }
            } : false
        });
        this.fastify.decorate('manager', this.manager);

        if (this.conf.api.chain_api && this.conf.api.chain_api !== "") {
            this.fastify.decorate('chain_api', this.conf.api.chain_api);
        } else {
            this.fastify.decorate('chain_api', this.manager.conn.chains[this.chain].http);
        }

        if (this.conf.api.push_api && this.conf.api.push_api !== "") {
            this.fastify.decorate('push_api', this.conf.api.push_api);
        }

        console.log(`Chain API URL: ${this.fastify.chain_api}`);
        console.log(`Push API URL: ${this.fastify.push_api}`);

        const ioRedisClient = new Redis(this.manager.conn.redis);
        const api_rate_limit = {
            max: 1000,
            whitelist: ['127.0.0.1'],
            timeWindow: '1 minute',
            redis: ioRedisClient
        };

        if (this.conf.features.streaming.enable) {
            this.activateStreaming();
        }

        registerPlugins(this.fastify, {
            fastify_elasticsearch: {
                client: this.manager.elasticsearchClient
            },
            fastify_oas: generateOpenApiConfig(this.manager.config),
            fastify_rate_limit: api_rate_limit,
            fastify_redis: this.manager.conn.redis,
            fastify_eosjs: this.manager,
        });

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
        this.fastify.addContentTypeParser('*', (req, done) => {
            let data = '';
            req.on('data', chunk => {
                data += chunk;
            });
            req.on('end', () => {
                done(null, data);
            });
            req.on('error', (err) => {
                console.log('---- Content Parsing Error -----');
                console.log(err);
            });
        });
    }

    async init() {

        await this.fetchChainLogo();

        registerRoutes(this.fastify);

        this.fastify.ready().then(async () => {
            await this.fastify.oas();
            console.log(this.chain + ' api ready!');
        }, (err) => {
            console.log('an error happened', err)
        });

        try {
            await this.fastify.listen({
                host: this.conf.api.server_addr,
                port: this.conf.api.server_port
            });
            console.log(`server listening on ${(this.fastify.server.address() as AddressInfo).port}`);
        } catch (err) {
            this.fastify.log.error(err);
            process.exit(1)
        }
    }

    async fetchChainLogo() {
        try {
            if (this.conf.api.chain_logo_url && this.conf.api.enable_explorer) {
                console.log(`Downloading chain logo from ${this.conf.api.chain_logo_url}...`);
                const chainLogo = await got(this.conf.api.chain_logo_url);
                const path = join(__dirname, '..', 'hyperion-explorer', 'dist', 'assets', this.chain + '_logo.png');
                writeFileSync(path, chainLogo.rawBody);
                this.conf.api.chain_logo_url = 'https://' + this.conf.api.server_name + '/v2/explore/assets/' + this.chain + '_logo.png';
            }
        } catch (e) {
            console.log(e);
        }
    }
}

const server = new HyperionApiServer();

server.init().catch(hLog);
