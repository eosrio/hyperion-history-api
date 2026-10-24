/** The selected native qualification runtimes, separate from Bun's checker/test host. */
import assert from 'node:assert/strict';

export const qualificationNodeMajors = Object.freeze([24, 26]);

/** @param {{release: {name: string}, versions: {node: string, bun?: string}}} runtime */
export function assertNativeQualificationRuntime(runtime = process) {
    const major = Number(runtime.versions.node.split('.')[0]);
    assert.ok(runtime.release.name === 'node' && !runtime.versions.bun && qualificationNodeMajors.includes(major),
        'Use native Node.js 24 or 26 for qualification');
    return major;
}
