import {expect, test} from 'bun:test';
import {RecoveryRunDeadline} from '../../scripts/qualification/portable-state-recovery.ts';

const original = {inputHashes: {'original-source.bin': 'a'.repeat(64)}};

test('a prefix source audit finishing after the inherited deadline starts no profile finalization', async () => {
    let now = 10_000, release!: () => void, finalized = 0, verdict = false;
    const held = new Promise<void>(yes => {release = yes;}), budget = new RecoveryRunDeadline(() => now);
    now = 909_999;
    const work = budget.completePrefix(async () => {await held; return original;}, original, async () => {finalized++;})
        .then(() => {verdict = true;});
    now = 910_001; release();
    await expect(work).rejects.toThrow('deadline');
    expect(finalized).toBe(0); expect(verdict).toBe(false); expect(budget.expiresAt).toBe(910_000);
});

test('a prefix profile readback completing after the original deadline cannot earn a prefix verdict', async () => {
    let now = 0, enter!: () => void, release!: () => void, verdict = false;
    const entered = new Promise<void>(yes => {enter = yes;}), held = new Promise<void>(yes => {release = yes;});
    const budget = new RecoveryRunDeadline(() => now);
    const work = budget.completePrefix(async () => original, original, async () => {enter(); await held;})
        .then(() => {verdict = true;});
    await entered; now = 900_001; release();
    await expect(work).rejects.toThrow('deadline'); expect(verdict).toBe(false);
});

test('an already expired prefix budget starts neither source audit nor profile finalization', async () => {
    let now = 0, audits = 0, finalized = 0;
    const budget = new RecoveryRunDeadline(() => now); now = 900_000;
    await expect(budget.completePrefix(async () => {audits++; return original;}, original,
        async () => {finalized++;})).rejects.toThrow('deadline');
    expect(audits).toBe(0); expect(finalized).toBe(0);
});

test('prefix completion uses the unchanged source and remaining original setup budget', async () => {
    let now = 10_000, finalized = 0;
    const budget = new RecoveryRunDeadline(() => now); now = 909_990;
    await budget.completePrefix(async () => {now += 2; return original;}, original, async after => {
        expect(after.inputHashes).toEqual(original.inputHashes); finalized++; now += 3;
    });
    expect(finalized).toBe(1); expect(now).toBe(909_995); expect(budget.expiresAt).toBe(910_000);
});

for (const boundary of ['phase', 'original-run'] as const) {
    test(`a successful condition settling at the ${boundary} deadline cannot advance recovery`, async () => {
        let now = 10_000, attempts = 0;
        const budget = new RecoveryRunDeadline(() => now, async () => {throw new Error('No retry should follow expiration');});
        // Setup consumes the original budget; a phase must not restart it.
        now += 899_990;
        const duration = boundary === 'phase' ? 5 : 180_000;
        const work = budget.wait('held recovery condition', async () => {attempts++; now += boundary === 'phase' ? 5 : 10;}, () => {}, duration);
        await expect(work).rejects.toThrow('deadline');
        expect(attempts).toBe(1);
        expect(budget.expiresAt).toBe(910_000);
    });
}

test('a final source audit settling at the original run deadline cannot earn success', async () => {
    let now = 10_000, audits = 0, passed = false;
    const budget = new RecoveryRunDeadline(() => now);
    now += 899_990;
    const finalize = async () => {
        await budget.verifyFinalSource(async () => {audits++; now += 10; return original;}, original);
        passed = true;
    };
    await expect(finalize()).rejects.toThrow('deadline');
    expect(passed).toBe(false); expect(audits).toBe(1);
});

test('an exhausted original run budget starts no final source audit', async () => {
    let now = 0, audits = 0;
    const budget = new RecoveryRunDeadline(() => now);
    now = 900_000;
    await expect(budget.verifyFinalSource(async () => {audits++; return original;}, original)).rejects.toThrow('deadline');
    expect(audits).toBe(0);
});

test('in-budget retries and an unchanged final source audit retain their existing meaning', async () => {
    let now = 0, attempts = 0, checks = 0;
    const budget = new RecoveryRunDeadline(() => now, async milliseconds => {now += milliseconds;});
    await budget.wait('eventual recovery condition', async () => {
        now += 5; if (++attempts === 1) throw new Error('Not ready yet');
    }, () => {checks++;});
    await budget.verifyFinalSource(async () => {now += 5; return original;}, original);
    expect(attempts).toBe(2); expect(checks).toBe(2); expect(now).toBe(115);
    await expect(budget.verifyFinalSource(async () => ({inputHashes: {'original-source.bin': 'b'.repeat(64)}}), original)).rejects.toThrow();
});
