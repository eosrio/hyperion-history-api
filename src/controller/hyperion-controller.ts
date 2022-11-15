import {existsSync, PathLike, readFileSync} from "fs";
import {writeFileSync} from "node:fs";
import {App} from "uWebSockets.js";
import {Server} from "socket.io";
import {fastify} from "fastify";

interface HyperionControllerConfig {
    ports: {
        http: number,
        ws: number,
    },
    host: string,
    serveWebUI: boolean
}

const defaultControllerConfig: HyperionControllerConfig = {
    ports: {
        http: 16777,
        ws: 16778,
    },
    host: '127.0.0.1',
    serveWebUI: true
};

export class HyperionController {

    private server = fastify();
    private uwsApp = App();
    private io = new Server({
        cors: {
            origin: 'http://localhost:4200'
        }
    });
    private config!: HyperionControllerConfig;

    constructor() {
        this.io.attachApp(this.uwsApp);
    }

    async start() {
        await this.createSocketServer();
        await this.createWebServer();
    }

    importConfig(configPath: PathLike) {
        if (!existsSync(configPath)) {
            console.log(`No config found, creating new at: ${configPath}`);
            this.createDefaultConfig(configPath);
            this.config = defaultControllerConfig;
        } else {
            this.config = JSON.parse(readFileSync(configPath).toString()) as HyperionControllerConfig;
        }
        this.assertConfig();
        console.log(this.config);
    }

    private createDefaultConfig(configPath: PathLike) {
        writeFileSync(configPath, JSON.stringify(defaultControllerConfig, null, 2));
    }

    private async createSocketServer() {
        this.io.on('connection', args => {
            console.log(args);
        });
        await new Promise<void>((resolve, reject) => {
            this.uwsApp.listen(this.config.host, this.config.ports.ws, listenSocket => {
                if (listenSocket) {
                    console.log(`WS Server started on port: ${this.config.ports.ws}`);
                    resolve();
                } else {
                    reject();
                }
            });
        });
    }

    private async createWebServer() {
        this.server.get('/', (request, reply) => {
            reply.send('serve static here');
        });
        try {
            await this.server.listen({
                port: this.config.ports.http,
                host: this.config.host
            });
            console.log(`HTTP Server started on port: ${this.config.ports.http}`);
        } catch (err) {
            console.log(err);
            process.exit(1)
        }

    }

    private assertConfig() {
        if (!this.config.ports) {
            this.config.ports = defaultControllerConfig.ports;
        } else {
            if (!this.config.ports.http) {
                this.config.ports.http = defaultControllerConfig.ports.http;
            }
            if (!this.config.ports.ws) {
                this.config.ports.ws = defaultControllerConfig.ports.ws;
            }
        }
        if (!this.config.host) {
            this.config.host = defaultControllerConfig.host;
        }
    }
}
