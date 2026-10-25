/** Resource-free native counterexample against the installed pinned amqplib error dispatch. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {observeWireBrokerChannelEvents} from '../../scripts/qualification/portable-state-broker-recovery.mjs';

assert.equal(process.versions.bun, undefined); assert.match(process.versions.node, /^(24|26)\./);
const require = createRequire(import.meta.url), library = join(dirname(require.resolve('amqplib')), 'lib');
const {Channel} = require(join(library, 'channel.js')), safeEmit = require(join(library, 'safe_emit.js'));
const mode = process.argv[2], channel = new Channel({}), failure = new Error('constructed-owned-broker-channel-error');
assert.ok(['baseline', 'ordinary-listener', 'observed', 'handled'].includes(mode));
const record = (event, value) => {assert.equal(value.kind, 'consumer'); console.log(event);};
if (mode === 'ordinary-listener') channel.once('error', () => console.log('channel-error'));
if (mode === 'observed' || mode === 'handled') observeWireBrokerChannelEvents(channel, 'consumer', record);
let handled = 0;
if (mode === 'handled') channel.on('error', error => {assert.equal(error, failure); handled++;});
safeEmit(channel, 'error', failure);
console.log(JSON.stringify({returnedAfterError: true, handled, originalErrorListeners: channel.listenerCount('error')}));
