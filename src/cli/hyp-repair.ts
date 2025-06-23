import { Command } from 'commander';
import { scanChain, quickScanChain, scanActions } from './repair-cli/scan.js';
import { repairChain, repairMissing } from './repair-cli/repair.js';
import { monitorBlockQueues } from './repair-cli/monitor.js';
import { viewFile, connectToHyperion } from './repair-cli/utils.js';

const program = new Command();

// Commander Logic

program
    .name('Hyperion Repair CLI')
    .description('CLI to find and repair forked and missing blocks on Hyperion')
    .version('0.2.2');

program
    .command('scan <chain>')
    .description('scan for missing and forked blocks')
    .option('-o, --out-file <file>', 'forked-blocks.json output file')
    .option('-f, --first <number>', 'initial block to start validation')
    .option('-l, --last <number>', 'last block to validate')
    .option('-b, --batch <number>', 'batch size to process')
    .action(scanChain);

program
    .command('quick-scan <chain>')
    .description('scan for missing blocks using binary tree search')
    .action(quickScanChain);

program
    .command('scan-actions <chain>')
    .description('scan for missing actions using binary tree search and action validation')
    .option('-f, --first <number>', 'initial block to start validation')
    .option('-l, --last <number>', 'last block to validate')
    .option('-o, --out-file <file>', 'missing-actions.json output file')
    .option('-m, --min-range-size <number>', 'minimum range size to continue binary search (default: 1, stops subdividing ranges when they reach this size)', '1')
    .option('-v, --verbose', 'enable verbose logging (shows details for all ranges)')
    .action(scanActions);

program
    .command('repair <chain> <file>')
    .description('repair forked blocks')
    .option('-h, --host <host>', 'Hyperion local control api')
    .option('-d, --dry', 'dry-run, do not delete or repair blocks')
    .option('-t, --check-tasks', 'check for running tasks')
    .action(repairChain);

program
    .command('fill-missing <chain> <file>')
    .description('write missing blocks')
    .option('-h, --host <host>', 'Hyperion local control api')
    .option('-d, --dry', 'dry-run, do not delete or repair blocks')
    .action(repairMissing);

program
    .command('view <file>')
    .description('view forked blocks')
    .action(viewFile);

program
    .command('monitor-queues <chain>')
    .description('Monitor block processing queues for a chain')
    .action(monitorBlockQueues);

program
    .command('connect')
    .description('Test connection to Hyperion Indexer')
    .option('-h, --host <host>', 'Hyperion local control api')
    .action(connectToHyperion);

program.parse();
