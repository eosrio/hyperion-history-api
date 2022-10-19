import { Telegraf } from 'telegraf';
import * as nodemailer from "nodemailer";
import got from 'got';
import { hLog } from "../helpers/common_functions.js";
export default class AlertsManager {
    opts;
    telegramBot;
    smptTransport;
    chainName;
    ready = false;
    constructor(options) {
        this.opts = options;
        if (this.opts) {
            this.init();
        }
    }
    init() {
        this.ready = true;
        if (this.opts.telegram && this.opts.telegram.enabled) {
            this.telegramBot = new Telegraf(this.opts.telegram.botToken);
        }
        if (this.opts.smtp && this.opts.smtp.enabled) {
            this.smptTransport = nodemailer.createTransport({
                host: this.opts.smtp.smtp,
                port: this.opts.smtp.port,
                secure: this.opts.smtp.tls,
                auth: {
                    user: this.opts.smtp.user,
                    pass: this.opts.smtp.pass
                },
                tls: { rejectUnauthorized: false }
            });
        }
    }
    emitAlert(input) {
        if (this.ready) {
            switch (input.type) {
                case 'fork': {
                    if (this.opts.cases?.alertOnFork) {
                        let msg = 'New fork detected on ${this.chainName}!\n';
                        msg += `From block ${input.content.data.starting_block} to ${input.content.data.starting_block}\n`;
                        msg += `New block id: ${input.content.data.new_id}`;
                        this.sendTelegramMessage(msg).catch(console.log);
                    }
                    break;
                }
                case 'error': {
                    break;
                }
                default: {
                    console.log(input);
                    this.sendTelegramMessage(input.content).catch(console.log);
                }
            }
        }
    }
    async sendTelegramMessage(data) {
        if (this.telegramBot) {
            const message = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
            for (const chatId of this.opts.telegram.destinationIds) {
                try {
                    await this.telegramBot.telegram.sendMessage(chatId, '[' + this.chainName + '] ' + message);
                }
                catch (e) {
                    hLog('Failed to send telegram message!');
                    hLog(e.message);
                }
            }
        }
    }
    async sendEmail(data) {
        if (this.smptTransport) {
            try {
                await this.smptTransport.sendMail({
                    from: this.opts.smtp.sourceEmail,
                    to: this.opts.smtp.destinationEmails,
                    subject: 'Hyperion Alert',
                    html: `Testing`,
                    raw: JSON.stringify(data)
                });
            }
            catch (e) {
                hLog('Failed to send mail!');
                hLog(e.message);
            }
        }
    }
    async sendHttpPost(data) {
        if (this.opts.http && this.opts.http.enabled && this.opts.http.url) {
            try {
                await got.post(this.opts.http.url, {
                    json: data,
                    username: this.opts.http.useAuth ? this.opts.http.user : undefined,
                    password: this.opts.http.useAuth ? this.opts.http.pass : undefined
                }).json();
            }
            catch (e) {
                hLog('Failed to HTTP Post alert!');
                hLog(e.message);
            }
        }
    }
}
