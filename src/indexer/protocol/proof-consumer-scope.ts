import {AsyncLocalStorage} from 'node:async_hooks';

const contexts = new AsyncLocalStorage<ProofConsumerScope>();
const ends = new WeakMap<object, ProofConsumerScope>();
declare const endBrand: unique symbol;
export interface ProofConsumerEnd {readonly [endBrand]: true}
export class ProofConsumerFencedError extends Error {
    readonly code = 'worker_attempt_fenced';
    constructor() {super('Original worker attempt no longer permits proof use or host effects'); this.name = 'ProofConsumerFencedError';}
}

/** Private local ownership. Counts are diagnostics; only actual promises issue a drained end. */
export class ProofConsumerScope {
    readonly signal: AbortSignal;
    private readonly controller = new AbortController();
    private readonly operations = new Set<Promise<unknown>>();
    private root?: Promise<unknown>;
    private started = false;
    private fenced = false;
    private ending?: Promise<ProofConsumerEnd>;
    private end?: ProofConsumerEnd;
    constructor(readonly id: string, private readonly maximumOperations = 4096) {
        if (typeof id !== 'string' || !id.length || id.length > 256 || !id.isWellFormed()
            || !Number.isSafeInteger(maximumOperations) || maximumOperations < 1 || maximumOperations > 16384)
            throw new Error('Invalid proof consumer scope bounds');
        this.signal = this.controller.signal;
    }
    assertActive(): void {
        if (this.fenced) throw new ProofConsumerFencedError();
        const current = contexts.getStore();
        if (current && current !== this) throw new Error('Proof capability belongs to another worker attempt');
    }
    run<T>(operation: () => T | Promise<T>): Promise<T> {
        this.assertActive();
        if (this.started) throw new Error('Worker attempt root may only run once');
        this.started = true;
        const root = contexts.run(this, async () => operation());
        this.root = root;
        // A supervised caller may stop awaiting before the owned operation physically settles.
        void root.catch(() => {});
        return root;
    }
    operation<T>(operation: () => T | Promise<T>): Promise<T> {
        this.assertActive();
        if (this.operations.size >= this.maximumOperations) throw new Error('Worker attempt operation budget exhausted');
        // Invoke only after ownership/budget admission; retain the real promise, not a cancellation race.
        const underlying = contexts.run(this, async () => operation());
        const tracked = underlying.finally(() => this.operations.delete(tracked));
        this.operations.add(tracked);
        void tracked.catch(() => {});
        return tracked;
    }
    fence(): void {
        if (this.fenced) return;
        this.fenced = true; this.controller.abort(new ProofConsumerFencedError());
    }
    /** Call after the whole root, including original ACK attempt and finalizers. No deadline fabricates drain. */
    closeAndDrain(): Promise<ProofConsumerEnd> {
        if (this.ending) return this.ending;
        this.fence();
        this.ending = (async () => {
            if (this.root) await Promise.allSettled([this.root]);
            while (this.operations.size) await Promise.allSettled([...this.operations]);
            const end = Object.freeze({}) as ProofConsumerEnd;
            ends.set(end, this); this.end = end; return end;
        })();
        return this.ending;
    }
    snapshot() {return Object.freeze({id: this.id, state: this.end ? 'drained' : this.fenced ? 'fenced' : 'open',
        pendingOperations: this.operations.size});}
}
export function currentProofConsumerScope(required = false): ProofConsumerScope | undefined {
    const scope = contexts.getStore();
    if (!scope && required) throw new Error('Managed proof consumption requires an accepted worker attempt');
    scope?.assertActive(); return scope;
}
export function assertProofConsumerCapability(scope: ProofConsumerScope | undefined): void {scope?.assertActive();}
export function proofConsumerSignal(signal?: AbortSignal): AbortSignal | undefined {
    const scope = currentProofConsumerScope();
    return scope ? signal ? AbortSignal.any([signal, scope.signal]) : scope.signal : signal;
}
export function trackProofConsumerOperation<T>(operation: () => T | Promise<T>, scope = currentProofConsumerScope()): Promise<T> {
    return scope ? scope.operation(operation) : Promise.resolve().then(operation);
}
export function assertProofConsumerEnd(scope: ProofConsumerScope, end: ProofConsumerEnd): void {
    if (ends.get(end) !== scope || scope.snapshot().state !== 'drained') throw new Error('Unissued or foreign worker attempt end');
}
