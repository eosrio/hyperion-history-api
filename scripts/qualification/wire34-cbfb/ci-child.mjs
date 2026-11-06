// Custody helper transplanted from reviewed439267aec16; one owned process, bounded output and closed streams.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
export async function runChild(command, args, {signal, spawnProcess = spawn, deadline = 225_000, grace = 2_000, cap = 1024 * 1024} = {}) {
  if (signal?.aborted) throw new Error('Node fixture aborted before spawn');
  const child = spawnProcess(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', errors = '', bad, closed = false, outEnd = false, errEnd = false;
  let forceTimer, terminalTimer;
  const fail = message => {if (!bad) bad = message; stop();};
  const stop = () => {
    if (closed || forceTimer) return;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      child.kill('SIGKILL');
      terminalTimer = setTimeout(() => {child.stdout?.destroy(); child.stderr?.destroy(); finish({code: null, signal: null, incomplete: true});}, grace);
    }, grace);
  };
  let resolveDone;
  const done = new Promise(resolve => {resolveDone = resolve;});
  let settled = false;
  const finish = result => {if (!settled) {settled = true; resolveDone(result);}};
  const capture = (stream, isOut) => {
    if (!stream) {fail('missing output stream'); return;}
    stream.on('data', chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if ((isOut ? Buffer.byteLength(output) : Buffer.byteLength(errors)) + text.length > cap) {fail('diagnostic output overflow'); return;}
      if (isOut) output += text.toString('utf8'); else errors += text.toString('utf8');
    });
    stream.once('end', () => {if (isOut) outEnd = true; else errEnd = true;});
    stream.once('error', () => fail('diagnostic stream error'));
    stream.once('close', () => {if (!(isOut ? outEnd : errEnd)) fail('diagnostic stream closed before EOF');});
  };
  child.once('error', error => {bad ??= `spawn error: ${error.message}`;});
  child.once('close', (code, childSignal) => {closed = true; finish({code, signal: childSignal});});
  capture(child.stdout, true); capture(child.stderr, false);
  const abort = () => fail('Node fixture aborted');
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  const timer = setTimeout(() => fail('Node fixture deadline exceeded'), deadline);
  try {
    const result = await done;
    assert.ok(!bad, `${bad}\n${output}\n${errors}`);
    assert.ok(!result.incomplete && outEnd && errEnd, `Node fixture streams or process incomplete\n${output}\n${errors}`);
    assert.deepEqual(result, {code: 0, signal: null}, `Node fixture failed\n${output}\n${errors}`);
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(terminalTimer);
    signal?.removeEventListener('abort', abort);
    if (!closed) {child.kill('SIGKILL'); child.stdout?.destroy(); child.stderr?.destroy();}
  }
}
