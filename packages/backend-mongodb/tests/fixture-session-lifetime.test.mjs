/** Controlled driver lifetime only. No source/owner/serving authority is produced here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseFixture} from './fixture.mjs';

test('ended audited sessions release obsolete snapshots while committed state and audit identity remain',async()=>{
    const fixture=databaseFixture(),db=fixture.client.db();await db.createCollection('lifetime');
    const collection=db.collection('lifetime'),ended=[];
    for(let n=0;n<32;n++) {
        const session=fixture.client.startSession();ended.push(session);
        try {await session.withTransaction(()=>collection.replaceOne({_id:'one'},{_id:'one',value:n},{session}));}
        finally {await session.endSession();}
    }
    assert.equal((await collection.findOne({_id:'one'})).value,31);
    const retained=new Set(fixture.native.map(row=>row.options?.session).filter(Boolean));
    assert.equal(retained.size,32);assert.deepEqual(retained,new Set(ended));
    assert.ok([...retained].every(session=>session.storage===null),'Audit identities must not retain ended transaction database snapshots');
});
test('closed sessions cannot read, write, create another transaction or fall back to global state',async()=>{
    const fixture=databaseFixture(),db=fixture.client.db();await db.createCollection('lifetime');
    const collection=db.collection('lifetime'),session=fixture.client.startSession();
    await session.withTransaction(()=>collection.insertOne({_id:'one',value:1},{session}));await session.endSession();
    await assert.rejects(collection.findOne({_id:'one'},{session}),/session.*ended/i);
    await assert.rejects(collection.replaceOne({_id:'one'},{_id:'one',value:2},{session}),/session.*ended/i);
    await assert.rejects(session.withTransaction(()=>{}),/session.*ended/i);
    assert.equal((await collection.findOne({_id:'one'})).value,1);
});
test('ending an in-flight transaction cannot later publish its discarded snapshot',async()=>{
    const fixture=databaseFixture(),db=fixture.client.db();await db.createCollection('lifetime');
    const collection=db.collection('lifetime'),session=fixture.client.startSession();
    let release,announce;const held=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{announce=resolve;});
    const pending=session.withTransaction(async()=>{await collection.insertOne({_id:'late',value:1},{session});announce();await held;});
    await entered;await session.endSession();release();
    await assert.rejects(pending,/session.*ended/i);
    assert.equal(await collection.findOne({_id:'late'}),null);assert.equal(session.storage,null);
});
test('failed and unknown acknowledgments keep their original before/after commit semantics after session cleanup',async()=>{
    for(const fault of ['before','after']) {
        const fixture=databaseFixture(),db=fixture.client.db();await db.createCollection('lifetime');
        const collection=db.collection('lifetime'),session=fixture.client.startSession();fixture.failTransaction=fault;
        try {await assert.rejects(session.withTransaction(()=>collection.insertOne({_id:'one',value:1},{session})),/injected/);}
        finally {await session.endSession();}
        assert.equal((await collection.findOne({_id:'one'}))?.value??null,fault==='before'?null:1);
        assert.equal(session.storage,null);
    }
});
