import {describe, expect, it} from 'bun:test';
import {OwnedMongoFixture, MONGODB_IMAGE} from '../../scripts/qualification/projection-fixture.mjs';

const run = '1'.repeat(32);
function fakeDocker() {
    const objects = {network: new Map<string, any>(), volume: new Map<string, any>(), container: new Map<string, any>()};
    const destroyed: string[][] = [];
    let sequence = 0, failStart = false, loseVolumeResponse = false, loseContainerResponse = false;
    const id = () => String(++sequence).padStart(64, '0');
    const missing = (kind: string, target: string) => Object.assign(new Error(`No such ${kind}: ${target}`), {status: 1, stderr: `No such ${kind}: ${target}`});
    const labels = (args: string[]) => Object.fromEntries(args.flatMap((value, index) => value === '--label'
        ? [args[index + 1].split('=')] : []));
    const command = (args: string[]) => {
        const [kind, action, target] = args;
        const map = objects[kind as keyof typeof objects];
        if (!map) throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
        if (action === 'inspect') {
            const item = [...map.values()].find(value => value.Id === target || value.Name === target || value.Name === `/${target}`);
            if (!item) throw missing(kind, target);
            return JSON.stringify([item]);
        }
        if (action === 'ls' && kind === 'volume') return [...map.keys()].join('\n');
        if (action === 'create') {
            const key = id();
            if (kind === 'network') map.set(key, {Id: key, Name: args.at(-1), Labels: labels(args),
                Internal: args.includes('--internal'), Containers: {}});
            else if (kind === 'volume') {
                map.set(key, {Name: key, Labels: labels(args)});
                if (loseVolumeResponse) throw Object.assign(new Error('Lost create response'), {status: 124});
            } else {
                const name = args[args.indexOf('--name') + 1];
                const mounted = args.indexOf('--mount');
                const volume = mounted < 0 ? undefined : args[mounted + 1].match(/src=([^,]+)/)?.[1];
                map.set(key, {Id: key, Name: `/${name}`, Config: {Image: MONGODB_IMAGE, Labels: labels(args)},
                    HostConfig: {NetworkMode: args[args.indexOf('--network') + 1]}, NetworkSettings: {Ports: {}},
                    Mounts: volume ? [{Destination: '/data/db', Type: 'volume', Name: volume}] : [],
                    State: {StartedAt: 'first'}});
                if (loseContainerResponse) throw Object.assign(new Error('Lost container create response'), {status: 124});
            }
            return key;
        }
        if (action === 'start' && kind === 'container') {
            if (failStart) throw new Error('Injected start failure');
            const item = map.get(target);
            const network = [...objects.network.values()].find(value => value.Name === item.HostConfig.NetworkMode);
            // Actual CI: internal bridges kept the container running but omitted published host ports.
            if (!network.Internal) item.NetworkSettings.Ports['27017/tcp'] = [{HostIp: '127.0.0.1', HostPort: '33001'}];
            return target;
        }
        if (action === 'rm') {
            const selected = args.at(-1)!;
            if (!map.has(selected)) throw missing(kind, selected);
            destroyed.push(args); map.delete(selected);
            return selected;
        }
        throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
    };
    return {objects, destroyed, command, failStart: () => {failStart = true;}, loseVolumeResponse: () => {loseVolumeResponse = true;},
        loseContainerResponse: () => {loseContainerResponse = true;}};
}

describe('owned MongoDB fixture cleanup', () => {
    it('does not contact Docker if no resource creation was attempted', async () => {
        const fixture = new OwnedMongoFixture({command: () => {throw new Error('Unexpected Docker call');}, run});
        expect((await fixture.cleanup()).verified).toBe(true);
    });

    it('removes only exact owned IDs, verifies absence and shares repeated cleanup', async () => {
        const docker = fakeDocker(), fixture = new OwnedMongoFixture({command: docker.command, run});
        fixture.prepare();
        expect(fixture.start('replica')).toBe('mongodb://127.0.0.1:33001/?directConnection=true');
        const result = await fixture.cleanup();
        expect(result).toEqual({containers: {replica: true}, network: true, volume: true, verified: true});
        expect(docker.destroyed.map(args => args.slice(0, 2))).toEqual([['container', 'rm'], ['network', 'rm'], ['volume', 'rm']]);
        expect(await fixture.cleanup()).toBe(result);
        expect(docker.destroyed).toHaveLength(3);
    });

    it('recovers a partial startup and still removes its created container by verified ID', async () => {
        const docker = fakeDocker(), fixture = new OwnedMongoFixture({command: docker.command, run});
        fixture.prepare(); docker.failStart();
        expect(() => fixture.start('replica')).toThrow('Injected start failure');
        expect((await fixture.cleanup()).verified).toBe(true);
        expect(docker.objects.container.size).toBe(0);
        expect(docker.objects.network.size).toBe(0);
        expect(docker.objects.volume.size).toBe(0);
    });

    it('recovers an anonymously named owned volume when the create response was lost', async () => {
        const docker = fakeDocker(), fixture = new OwnedMongoFixture({command: docker.command, run});
        docker.loseVolumeResponse();
        expect(() => fixture.prepare()).toThrow('Lost create response');
        expect((await fixture.cleanup()).verified).toBe(true);
        expect(docker.objects.volume.size).toBe(0);
    });

    it('recovers a container by its exact generated name after its create response was lost', async () => {
        const docker = fakeDocker(), fixture = new OwnedMongoFixture({command: docker.command, run});
        fixture.prepare(); docker.loseContainerResponse();
        expect(() => fixture.start('replica')).toThrow('Lost container create response');
        expect((await fixture.cleanup()).verified).toBe(true);
        expect(docker.objects.container.size).toBe(0);
    });

    it('refuses container destruction if the owner, role, generated name or ID differs', async () => {
        for (const mutate of [
            (item: any) => {item.Config.Labels['io.eosrio.run'] = '2'.repeat(32);},
            (item: any) => {item.Config.Labels['io.eosrio.role'] = 'foreign';},
            (item: any) => {item.Name = '/foreign';},
            (item: any) => {item.Id = '9'.repeat(64);},
        ]) {
            const docker = fakeDocker(), fixture = new OwnedMongoFixture({command: docker.command, run});
            fixture.prepare(); fixture.start('standalone');
            const item = [...docker.objects.container.values()][0]; mutate(item);
            // Simulate lookup by retained Docker ID still yielding changed metadata.
            if (item.Id === '9'.repeat(64)) {
                const original = docker.command;
                fixture.command = (args: string[]) => args[0] === 'container' && args[1] === 'inspect'
                    ? JSON.stringify([item]) : original(args);
            }
            await expect(fixture.cleanup()).rejects.toThrow('cleanup did not verify');
            expect(docker.destroyed.some(args => args[0] === 'container')).toBe(false);
            expect(fixture.cleanupResult.verified).toBe(false);
        }
    });

    it('refuses network and volume destruction when ownership labels change', async () => {
        const docker = fakeDocker(), fixture = new OwnedMongoFixture({command: docker.command, run});
        fixture.prepare();
        [...docker.objects.network.values()][0].Labels['io.eosrio.qualifier'] = 'foreign';
        [...docker.objects.volume.values()][0].Labels['io.eosrio.run'] = '3'.repeat(32);
        await expect(fixture.cleanup()).rejects.toThrow('cleanup did not verify');
        expect(docker.destroyed).toHaveLength(0);
    });

    it('does not treat an unrelated daemon not-found error as verified resource absence', async () => {
        const docker = fakeDocker(), fixture = new OwnedMongoFixture({command: docker.command, run});
        fixture.prepare();
        fixture.command = (args: string[]) => {
            if (args[0] === 'network' && args[1] === 'inspect') {
                throw Object.assign(new Error('Docker endpoint backend not found'), {status: 1});
            }
            return docker.command(args);
        };
        await expect(fixture.cleanup()).rejects.toThrow('cleanup did not verify');
        expect(fixture.cleanupResult.network).toBe(false);
        expect(docker.destroyed.some(args => args[0] === 'network')).toBe(false);
    });
});
