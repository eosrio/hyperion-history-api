export class TelegramLightClient {
    telegramApiUrl: string = "https://api.telegram.org/bot";
    private readonly botToken: string;

    constructor(botToken: string) {
        this.botToken = botToken;
    }

    public async sendMessage(chatId: number, text: string) {
        if (!chatId) {
            throw new Error("chatId is required");
        }
        if (!text) {
            throw new Error("text is required");
        }
        if (text.length > 4096) {
            throw new Error("text is too long");
        }
        const url = `${this.telegramApiUrl}${this.botToken}/sendMessage`;
        const response = await fetch(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: "MarkdownV2",
                link_preview_options: {
                    is_disabled: true
                }
            })
        });
        return await response.json();
    }

    parseMarkdownV2(text: string): string {
        return text.replace(/[_[\]()~`>#+\-=|{}.!]/g, '\\$&');
    }
}
