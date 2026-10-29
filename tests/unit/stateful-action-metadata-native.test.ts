import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('native host produces negotiated original authorization and the receiving adapter recaptures it',async()=>{
  const child=Bun.spawn([process.env.HYPERION_NATIVE_NODE??'node',fileURLToPath(new URL('./stateful-action-metadata-native.mjs',import.meta.url))],
    {stdout:'pipe',stderr:'pipe',timeout:60000});
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({exit,error:exit?stderr:undefined}).toEqual({exit:0,error:undefined});
  const result=JSON.parse(stdout);expect(result.actualValidatedOriginalAuthorization).toBe(true);
  expect(result.markedSourcesApplied).toBe(3);expect(result.legacyVariantPreserved).toBe(true);
  expect(result.nativeCandidateRecaptured).toBe(true);expect(result.services).toBe(false);expect(result.physical).toBe(false);
},65000);
