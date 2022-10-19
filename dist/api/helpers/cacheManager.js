import { createHash } from "crypto";
export class CacheManager {
    v1CacheConfigs = new Map();
    v1Caches = new Map();
    constructor(conf) {
        if (conf.api.v1_chain_cache) {
            conf.api.v1_chain_cache.forEach(value => {
                this.v1CacheConfigs.set(value.path, {
                    ttl: value.ttl
                });
                this.v1Caches.set(value.path, new Map());
            });
        }
        setInterval(() => {
            try {
                // remove expired entries
                let removeCount = 0;
                const now = Date.now();
                this.v1Caches.forEach((pathCacheMap, pathKey) => {
                    pathCacheMap.forEach((cache, entryKey, map) => {
                        if (cache.exp < now) {
                            map.delete(entryKey);
                            removeCount++;
                        }
                    });
                });
                if (removeCount > 0) {
                    console.log(`${removeCount} expired cache entries removed`);
                }
            }
            catch (e) {
                console.log(e);
            }
        }, 5000);
    }
    hashPayload(input) {
        return createHash('sha256').update(input).digest().toString('hex');
    }
    setCachedData(hash, path, payload) {
        if (this.v1CacheConfigs.has(path) && this.v1Caches.has(path)) {
            const ttl = this.v1CacheConfigs.get(path)?.ttl;
            if (ttl) {
                this.v1Caches.get(path)?.set(hash, {
                    data: payload,
                    exp: ttl + Date.now()
                });
            }
        }
    }
    getCachedData(request) {
        const urlParts = request.url.split("?");
        const pathComponents = urlParts[0].split('/');
        const path = pathComponents.at(-1);
        let payload = '';
        if (request.method === 'POST') {
            payload = JSON.stringify(request.body);
        }
        else if (request.method === 'GET') {
            payload = request.url;
        }
        const hashedString = this.hashPayload(payload);
        if (this.v1Caches.has(path)) {
            const entry = this.v1Caches.get(path)?.get(hashedString);
            if (entry && entry.exp > Date.now()) {
                return [entry.data, hashedString, path];
            }
            else {
                return [null, hashedString, path];
            }
        }
        else {
            return [null, hashedString, path];
        }
    }
}
