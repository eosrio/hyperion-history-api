// Inert BSON collection/session port only. No MongoClient, database connection, controller,
// timer, worker, process signal or never-settling work. Real adapter/SDK owner methods execute above it.
import assert from 'node:assert/strict';
import {BSON,MongoServerError} from 'mongodb';
const copy=value=>value===null?null:BSON.deserialize(BSON.serialize(value),{promoteLongs:false});
const get=(value,path)=>path.split('.').reduce((v,key)=>v?.[key],value);
const matches=(row,filter)=>Object.entries(filter).every(([key,value])=>value&&typeof value==='object'&&'$nin'in value?!value.$nin.includes(get(row,key)):JSON.stringify(get(row,key))===JSON.stringify(value));
export function ownerPort(){
 let storage=new Map();const indexes=new Map(),calls=[],sessions=[];
 const map=(name,session,write=false)=>{if(session)assert(!session.hasEnded);const state=session?.storage??storage;
  if(write&&!state.has(name))state.set(name,new Map());return state.get(name)??new Map();};
 const collection=name=>({collectionName:name,
  async findOne(filter,options={}){calls.push({command:'findOne',name,filter,options});return copy([...map(name,options.session).values()].find(row=>matches(row,filter))??null);},
  async insertOne(row,options={}){calls.push({command:'insertOne',name,options});const values=map(name,options.session,true);if(values.has(row._id))throw new MongoServerError({code:11000,message:'duplicate'});values.set(row._id,copy(row));return {acknowledged:true,insertedId:row._id};},
  async updateOne(filter,update,options={}){calls.push({command:'updateOne',name,options});const values=map(name,options.session,true),row=[...values.values()].find(value=>matches(value,filter));
   if(!row)return {acknowledged:true,matchedCount:0};values.set(row._id,copy({...row,...update.$set}));return {acknowledged:true,matchedCount:1};},
  async replaceOne(filter,row,options={}){calls.push({command:'replaceOne',name,options});map(name,options.session,true).set(filter._id,copy(row));return {acknowledged:true,matchedCount:1};},
  async deleteOne(filter,options={}){calls.push({command:'deleteOne',name,options});return {acknowledged:true,deletedCount:Number(map(name,options.session).delete(filter._id))};},
  async deleteMany(filter,options={}){calls.push({command:'deleteMany',name,options});const rows=map(name,options.session);for(const [id,row]of rows)if(matches(row,filter))rows.delete(id);return {acknowledged:true};},
  find(filter,options={}){let rows=[...map(name,options.session).values()].filter(row=>matches(row,filter)).map(copy);return {sort(){rows.sort((a,b)=>a._id<b._id?-1:a._id>b._id?1:0);return this;},limit(n){rows=rows.slice(0,n);return this;},async toArray(){return rows;}};},
  async createIndex(key,options){calls.push({command:'createIndex',name,options});const list=indexes.get(name)??[];indexes.set(name,[...list.filter(x=>x.name!==options.name),{key,...options}]);return options.name;},
  listIndexes(){calls.push({command:'listIndexes',name});return {toArray:async()=>indexes.get(name)??[]};},async options(){return {collation:{locale:'simple'}};}
 });
 const client={options:{retryReads:false,retryWrites:false,maxAdaptiveRetries:0},db(){return {
  collection,admin(){return {async command(value){assert.deepEqual(value,{hello:1});return {setName:'inert',isWritablePrimary:true,maxWireVersion:25,logicalSessionTimeoutMinutes:30};}};},
  async createCollection(name,options={}){calls.push({command:'createCollection',name,options});const state=options.session?.storage??storage;
   if(state.has(name))throw new MongoServerError({code:48,message:'namespace exists'});state.set(name,new Map());indexes.set(name,[{name:'_id_',key:{_id:1}}]);return collection(name);}
 };},startSession(){const session={storage:null,hasEnded:false,inTransaction(){return this.storage!==null&&!this.hasEnded;},async withTransaction(work){
  assert(!this.hasEnded);this.storage=new Map([...storage].map(([name,rows])=>[name,new Map([...rows].map(([id,row])=>[id,copy(row)]))]));
  try{const result=await work();storage=this.storage;return result;}finally{this.storage=null;}},async endSession(){this.hasEnded=true;}};sessions.push(session);return session;}};
 return {client,calls,sessions,get storage(){return storage;}};
}
