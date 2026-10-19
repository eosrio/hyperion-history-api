export interface ReaderBlockPosition {
    num: number;
    id: string;
    previous: string;
}

interface ObservedBlock extends ReaderBlockPosition {
    confirmed: boolean;
}

/** Only confirmed, contiguous irreversible input may move a supervised live reader's resume point. */
export class LiveReaderCheckpoint {
    private readonly blocks = new Map<number, ObservedBlock>();
    private irreversible = 0;
    private anchorId = '';

    constructor(private nextBlock: number, anchorId = '', private readonly maximumBlocks = 100000) {
        if (!Number.isSafeInteger(maximumBlocks) || maximumBlocks < 1) throw new Error('Invalid live reader recovery window');
        this.anchorId = anchorId;
    }

    observe(position: ReaderBlockPosition, irreversible: number): () => {nextBlock: number; blockId: string} | undefined {
        if (position.num < this.nextBlock) {
            throw new Error(`Live source rewound below confirmed irreversible checkpoint ${this.nextBlock}`);
        }
        const existing = this.blocks.get(position.num);
        if (existing && existing.id !== position.id) {
            // A replacement branch invalidates the entire old reversible suffix,
            // including confirmations whose callbacks have not arrived yet.
            for (const num of this.blocks.keys()) if (num >= position.num) this.blocks.delete(num);
        }
        const block = this.blocks.get(position.num) ?? {...position, confirmed: false};
        if (!this.blocks.has(position.num) && this.blocks.size >= this.maximumBlocks) {
            throw new Error(`Live reader recovery window exhausted (${this.maximumBlocks} blocks); checkpoint incomplete`);
        }
        this.blocks.set(position.num, block);
        this.irreversible = Math.max(this.irreversible, irreversible);
        return () => {
            if (this.blocks.get(position.num) !== block) return;
            block.confirmed = true;
            const before = this.nextBlock;
            while (this.nextBlock <= this.irreversible) {
                const next = this.blocks.get(this.nextBlock);
                if (!next?.confirmed) break;
                if (this.anchorId && next.previous !== this.anchorId) {
                    throw new Error(`Unlinked live block ${this.nextBlock} at irreversible checkpoint`);
                }
                this.anchorId = next.id;
                this.blocks.delete(this.nextBlock++);
            }
            if (before !== this.nextBlock) return {nextBlock: this.nextBlock, blockId: this.anchorId};
        };
    }
}

/** Confirm ownership never depends on an AMQP implementation's callback window. */
export class ReaderConfirmRange {
    readonly pending = new Set<object>();
    readonly confirmed = new Set<number>();
    failed = false;

    constructor(readonly first: number, readonly end: number) {}

    accepted(): object {
        const token = {};
        this.pending.add(token);
        return token;
    }

    settle(token: object, num: number, successful: boolean): boolean {
        if (!this.pending.delete(token) || this.failed) return false;
        if (!successful) this.failed = true;
        else this.confirmed.add(num);
        return successful;
    }

    get complete(): boolean {
        if (this.failed || this.pending.size || this.confirmed.size !== this.end - this.first) return false;
        for (let num = this.first; num < this.end; num++) if (!this.confirmed.has(num)) return false;
        return true;
    }
}
