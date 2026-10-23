import {
    PROJECTION_LIMITS, ProjectionContractError, type ProjectionBinding, type ProjectionQuery,
    type ProjectionQueryResult, type ProjectionReadView,
} from '@eosrio/hyperion-sdk/projection';
import {
    ReadConcern, WriteConcern, type ClientSession, type Collection, type Db, type Document, type Filter, type MongoClient,
} from 'mongodb';
import { hash, MAX_RECEIPTS, slot, snapshot, stableJson, type StoredRecord } from './contract.js';

export interface MongoDbProjectionAdapterOptions {
    /** Caller-owned client; this adapter never closes it. */
    readonly client: MongoClient;
    readonly databaseName: string;
    readonly backendId: string;
    readonly collectionPrefix?: string;
    readonly receiptRetention?: number;
    readonly operationTimeoutMS?: number;
    readonly transactionTimeoutMS?: number;
}

export function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
        throw new ProjectionContractError('projection.invalid-contract', `${name} must be an integer between 1 and ${maximum}`);
    }
    return selected;
}

export function serverErrorCode(error: unknown, code: number): boolean {
    // The caller-owned client may load a different physical copy of the driver.
    return typeof error === 'object' && error !== null &&
        (error as { name?: unknown }).name === 'MongoServerError' &&
        (error as { code?: unknown }).code === code;
}

/** Shared native infrastructure; public projection interfaces do not expose these operations. */
export class MongoProjectionStorage<M extends Document> {
    protected readonly client: MongoClient;
    protected readonly database: Db;
    protected readonly backendId: string;
    protected readonly prefix: string;
    protected readonly metadata: Collection<M>;
    protected readonly receiptRetention: number;
    protected readonly operationTimeoutMS: number;
    protected readonly transactionTimeoutMS: number;
    protected readonly writeConcern = new WriteConcern('majority', undefined, true);

    constructor(options: MongoDbProjectionAdapterOptions,
        private readonly validate: (input: unknown, binding: ProjectionBinding) => M) {
        if (!options || !options.client || typeof options.databaseName !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,48}$/.test(options.databaseName) ||
            typeof options.backendId !== 'string' || options.backendId.length === 0 ||
            Buffer.byteLength(options.backendId) > 256) {
            throw new ProjectionContractError('projection.invalid-contract', 'A client, bounded database name and backend identity are required');
        }
        this.prefix = options.collectionPrefix ?? 'h45_projection';
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(this.prefix)) {
            throw new ProjectionContractError('projection.invalid-contract', 'Collection prefix must use 1 to 32 lowercase identifier characters');
        }
        this.client = options.client;
        this.database = this.client.db(options.databaseName, { readPreference: 'primary', readConcern: new ReadConcern('majority') });
        this.backendId = options.backendId;
        this.receiptRetention = boundedInteger(options.receiptRetention, 256, MAX_RECEIPTS, 'receiptRetention');
        this.operationTimeoutMS = boundedInteger(options.operationTimeoutMS, 5000, 30000, 'operationTimeoutMS');
        this.transactionTimeoutMS = boundedInteger(options.transactionTimeoutMS, 15000, 60000, 'transactionTimeoutMS');
        this.metadata = this.database.collection<M>(`${this.prefix}_metadata`);
    }

    protected records(binding: ProjectionBinding): Collection<StoredRecord> {
        return this.database.collection<StoredRecord>(`${this.prefix}_r_${hash(binding)}`);
    }

    protected async load(binding: ProjectionBinding, session?: ClientSession): Promise<M> {
        const options = session ? { session } : { timeoutMS: this.operationTimeoutMS, readPreference: 'primary' as const, readConcern: { level: 'majority' as const } };
        const metadata = await this.metadata.findOne({ _id: slot(binding) } as Filter<M>, options);
        if (metadata === null) {
            throw new ProjectionContractError('projection.not-initialized', 'Projection storage has not been initialized');
        }
        return this.validate(metadata, binding);
    }

    protected async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
        const session = this.client.startSession({ causalConsistency: false });
        try {
            return await session.withTransaction(() => operation(session), {
                readConcern: { level: 'snapshot' }, writeConcern: this.writeConcern, readPreference: 'primary',
                timeoutMS: this.transactionTimeoutMS, maxCommitTimeMS: this.operationTimeoutMS,
            });
        } finally {
            await session.endSession();
        }
    }

    protected async guarded<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (error instanceof ProjectionContractError) throw error;
            const unavailable = new ProjectionContractError('projection.apply-unavailable', 'MongoDB projection operation did not complete; retry the same source or request');
            unavailable.cause = error;
            throw unavailable;
        }
    }

    protected async assertTopology(): Promise<void> {
        const hello = await this.database.admin().command({ hello: 1 }, { timeoutMS: this.operationTimeoutMS, readPreference: 'primary' });
        const replicaSet = typeof hello.setName === 'string' && hello.setName.length > 0 && hello.isWritablePrimary === true;
        const sharded = hello.msg === 'isdbgrid';
        if ((!replicaSet && !sharded) || !Number.isFinite(hello.logicalSessionTimeoutMinutes) ||
            hello.logicalSessionTimeoutMinutes <= 0 || !Number.isSafeInteger(hello.maxWireVersion) ||
            hello.maxWireVersion < (sharded ? 8 : 7)) {
            throw new ProjectionContractError('projection.capability-unavailable', 'Portable MongoDB projections require an initialized transaction-capable replica set or sharded cluster');
        }
    }

    protected async queryRecords<V extends ProjectionReadView>(view: V, query: ProjectionQuery,
        session: ClientSession): Promise<ProjectionQueryResult & { view: V }> {
        const filter: Document = {};
        for (const term of query.filter) {
            // SDK field identifiers are single safe path segments, validated above.
            const name = `value.${term.field}`;
            // An explicit $eq keeps values from being interpreted as operators.
            const predicate = { [name]: { $eq: term.value } };
            (filter.$and ??= []).push(predicate);
        }
        const pageFilter = query.afterKey === undefined ? filter : { $and: [filter, { _id: { $gt: query.afterKey } }] };
        const records = this.records(view.binding);
        const cursor = records.find(pageFilter, {
            session, collation: { locale: 'simple' }, projection: { _id: 1, value: 1 },
            batchSize: Math.min(query.limit + 1, 16),
        })
            .sort({ _id: 1 }).limit(query.limit + 1);
        const rows: { key: string; value: StoredRecord['value'] }[] = [];
        // Reserve the response envelope and the largest escaped cursor/count suffix.
        const rowBudget = PROJECTION_LIMITS.queryBytes - Buffer.byteLength(stableJson({ view, rows: [] })) -
            PROJECTION_LIMITS.keyBytes * 6 - 128;
        let bytes = 0;
        let more = false;
        try {
            for await (const record of cursor) {
                const row = { key: record._id, value: snapshot(record.value) };
                const added = Buffer.byteLength(stableJson(row)) + (rows.length > 0 ? 1 : 0);
                if (rows.length >= query.limit || bytes + added > rowBudget) {
                    if (rows.length === 0) {
                        throw new ProjectionContractError('projection.incomplete', 'Stored projection record exceeds the portable response budget');
                    }
                    more = true;
                    break;
                }
                rows.push(row);
                bytes += added;
            }
        } finally {
            await cursor.close();
        }
        const response: ProjectionQueryResult & { view: V } = {
            view: snapshot(view), rows,
            ...(more ? { nextAfterKey: rows[rows.length - 1].key } : {}),
        };
        if (query.count) {
            const counted = await records.countDocuments(filter, { session, collation: { locale: 'simple' }, limit: query.count.upTo + 1 });
            return { ...response, count: { value: Math.min(counted, query.count.upTo), exact: counted <= query.count.upTo } };
        }
        return response;
    }
}
