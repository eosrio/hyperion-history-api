import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export const MONGODB_IMAGE = 'docker.io/library/mongo@sha256:4c7d0fb8fde0681e2ae443b0b09371ec9c31a81caab05af9579458bfcb30d656';
export const MONGODB_VERSION = '8.0.34';
const qualifier = 'portable-projection-mongodb';
const ownerKey = 'io.eosrio.qualifier';
const runKey = 'io.eosrio.run';
const roleKey = 'io.eosrio.role';

export function dockerCommand(args) {
    return execFileSync('docker', args, {encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024}).trim();
}

function absent(error, kind, target) {
    const detail = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
    if (error?.status !== 1) return false;
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [new RegExp(`No such (?:object|${kind}):\\s*${escaped}(?:\\s|$)`, 'i')];
    if (kind === 'network') patterns.push(new RegExp(`network\\s+${escaped}\\s+not found(?:\\s|$)`, 'i'));
    if (kind === 'volume') patterns.push(new RegExp(`${escaped}:\\s*no such volume(?:\\s|$)`, 'i'));
    return patterns.some(pattern => pattern.test(detail));
}

/** A fixed image and exclusively owned, loopback-only resources; never accepts a cluster URL. */
export class OwnedMongoFixture {
    constructor({command = dockerCommand, run = randomUUID().replaceAll('-', '')} = {}) {
        assert.match(run, /^[0-9a-f]{32}$/);
        this.command = command;
        this.run = run;
        this.name = `hyp-projection-${run}`;
        this.replicaSet = `h45rs_${run}`;
        this.network = {name: `${this.name}-net`, id: undefined, reserved: false};
        this.volume = {name: undefined};
        this.containers = new Map();
        this.cleanupResult = {containers: {}, network: false, volume: false, verified: false};
    }

    labels(role) {
        return ['--label', `${ownerKey}=${qualifier}`, '--label', `${runKey}=${this.run}`, '--label', `${roleKey}=${role}`];
    }

    inspect(kind, target) {
        const result = JSON.parse(this.command([kind, 'inspect', target]));
        assert.equal(result.length, 1, `Expected one ${kind} inspection`);
        return result[0];
    }

    inspectOptional(kind, target) {
        try { return this.inspect(kind, target); }
        catch (error) { if (absent(error, kind, target)) return undefined; throw error; }
    }

    owner(value, role) {
        const labels = value.Config?.Labels ?? value.Labels;
        assert.equal(labels?.[ownerKey], qualifier, 'Refusing a resource owned by another qualifier');
        assert.equal(labels?.[runKey], this.run, 'Refusing a resource from another run');
        assert.equal(labels?.[roleKey], role, 'Refusing a resource with another role');
    }

    ownedContainer(role, {optional = false} = {}) {
        const tracked = this.containers.get(role);
        assert.ok(tracked, 'Container role was not reserved by this fixture');
        const value = optional ? this.inspectOptional('container', tracked.id ?? tracked.name)
            : this.inspect('container', tracked.id ?? tracked.name);
        if (value === undefined) return undefined;
        this.owner(value, role);
        assert.equal(value.Name, `/${tracked.name}`, 'Container name changed');
        assert.match(value.Id, /^[0-9a-f]{64}$/);
        if (tracked.id !== undefined) assert.equal(value.Id, tracked.id, 'Container identity changed');
        else tracked.id = value.Id; // Recover a create whose response was lost, only after all ownership checks.
        assert.equal(value.Config.Image, MONGODB_IMAGE);
        if (role === 'replica') {
            const data = value.Mounts.filter(mount => mount.Destination === '/data/db');
            assert.equal(data.length, 1);
            assert.equal(data[0].Type, 'volume');
            assert.equal(data[0].Name, this.volume.name);
        }
        return value;
    }

    ownedNetwork({optional = false} = {}) {
        const value = optional ? this.inspectOptional('network', this.network.id ?? this.network.name)
            : this.inspect('network', this.network.id ?? this.network.name);
        if (value === undefined) return undefined;
        this.owner(value, 'network');
        assert.equal(value.Name, this.network.name);
        assert.match(value.Id, /^[0-9a-f]{64}$/);
        if (this.network.id !== undefined) assert.equal(value.Id, this.network.id);
        else this.network.id = value.Id;
        return value;
    }

    ownedVolume({optional = false} = {}) {
        if (this.volume.name === undefined) return undefined;
        const value = optional ? this.inspectOptional('volume', this.volume.name) : this.inspect('volume', this.volume.name);
        if (value === undefined) return undefined;
        this.owner(value, 'volume');
        assert.equal(value.Name, this.volume.name);
        return value;
    }

    prepare() {
        // Reserve the generated network name before creation so failed startup can still clean it.
        this.network.reserved = true;
        const id = this.command(['network', 'create', '--internal', ...this.labels('network'), this.network.name]);
        assert.match(id, /^[0-9a-f]{64}$/);
        this.network.id = id;
        this.ownedNetwork();
        // Omitting a volume name lets Docker allocate an anonymous name; labels still prove ownership.
        this.volume.reserved = true;
        const volume = this.command(['volume', 'create', ...this.labels('volume')]);
        assert.match(volume, /^[0-9a-f]{64}$/);
        this.volume.name = volume;
        this.ownedVolume();
    }

    start(role) {
        assert.ok(role === 'standalone' || role === 'replica');
        assert.ok(!this.containers.has(role), 'Container role has already been reserved');
        this.ownedNetwork();
        if (role === 'replica') this.ownedVolume();
        const tracked = {name: `${this.name}-${role}`, id: undefined};
        this.containers.set(role, tracked);
        const mounts = role === 'replica' ? ['--mount', `type=volume,src=${this.volume.name},dst=/data/db`]
            : ['--tmpfs', '/data/db:rw,size=268435456'];
        const args = ['container', 'create', '--platform', 'linux/amd64', '--name', tracked.name,
            '--network', this.network.name, ...this.labels(role), '--cpus', '2', '--memory', '1g',
            '--publish', '127.0.0.1::27017', ...mounts, '--tmpfs', '/data/configdb:rw,size=16777216',
            MONGODB_IMAGE, 'mongod', '--bind_ip_all', '--nounixsocket', '--wiredTigerCacheSizeGB', '0.25',
            ...(role === 'replica' ? ['--replSet', this.replicaSet, '--oplogSize', '64', '--setParameter', 'enableTestCommands=1'] : [])];
        const id = this.command(args);
        assert.match(id, /^[0-9a-f]{64}$/);
        tracked.id = id;
        this.ownedContainer(role);
        this.command(['container', 'start', id]);
        return this.endpoint(role);
    }

    endpoint(role) {
        const value = this.ownedContainer(role);
        const ports = value.NetworkSettings.Ports?.['27017/tcp'];
        assert.equal(ports?.length, 1, 'A single loopback port must be published');
        assert.equal(ports[0].HostIp, '127.0.0.1');
        const port = Number(ports[0].HostPort);
        assert.ok(Number.isSafeInteger(port) && port > 1024 && port < 65536);
        return `mongodb://127.0.0.1:${port}/?directConnection=true`;
    }

    execReplica(script) {
        const value = this.ownedContainer('replica');
        return this.command(['container', 'exec', value.Id, 'mongosh', '--quiet', '--eval', script]);
    }

    initializeReplica() {
        const container = this.ownedContainer('replica');
        const config = {_id: this.replicaSet, members: [{_id: 0, host: `${container.Name.slice(1)}:27017`} ]};
        return this.execReplica(`const result=rs.initiate(${JSON.stringify(config)});if(result.ok!==1)throw new Error(JSON.stringify(result));print(JSON.stringify(result));`);
    }

    restart() {
        const before = this.ownedContainer('replica');
        this.ownedVolume();
        this.command(['container', 'restart', '--time', '10', before.Id]);
        const after = this.ownedContainer('replica');
        assert.notEqual(after.State.StartedAt, before.State.StartedAt);
        return {containerId: after.Id, volumeName: this.volume.name, before: before.State.StartedAt, after: after.State.StartedAt};
    }

    removeContainer(role) {
        const value = this.ownedContainer(role, {optional: true});
        if (value !== undefined) {
            this.command(['container', 'rm', '--force', value.Id]);
            assert.equal(this.inspectOptional('container', value.Id), undefined, 'Container survived removal');
        }
        this.cleanupResult.containers[role] = true;
    }

    cleanup() {
        if (this.cleanupPromise) return this.cleanupPromise;
        // Promise allows signal/finally users to share one cleanup without duplicate destructive calls.
        this.cleanupPromise = Promise.resolve().then(() => {
            const errors = [];
            for (const role of [...this.containers.keys()].reverse()) {
                try { this.removeContainer(role); } catch (error) { errors.push(error); }
            }
            try {
                const network = this.network.reserved ? this.ownedNetwork({optional: true}) : undefined;
                if (network !== undefined) {
                    assert.equal(Object.keys(network.Containers ?? {}).length, 0, 'Network still has attached containers');
                    this.command(['network', 'rm', network.Id]);
                    assert.equal(this.inspectOptional('network', network.Id), undefined);
                }
                this.cleanupResult.network = true;
            } catch (error) { errors.push(error); }
            try {
                if (this.volume.reserved && this.volume.name === undefined) {
                    // Creation can succeed while its stdout is lost. Recover only this run's labeled anonymous volume.
                    const found = this.command(['volume', 'ls', '--quiet', '--filter', `label=${ownerKey}=${qualifier}`,
                        '--filter', `label=${runKey}=${this.run}`, '--filter', `label=${roleKey}=volume`]).split(/\r?\n/).filter(Boolean);
                    assert.ok(found.length <= 1, 'More than one volume claims the reserved fixture role');
                    if (found.length) {assert.match(found[0], /^[0-9a-f]{64}$/); this.volume.name = found[0];}
                }
                const volume = this.ownedVolume({optional: true});
                if (volume !== undefined) {
                    this.command(['volume', 'rm', volume.Name]);
                    assert.equal(this.inspectOptional('volume', volume.Name), undefined);
                }
                this.cleanupResult.volume = true;
            } catch (error) { errors.push(error); }
            this.cleanupResult.verified = errors.length === 0;
            if (errors.length) throw new AggregateError(errors, 'Owned MongoDB fixture cleanup did not verify');
            return this.cleanupResult;
        });
        return this.cleanupPromise;
    }
}

export async function waitForMongo(clientFactory, {primary = false, replicaSet, timeoutMS = 60_000} = {}) {
    const deadline = Date.now() + timeoutMS;
    let last;
    while (Date.now() < deadline) {
        const client = clientFactory();
        try {
            await client.connect();
            const hello = await client.db('admin').command({hello: 1});
            if (primary) {
                assert.equal(hello.setName, replicaSet);
                assert.equal(hello.isWritablePrimary, true);
            }
            return client;
        } catch (error) {
            last = error;
            await client.close().catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    throw new Error('Owned MongoDB did not become ready within the fixture deadline', {cause: last});
}
