import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';

const maximumBytes = 64 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function restartDirectory(value) {
    assert.equal(typeof value, 'string');
    const directory = resolve(value);
    assert.equal(dirname(directory), realpathSync(tmpdir()));
    assert.match(basename(directory), /^hyperion-attempt-restart-[A-Za-z0-9_-]+$/);
    assert(lstatSync(directory).isDirectory());
    assert.equal(realpathSync(directory), directory);
    return directory;
}

/** Test storage survives an actual parent kill. It is not a live ES/broker durability claim. */
export function persistRestartSnapshot(directory, snapshot, end, epoch) {
    const file = join(restartDirectory(directory), 'retained.json');
    const value = {schemaVersion: 1, oldParent: {pid: process.pid, epoch}, snapshot, end};
    const bytes = Buffer.from(JSON.stringify(value));
    assert(bytes.length > 0 && bytes.length <= maximumBytes);
    const fd = openSync(file, 'wx');
    try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
    return {file, bytes: bytes.length, sha256: sha256(bytes)};
}

export function readRestartSnapshot(directory, expected) {
    const file = join(restartDirectory(directory), 'retained.json');
    const stat = lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert(stat.size > 0 && stat.size <= maximumBytes && stat.size === expected.bytes);
    const bytes = readFileSync(file);
    assert.equal(sha256(bytes), expected.sha256);
    const value = JSON.parse(bytes.toString());
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.oldParent.epoch, value.end.epoch);
    assert.equal(value.end.status, 'quiescent');
    assert.equal(value.end.rootResult, 'returned');
    assert.equal(value.end.acknowledgementAttempted, true);
    assert.equal(value.end.freshWrites.length, 1);
    assert.equal(value.snapshot.recordId, value.end.freshWrites[0].id);
    assert.equal(value.snapshot.originalAckCount, 1);
    return value;
}
