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
import {createWriteStream, existsSync, mkdirSync} from "fs";
import {SocketManager} from "./socketManager";

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
            ignoreTrailingSlash: false, trustProxy: true, logger: this.conf.api.access_log ? {
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

        registerRoutes(this.fastify);

        this.addGenericTypeParsing();

        this.fastify.ready().then(async () => {
            await this.fastify.oas();
            console.log(this.chain + ' api ready!');
        }, (err) => {
            console.log('an error happened', err)
        });
    }

    activateStreaming() {
        console.log('Importing stream module');
        import('./socketManager').then((mod) => {
            const connOpts = this.manager.conn.chains[this.chain];
            this.socketManager = new mod.SocketManager(
                this.fastify,
                `http://${connOpts['WS_ROUTER_HOST']}:${connOpts['WS_ROUTER_PORT']}`,
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
}

const server = new HyperionApiServer();

server.init().catch(hLog);
