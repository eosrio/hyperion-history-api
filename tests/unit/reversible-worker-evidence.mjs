/** Lossless bounded evidence: repeated opaque journal/IPC strings are stored once. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
export function encodeWorkerEvidence(snapshot) {
    const strings = new Map(), references = [];
    function visit(value, path) {
        if (typeof value === 'string' && Buffer.byteLength(value) >= 1024) {
            const bytes = Buffer.byteLength(value), id = digest(value), previous = strings.get(id);
            if (previous) assert.equal(previous.value, value, 'Evidence text digest collision');
            else strings.set(id, {id, bytes, value});
            references.push({path, id}); return null;
        }
        if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, index]));
        if (value && typeof value === 'object') {
            const result = Object.create(null);
            for (const [key, entry] of Object.entries(value)) if (entry !== undefined)
                result[key] = visit(entry, [...path, key]);
            return result;
        }
        return value;
    }
    const data = visit(snapshot, []);
    const at = (value, path) => path.reduce((node, key) => {
        assert(node && Object.hasOwn(node, key), 'Evidence reference leaves its original structure');
        return node[key];
    }, value);
    for (const {path, id} of references) {
        assert.equal(at(data, path), null);
        assert.equal(at(snapshot, path), strings.get(id).value);
    }
    const envelope = {schemaVersion: 2, encoding: 'interned-json-strings-v1', data,
        strings: [...strings.values()], references};
    const bytes = Buffer.from(JSON.stringify(envelope));
    assert(bytes.length <= 64 * 1024 * 1024, 'Native component evidence exceeds its bounded snapshot budget');
    return {bytes, strings: strings.size, references: references.length};
}
