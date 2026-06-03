import { describe, it, expect } from 'bun:test';
import { resolveHotIndices } from '../../src/api/helpers/hot-index.js';

// Build a minimal fastify-like stub whose elastic.cat.indices is backed by `impl`, counting calls
// so we can assert caching. Each test uses a unique chain so the module-level cache never collides.
function makeFastify(chain: string, impl: () => any) {
    let calls = 0;
    const instance: any = {
        manager: { chain },
        elastic: { cat: { indices: async () => { calls++; return impl(); } } }
    };
    return { instance, getCalls: () => calls };
}

describe('resolveHotIndices', () => {
    it('joins the newest `window` physical indices (already desc-sorted by ES)', async () => {
        const { instance } = makeFastify('chainA', () => [
            { index: 'chainA-action-v1-000003' },
            { index: 'chainA-action-v1-000002' },
            { index: 'chainA-action-v1-000001' }
        ]);
        const res = await resolveHotIndices(instance, 'action', 2);
        expect(res).toBe('chainA-action-v1-000003,chainA-action-v1-000002');
    });

    it('caches the result so repeated polls within the TTL issue one _cat call', async () => {
        const { instance, getCalls } = makeFastify('chainB', () => [{ index: 'chainB-action-v1-000007' }]);
        const a = await resolveHotIndices(instance, 'action', 2);
        const b = await resolveHotIndices(instance, 'action', 2);
        expect(a).toBe('chainB-action-v1-000007');
        expect(b).toBe(a);
        expect(getCalls()).toBe(1);
    });

    it('degrades to the <chain>-action-* wildcard when _cat throws', async () => {
        const { instance } = makeFastify('chainC', () => { throw new Error('es down'); });
        const res = await resolveHotIndices(instance, 'action', 2);
        expect(res).toBe('chainC-action-*');
    });

    it('degrades to the wildcard when no physical index matches yet', async () => {
        const { instance } = makeFastify('chainD', () => []);
        const res = await resolveHotIndices(instance, 'action', 2);
        expect(res).toBe('chainD-action-*');
    });

    it('treats a window < 1 as 1', async () => {
        const { instance } = makeFastify('chainE', () => [
            { index: 'chainE-action-v1-000009' },
            { index: 'chainE-action-v1-000008' }
        ]);
        const res = await resolveHotIndices(instance, 'action', 0);
        expect(res).toBe('chainE-action-v1-000009');
    });
});
