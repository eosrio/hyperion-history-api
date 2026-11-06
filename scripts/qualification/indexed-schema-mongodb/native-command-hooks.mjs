// Socket-free wrapper construction; native runner supplies the actual already-connected owned client.
import assert from 'node:assert/strict';
export function installIndexedCommandHooks(client,database,namespaces,{beforeData,afterData,afterTransaction,beforeSidecarInsert,beforeSnapshot}){
 const topology=client.topology;assert.equal(typeof topology?.selectServer,'function');assert(namespaces instanceof Map);
 const sessions=new WeakSet(),restores=new Map();let active=true;const select=topology.selectServer;
 const replace=(target,name,wrapper)=>{const old=Object.getOwnPropertyDescriptor(target,name);Object.defineProperty(target,name,{configurable:true,writable:true,value:wrapper});
  return()=>{if(target[name]!==wrapper)return;if(old)Object.defineProperty(target,name,old);else delete target[name];};};
 const restoreSelect=replace(topology,'selectServer',async function(...args){const server=await Reflect.apply(select,this,args);
  if(!active||this!==topology)return server;assert.equal(server.topology,topology);
  if(!restores.has(server)){const command=server.command;restores.set(server,replace(server,'command',async function(...args){
   const [operation]=args,session=operation?.session,input=operation?.commandName==='runCommand'?operation.command:undefined;
   const owned=active&&this===server&&client.topology===topology&&session?.client===client;
   const collection=input?.aggregate??input?.collection;
   const data=owned&&operation.ns?.db===database&&namespaces.has(collection)&&input?.comment?.hyperion==='stateful-indexed-v1'
    &&namespaces.get(collection)===input.comment.model&&(input.aggregate!==undefined||input.getMore!==undefined);
   if(data){sessions.add(session);await beforeData?.(input,session);assert.equal(operation.session,session);assert.equal(operation.command,input);}
   if(owned&&operation.ns?.db===database&&namespaces.has(operation.ns?.collection)&&operation.commandName==='insert')await beforeSidecarInsert?.(operation,session);
   if(owned&&operation.ns?.db===database&&operation.ns?.collection?.endsWith('_stateful_v2_metadata')&&operation.commandName==='find'&&session.inTransaction())await beforeSnapshot?.(operation,session);
   const response=await Reflect.apply(command,this,args);
   if(data)await afterData?.(input,response,session);
   if(owned&&input?.commitTransaction!==undefined&&sessions.has(session))await afterTransaction?.(input,response,session);
   return response;
  }));}return server;
 });
 return()=>{if(!active)return;active=false;restoreSelect();for(const restore of restores.values())restore();restores.clear();};
}
