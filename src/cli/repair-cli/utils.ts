import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';

export function askQuestion(query: string): Promise<string> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

export function processResults(chain: string, firstBlock: number, lastBlock: number, args: any, errorRanges: any[], missingBlocks: any[]) {
    if (errorRanges.length > 0 || missingBlocks.length > 0) {
        if (!existsSync('.repair')) {
            mkdirSync('.repair');
        }
    }

    if (errorRanges.length > 0) {
        let path = `.repair/${chain}-${firstBlock + 2}-${lastBlock}-forked-blocks.json`;
        if (args.outFile) {
            path = args.outFile + '-forked-blocks.json';
        }
        console.log(`Run the following command to repair forked blocks: \n\nhyp-repair repair ${chain} ${path}`);
        writeFileSync(path, JSON.stringify(errorRanges));
    }

    if (missingBlocks.length > 0) {
        let path = `.repair/${chain}-${firstBlock + 2
            }-${lastBlock}-missing-blocks.json`;
        if (args.outFile) {
            path = args.outFile + '-missing-blocks.json';
        }
        console.log(`Run the following command to repair missing blocks: \n\nhyp-repair fill-missing ${chain} ${path}`);
        writeFileSync(path, JSON.stringify(missingBlocks));
    }
}

export function preprocessRanges(ranges: any[], batchSize: number) {
    const preprocessedFile: { start: number, end: number, count: number }[] = [];
    for (const range of ranges) {
        const rangeCount = range.count || (range.end - range.start + 1);
        if (rangeCount > batchSize) {
            let currentStart = range.start;
            while (currentStart <= range.end) {
                const endBlock = Math.min(currentStart + batchSize - 1, range.end);
                preprocessedFile.push({
                    start: currentStart,
                    end: endBlock,
                    count: endBlock - currentStart + 1
                });
                currentStart = endBlock + 1;
            }
        } else {
            preprocessedFile.push({
                ...range,
                count: rangeCount
            });
        }
    }
    return preprocessedFile;
}

export function viewFile(file: string) {
    const data = readFileSync(file, 'utf8');
    const parsed = JSON.parse(data);
    console.table(parsed);
}

export function printHeader() {
    console.log(`
   __                             _                                            _              __              __
  / /   __ __   ___  ___   ____  (_) ___   ___        ____ ___    ___  ___ _  (_)  ____      / /_ ___  ___   / /
 / _ \\ / // /  / _ \\/ -_) / __/ / / / _ \\ / _ \\      / __// -_)  / _ \\/ _ \`/ / /  / __/     / __// _ \\/ _ \\ / / 
/_//_/ \\_, /  / .__/\\__/ /_/   /_/  \\___//_//_/     /_/   \\__/  / .__/\\_,_/ /_/  /_/        \\__/ \\___/\\___//_/  
      /___/  /_/                                               /_/                                              
`);
}

export async function connectToHyperion(args: { host?: string }) {
    let hyperionIndexer = 'ws://localhost:4321';
    let valid = false;
    if (args.host) {
        hyperionIndexer = args.host;
    }
    try {
        const controller = new WebSocket(hyperionIndexer + '/local');
        controller.on('open', () => {
            valid = true;
            controller.close();
        });
        controller.on('close', () => {
            if (valid) {
                console.log(
                    `✅  Hyperion Indexer Online - ${hyperionIndexer}`
                );
            }
        });
        controller.on('error', (err) => {
            console.log('Error:', err.message);
            console.log(
                `Failed to connect on Hyperion Indexer at ${hyperionIndexer}, please use "--host ws://ADDRESS:PORT" to specify a remote indexer connection`
            );
        });
    } catch (e) {
        console.log(e);
    }
}
