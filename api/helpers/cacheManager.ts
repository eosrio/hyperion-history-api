import {HyperionConfig} from "../../interfaces/hyperionConfig";
import {createHash} from "crypto";
import {FastifyRequest} from "fastify";

export interface CacheConfig {
    ttl: number;
}

export interface CachedEntry {
    data: string;
    exp: number;
}

export class CacheManager {

    v1CacheConfigs: Map<string, CacheConfig> = new Map<string, CacheConfig>();
    v1Caches: Map<string, Map<string, CachedEntry>> = new Map<string, Map<string, CachedEntry>>();

    constructor(conf: HyperionConfig) {
        if (conf.api.v1_chain_cache) {
            conf.api.v1_chain_cache.forEach(value => {
                this.v1CacheConfigs.set(value.path, {
                    ttl: value.ttl
                });
                this.v1Caches.set(value.path, new Map<string, CachedEntry>());
            });
        }
        setInterval(() => {
            try {
                // remove expired entries
                // let removeCount = 0;
                const now = Date.now();
                this.v1Caches.forEach((pathCacheMap: Map<string, CachedEntry>) => {
                    pathCacheMap.forEach((cache: CachedEntry, entryKey: string, map: Map<string, CachedEntry>) => {
                        if (cache.exp < now) {
                            map.delete(entryKey);
                            // removeCount++;
                        }
                    });
                });
                // if (removeCount > 0) {
                //     console.log(`${removeCount} expired cache entries removed`);
                // }
            } catch (e) {
                console.log(e);
            }
        }, 5000);
    }

    hashPayload(input: string): string {
        return createHash('sha256').update(input).digest().toString('hex');
    }

    setCachedData(hash: string, path: string, payload: any): void {
        if (this.v1CacheConfigs.has(path) && this.v1Caches.has(path)) {
            const exp = this.v1CacheConfigs.get(path);
            if (exp && exp.ttl) {
                this.v1Caches.get(path)?.set(hash, {
                    data: payload,
                    exp: exp.ttl + Date.now()
                });
            }
        }
    }

    getCachedData(request: FastifyRequest): [string | null, string, string] {
        const urlParts = request.url.split("?");
        const pathComponents = urlParts[0].split('/');
        const path = pathComponents.at(-1);
        let payload = '';
        if (request.method === 'POST') {
            payload = JSON.stringify(request.body);
        } else if (request.method === 'GET') {
            payload = request.url;
        }
        const hashedString = this.hashPayload(payload);
        if (path && this.v1Caches.has(path)) {
            const entry = this.v1Caches.get(path)?.get(hashedString);
            if (entry && entry.exp > Date.now()) {
                return [entry.data, hashedString, path];
            } else {
                return [null, hashedString, path];
            }
        } else {
            return [null, hashedString, path ?? ''];
        }
    }

}
