import {hLog} from "../helpers/common_functions.js";
import {Client as UndiciClient, Dispatcher, Headers} from "undici";
import {createTransport} from "nodemailer";
import Mail from "nodemailer/lib/mailer/index.js";
import {Bot} from "grammy";

export interface AlertTriggerOptions {
    enabled: boolean;
    // minimum time between alerts in seconds
    cooldown: number;
    // list of alert providers to emit to
    emitOn: string[];
}

export interface AlertProviderOptions {
    enabled: boolean;
}

export interface SmtpProviderOptions extends AlertProviderOptions {
    sourceEmail: string;
    destinationEmails: string[];
    smtp: string;
    port: number;
    tls: boolean;
    user: string;
    pass: string;
}

export interface HttpProviderOptions extends AlertProviderOptions {
    server: string;
    path: string;
    useAuth: boolean;
    user: string;
    pass: string;
}

export interface TelegramProviderOptions extends AlertProviderOptions {
    destinationIds: number[];
    botToken: string;
}

export type HyperionAlertTypes = 'Fork' | 'IndexerError' | 'IndexerIdle' | 'IndexerResumed' | 'ApiStart' | 'ApiError';

export interface AlertManagerOptions {
    enabled: boolean;
    triggers: Record<HyperionAlertTypes, AlertTriggerOptions>,
    providers: {
        telegram?: TelegramProviderOptions
        email?: SmtpProviderOptions;
        http?: HttpProviderOptions;
    }
}

export class AlertsManager {

    opts: AlertManagerOptions;
    chainName: string;
    ready = false;
    triggers: Record<string, AlertTriggerOptions> = {};

    // Telegram options
    telegramBot?: Bot;
    telegramDestinations: number[] = [];

    // Email options
    smtpTransport?: Mail;
    smtpTransportOptions?: SmtpProviderOptions;

    // Http options
    httpClient?: UndiciClient;
    httpOptions?: HttpProviderOptions;

    constructor(options: AlertManagerOptions, chain: string) {
        this.opts = options;
        this.chainName = chain;
        if (this.opts) {
            this.init();
        }
    }

    private init() {
        this.ready = true;
        if (this.opts.providers) {
            if (this.opts.providers.telegram) {
                hLog('Initializing Telegram Alerts');
                this.initTelegram(this.opts.providers.telegram);
            }
            if (this.opts.providers.email) {
                hLog('Initializing Email Alerts');
                this.initEmail(this.opts.providers.email);
            }
            if (this.opts.providers.http) {
                hLog('Initializing HTTP Alerts');
                this.initHttpClient(this.opts.providers.http);
            }
        }
        this.triggers = this.opts.triggers;
    }

    private initEmail(opts: SmtpProviderOptions) {
        if (!opts.enabled) return;
        this.smtpTransport = createTransport({
            host: opts.smtp,
            port: opts.port,
            secure: opts.tls,
            tls: {
                rejectUnauthorized: false,
                ciphers: 'SSLv3'
            },
            auth: (opts.user && opts.pass) ? {
                user: opts.user,
                pass: opts.pass
            } : undefined,
        });
        this.smtpTransportOptions = opts;
    }

    private initTelegram(opts: TelegramProviderOptions) {
        if (!opts.enabled) return;
        this.telegramBot = new Bot(opts.botToken);
        this.telegramDestinations = opts.destinationIds;
    }

    private initHttpClient(opts: HttpProviderOptions) {
        if (!opts.enabled) return;
        this.httpClient = new UndiciClient(opts.server);
        this.httpOptions = opts;
    }

    // emitAlert(input: AlertOptions) {
    //     if (this.ready) {
    //         switch (input.type) {
    //             case 'fork': {
    //                 if (this.opts.cases?.alertOnFork) {
    //                     let msg = 'New fork detected on ${this.chainName}!\n';
    //                     msg += `From block ${input.content.data.starting_block} to ${input.content.data.starting_block}\n`;
    //                     msg += `New block id: ${input.content.data.new_id}`;
    //                     // this.emitTelegramAlert(msg).catch(console.log);
    //                 }
    //                 break;
    //             }
    //             case 'error': {
    //                 break;
    //             }
    //             default: {
    //                 console.log(input);
    //                 // this.emitTelegramAlert(input.content).catch(console.log);
    //             }
    //         }
    //     }
    // }

    async emitTelegramAlert(event: string, trigger: AlertTriggerOptions, data: any) {
        if (this.telegramBot && this.telegramDestinations) {

            // build message
            let msg: string;

            if (typeof data === 'object') {
                msg = `Chain: ${this.chainName} \\| Event: ${event}\n\`\`\`\n${JSON.stringify(data, null, 2)}\n\`\`\``;
            } else if (typeof data === 'string') {
                msg = '[' + this.chainName + '::' + event + '] ' + data;
            } else {
                return;
            }

            for (const chatId of this.telegramDestinations) {
                try {
                    await this.telegramBot.api.sendMessage(chatId, msg, {parse_mode: "MarkdownV2"});
                } catch (e: any) {
                    hLog('Failed to send telegram message!');
                    hLog(e.message);
                }
            }
        }
    }

    async emitEmailAlert(event: string, trigger: AlertTriggerOptions, data: any) {
        if (this.smtpTransport && this.smtpTransportOptions) {

            let htmlMessage = '';
            let rawMessage = '';

            if (typeof data === 'object') {
                const timestamp = new Date().toISOString();
                htmlMessage += `<strong>${event}</strong> on ${this.chainName} at ${timestamp}<br>`;

                let keyCount = Object.keys(data).length;

                // print message
                if (data.message) {
                    htmlMessage += `<span>${data.message}</span>`;
                    keyCount--;
                }

                // print data
                if (keyCount > 0) {
                    htmlMessage += `<ul>`;
                    for (const key of Object.keys(data)) {
                        if (key !== 'message') {
                            htmlMessage += `<li><strong>${key}: </strong><span>${data[key]}</span></li>`;
                        }
                    }
                    htmlMessage += `</ul>`;
                }

                // print signature
                htmlMessage += `<br><br><span>Message sent from Hyperion internal alerts</span>`;

                // print raw data
                htmlMessage += `<pre>${JSON.stringify(data, null, 2)}</pre>`;

                // raw message
                rawMessage = JSON.stringify(data, null, 2);
            } else if (typeof data === 'string') {
                htmlMessage = `[${this.chainName}::${event}] ${data}`;
                rawMessage = htmlMessage;
            } else {
                return;
            }

            try {
                const result = await this.smtpTransport.sendMail({
                    from: this.smtpTransportOptions.sourceEmail,
                    to: this.smtpTransportOptions.destinationEmails,
                    subject: `Hyperion Alert - ${this.chainName} - ${event}`,
                    html: htmlMessage,
                    text: rawMessage
                });
                hLog('Email sent: ' + result.response);
            } catch (e: any) {
                hLog('Failed to send mail!');
                hLog(e.message);
                hLog(e);
            }
        }
    }

    async emitHttpAlert(event: string, trigger: AlertTriggerOptions, data: any) {
        if (this.httpClient && this.httpOptions) {
            let response: Dispatcher.ResponseData | null = null;
            try {
                const headers = new Headers();
                headers.set('Content-Type', 'application/json');
                if (this.httpOptions.useAuth) {
                    const authBuffer = Buffer.from(this.httpOptions.user + ":" + this.httpOptions.pass);
                    headers.set('Authorization', 'Basic ' + authBuffer.toString('base64'));
                }
                const {path} = this.httpOptions;
                response = await this.httpClient.request({
                    path,
                    method: "POST",
                    headers,
                    body: JSON.stringify({event, data})
                });
                if (response.statusCode !== 200) {
                    hLog('Failed to HTTP Post alert!');
                    hLog(response.statusCode);
                    hLog(await response.body.text());
                }
            } catch (e: any) {
                hLog('Failed to HTTP Post alert!');
                hLog(e);
            }

            if (response) {
                const result = await response.body.text();
                try {
                    const jsonBody = JSON.parse(result);
                    hLog('HTTP Alert Response', jsonBody);
                } catch (_) {
                    hLog(`HTTP Alert Response: ${result}`);
                }
            }
        }
    }

    emit(trigger: string, data: any) {
        const triggerOpts = this.triggers['on' + trigger];
        if (triggerOpts && triggerOpts.enabled) {
            triggerOpts.emitOn.forEach((provider: string) => {
                const providerOpts = this.opts.providers[provider];
                if (providerOpts && providerOpts.enabled) {
                    switch (provider) {
                        case "http": {
                            this.emitHttpAlert(trigger, triggerOpts, data).catch(console.error);
                            break;
                        }
                        case "telegram": {
                            this.emitTelegramAlert(trigger, triggerOpts, data).catch(console.error);
                            break;
                        }
                        case "email": {
                            this.emitEmailAlert(trigger, triggerOpts, data).catch(console.error);
                            break;
                        }
                        default: {
                            console.log('Unknown provider: ' + provider);
                        }
                    }
                }
            });
        }
    }
}
