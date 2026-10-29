const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSiteOperations}=require('../src/lib/site-operations');
const {beginVpsSiteOperation}=require('../src/lib/vps-site-operations');
function setup({active=true,owner='owner',holds=[],siteError=null,holdError=null}={}){
 const reads=[];
 const client={from(table){const query={select(){reads.push(table);return query;},eq(){return query;},is(){return query;},single:async()=>({data:{id:'site',user_id:owner,active},error:siteError}),then(resolve,reject){return Promise.resolve({data:holds,error:holdError}).then(resolve,reject);}};return query;}};
 const ops=createSiteOperations(client,{reservationsEnabled:false,request:async()=>{throw Error('Normal publishing must not call the Aspy endpoint');}});
 return{ops,reads};
}
test('normal publishing has no durable token or Aspy call, including after an external failure',async()=>{
 const {ops,reads}=setup();const op=await ops.beginSiteOperation('site','owner','publish_retry','job');
 assert.equal(op.token,null);assert.equal(op.deferred,false);
 await assert.rejects(op.runExternalEffect(async()=>{throw Error('WAF');}),/WAF/);await op.finish();
 const next=await ops.beginSiteOperation('site','owner','publish_retry','job');
 assert.equal(await next.runExternalEffect(async()=>'published'),'published');await next.finish();
 assert.deepEqual(reads,['wordpress_sites','execution_logs','wordpress_sites','execution_logs']);
});
for(const [name,options] of [['paused',{active:false}],['transferring',{holds:[{metadata:{phase:'transferring'}}]}],['awaiting_resume',{holds:[{metadata:{phase:'awaiting_resume'}}]}]])test(`normal mode still defers ${name} sites`,async()=>{
 const {ops}=setup(options);const op=await ops.beginSiteOperation('site','owner','publish','job');assert.equal(op.deferred,true);await assert.rejects(op.runExternalEffect(async()=>{}));
});
for(const [name,options] of [['wrong owner',{owner:'other'}],['site unavailable',{siteError:{code:'offline'}}],['holds unavailable',{holdError:{code:'offline'}}],['invalid hold',{holds:[{metadata:{phase:'unexpected'}}]}]])test(`normal mode refuses ${name}`,async()=>{
 const {ops}=setup(options);await assert.rejects(ops.beginSiteOperation('site','owner','publish','job'));
});
test('standalone client accepts explicitly disabled reservations without heartbeat or finish request',async()=>{
 const client={get:async()=>({data:{operation_token:null,operation_reservations_enabled:false}}),post:async()=>{throw Error('No reservation to release');}};
 const acquired=await beginVpsSiteOperation('site',{apiKey:'test',client});
 assert.equal(await acquired.operation.runExternalEffect(async()=>'published'),'published');await acquired.operation.finish();
});
test('standalone client still refuses an ambiguous null token',async()=>{
 await assert.rejects(beginVpsSiteOperation('site',{apiKey:'test',client:{get:async()=>({data:{operation_token:null}})}}));
});
