/** Bounded, durable fixture evidence shared by the worker and master recovery cases. */
import assert from 'node:assert/strict';
import {closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

export function boundedRecoveryFile(file, maximum) {
    const stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum, 'invalid recovery evidence file');
    const bytes = readFileSync(file); assert.equal(bytes.length, stat.size); return bytes;
}
export function durableRecoveryFile(file, value) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    assert.ok(bytes.length <= 128 * 1024, 'recovery marker exceeds bound');
    const fd = openSync(file, 'wx');
    try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
    if (process.platform !== 'win32') {
        const directory = openSync(dirname(file), 'r');
        try {fsyncSync(directory);} finally {closeSync(directory);}
    }
}
export function createRecoveryRecorder(directory, runId) {
    assert.equal(realpathSync(directory), directory);
    let fd, bytes = 0, sequence = 0;
    return (event, value) => {
        const line = Buffer.from(JSON.stringify({event, ...value, sequence: ++sequence,
            runId, pid: process.pid, parentPid: process.ppid, at: Date.now()}) + '\n');
        bytes += line.length;
        assert.ok(sequence <= 4096 && bytes <= 8 * 1024 * 1024, 'recovery observer budget exceeded');
        fd ??= openSync(join(directory, 'process-' + process.pid + '.jsonl'), 'wx');
        writeFileSync(fd, line); fsyncSync(fd);
    };
}
export function readRecoveryRecords(directory, runId, extraNames) {
    const names = readdirSync(directory);
    assert.ok(names.length <= 66 && names.every(name => extraNames.includes(name)
        || /^process-[1-9][0-9]*\.jsonl$/.test(name)), 'unowned recovery file');
    const events = []; let bytes = 0;
    for (const name of names.filter(name => name.startsWith('process-'))) {
        const contents = boundedRecoveryFile(join(directory, name), 8 * 1024 * 1024); bytes += contents.length;
        assert.ok(bytes <= 64 * 1024 * 1024); assert.equal(contents.at(-1), 10, 'truncated recovery observation');
        const rows = contents.toString().trimEnd().split('\n').map(line => JSON.parse(line));
        assert.ok(rows.length <= 4096);
        for (const [index, row] of rows.entries()) {
            assert.equal(row.sequence, index + 1); assert.equal(row.pid, Number(name.slice(8, -6)));
            assert.equal(row.runId, runId); events.push(row);
        }
    }
    return events;
}
