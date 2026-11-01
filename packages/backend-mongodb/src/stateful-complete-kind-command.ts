/** Pinned native-driver execution seam; this is not an SDK or plugin query port. */
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import {dirname, relative, isAbsolute} from 'node:path';
import type {ClientSession, Document, MongoClient} from 'mongodb';
import {requireState} from './stateful-contract.js';

interface NativeNamespace {withCollection(name: string): NativeNamespace}
interface NativeOptions {session: ClientSession; signal: AbortSignal; promoteLongs?: boolean; omitMaxTimeMS: true}
const load = createRequire(import.meta.url), packagePath = realpathSync(load.resolve('mongodb/package.json'));
const packageRoot = dirname(packagePath), pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {version?: unknown};
requireState(pkg.version === '7.2.0', 'Complete-kind command executor requires pinned MongoDB driver 7.2.0', 'stateful.capability-unavailable');
const entrypoints = [
    ['mongodb/lib/operations/execute_operation.js', 'c8b5d1c3afa7966da2d9b29feb28e5508cd07005fcdeeac57e5cb289e6fcb800'],
    ['mongodb/lib/operations/run_command.js', 'd0f4800edefcc7505f2ccbdf866ed1725d7b6b202e1d2aa9295c802307c1080a'],
    ['mongodb/lib/utils.js', '8f536c19e104d63ab410a08bb5418c75409c0b11617a12ee8a7b251a6715c2ec'],
] as const;
for (const [specifier, digest] of entrypoints) {
    const path = realpathSync(load.resolve(specifier)), inside = relative(packageRoot, path);
    requireState(inside !== '..' && !inside.startsWith('../') && !inside.startsWith('..\\') && !isAbsolute(inside)
        && createHash('sha256').update(readFileSync(path)).digest('hex') === digest,
    'Complete-kind internal driver entrypoint differs from the qualified source', 'stateful.capability-unavailable');
}
const {executeOperation} = load(entrypoints[0][0]) as {
    executeOperation(client: MongoClient, operation: object): Promise<Document>;
};
const {RunCommandOperation} = load(entrypoints[1][0]) as {
    RunCommandOperation: new(namespace: NativeNamespace, command: Document, options: NativeOptions) => object;
};
const {MongoDBNamespace} = load(entrypoints[2][0]) as {MongoDBNamespace: new(database: string) => NativeNamespace};
requireState(typeof executeOperation === 'function' && typeof RunCommandOperation === 'function' && typeof MongoDBNamespace === 'function',
    'Complete-kind internal driver interface is unavailable', 'stateful.capability-unavailable');

export function executeCompleteKindCommand(client: MongoClient, database: string, command: Document,
    options: {session: ClientSession; signal: AbortSignal; promoteLongs?: boolean}): Promise<Document> {
    // Public Db.command reconstructs an option allowlist and strips omitMaxTimeMS.
    // Use the same pinned operation/session/selection engine without that lossy facade.
    // Its real execution still consumes the client's actual transaction CSOT and signal.
    return executeOperation(client, new RunCommandOperation(new MongoDBNamespace(database), command,
        {session: options.session, signal: options.signal, promoteLongs: options.promoteLongs, omitMaxTimeMS: true}));
}
