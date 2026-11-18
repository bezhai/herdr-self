// Tests of service-command.ts (see package.json); run with node --test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {serve} from './client.ts';
import {main,usage} from './service-command.ts';
import type {ControlApi,Peer,ServiceAnswer} from './link.ts';

type Call=[string,{op:string,body:any},{timeoutMs:number}|undefined];
// A Bridge client on its real Unix-socket server, with a fake control-plane peer; calls records what the command forwards.
async function fakeClient(answer:(op:string,body:any)=>unknown){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-call-')),socket=path.join(dir,'client.sock'),calls:Call[]=[];let connected=true;
 const peer={call:async(method:string,params:{op:string,body:unknown},options:{timeoutMs:number}|undefined)=>{calls.push([method,params,options]);const r=answer(params.op,params.body);if(r instanceof Error)throw r;return r;}} as unknown as Peer<ControlApi>;
 const server=await serve(socket,()=>connected?peer:null);
 return {dir,socket,calls,disconnect(){connected=false;},async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(dir,{recursive:true});}};
}
const text=(body:string,status=200):ServiceAnswer=>({status,contentType:'application/json',encoding:'text',body});
async function run(socket:string,args:string[]){
 let out='',err='';const code=await main(args,{env:{BRIDGE_CLIENT_SOCKET:socket},stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}}});return {code,out,err};
}

test('bridge-call sends service, method, path without its query, query pairs, headers and body as services call, and prints the body as it is',async t=>{
 const c=await fakeClient(()=>text('{"items":[]}'));t.after(()=>c.close());
 let r=await run(c.socket,['notes','get','/items/search?q=a%20b&x=1','--url-query','k=中文=1','--url-query=z=','-H','X-Lang: zh','--header','x-trace:  7']);
 assert.deepEqual(r,{code:0,out:'{"items":[]}',err:''});
 assert.deepEqual(c.calls[0],['services',{op:'call',body:{service:'notes',method:'GET',path:'/items/search',query:[['q','a b'],['x','1'],['k','中文=1'],['z','']],headers:{'x-lang':'zh','x-trace':'7'}}},{timeoutMs:60000}]);
 await run(c.socket,['notes','POST','/search','{"q":"x"}']);assert.deepEqual(c.calls[1][1].body,{service:'notes',method:'POST',path:'/search',body:'{"q":"x"}'});
 await run(c.socket,['notes','PUT','/search','[1]']);assert.equal(c.calls[2][1].body.body,'[1]');
 await run(c.socket,['notes','POST','/search']);assert.deepEqual(c.calls[3][1].body,{service:'notes',method:'POST',path:'/search'});
 await run(c.socket,['notes','GET','/']);assert.equal(c.calls[4][1].body.path,'/');
 await run(c.socket,['notes','GET','me']);assert.equal(c.calls[5][1].body.path,'me');
});

test('bridge-call reads a body from @file',async t=>{
 const c=await fakeClient(()=>text('{}'));t.after(()=>c.close());
 const file=path.join(c.dir,'body.json');fs.writeFileSync(file,'{"q":"文件"}');
 assert.equal((await run(c.socket,['notes','POST','/search','@'+file])).code,0);assert.equal(c.calls[0][1].body.body,'{"q":"文件"}');
 const r=await run(c.socket,['notes','POST','/search','@'+path.join(c.dir,'missing.json')]);assert.equal(r.code,2);assert.match(r.err,/missing\.json/);assert.equal(c.calls.length,1);
});

test('bridge-call exits 1 and prints the error body at HTTP 400 or above, and 0 below',async t=>{
 const c=await fakeClient((_op,b)=>b.path==='/r'?text('{"moved":1}',302):text('{"error":"no"}',403));t.after(()=>c.close());
 let r=await run(c.socket,['notes','POST','/items','{}']);
 assert.equal(r.code,1);assert.equal(r.out,'{"error":"no"}');assert.match(r.err,/403/);
 r=await run(c.socket,['notes','GET','/r']);assert.equal(r.code,0);assert.equal(r.out,'{"moved":1}');
});

test('bridge-call writes a binary body only with -o, and says so otherwise',async t=>{
 const bytes=Buffer.from([0,255,1,2,200]),c=await fakeClient((_op,b)=>b.path==='/t'?text('你好'):b.path==='/e'?text('{"e":1}',500):({status:200,contentType:'image/png',encoding:'base64',body:bytes.toString('base64')}));t.after(()=>c.close());
 let r=await run(c.socket,['notes','GET','/files/1']);
 assert.equal(r.code,1);assert.equal(r.out,'');assert.match(r.err,/-o/);assert.match(r.err,/image\/png/);
 const file=path.join(c.dir,'out.bin');r=await run(c.socket,['notes','GET','/files/1','-o',file]);
 assert.deepEqual(r,{code:0,out:'',err:''});assert.deepEqual(fs.readFileSync(file),bytes);
 const t2=path.join(c.dir,'out.txt');r=await run(c.socket,['notes','GET','/t','-o',t2]);assert.deepEqual(r,{code:0,out:'',err:''});assert.equal(fs.readFileSync(t2,'utf8'),'你好');
 const e=path.join(c.dir,'err.txt');r=await run(c.socket,['notes','GET','/e','-o',e]);assert.equal(r.code,1);assert.equal(r.out,'{"e":1}');assert.equal(fs.existsSync(e),false);
});

test('bridge-call --list prints the names of the services, one per line, and says when there are none',async t=>{
 let names=['notes','wiki'];const c=await fakeClient(()=>({services:names}));t.after(()=>c.close());
 assert.deepEqual(await run(c.socket,['--list']),{code:0,out:'notes\nwiki\n',err:''});
 assert.deepEqual(c.calls[0],['services',{op:'list',body:{}},{timeoutMs:60000}]);
 names=[];const r=await run(c.socket,['--list']);assert.equal(r.code,0);assert.equal(r.out,'');assert.match(r.err,/没有/);
 assert.equal((await run(c.socket,['--list','notes'])).code,2);
});

test('bridge-call refuses what it does not know with exit 2 and the usage, and sends nothing',async t=>{
 const c=await fakeClient(()=>text('{}'));t.after(()=>c.close());
 const bad=[[],['notes'],['notes','GET'],['notes','GET','/a','/b'],['notes','GET','/a','--bogus'],['notes','GET','/a','--upload','f'],['notes','GET','/a','-H'],['notes','GET','/a','-H','nocolon'],['notes','GET','/a','-H',': v'],
  ['notes','GET','/a','--url-query'],['notes','GET','/a','--url-query','novalue'],['notes','GET','/a','-o'],['notes','TRACE','/a'],['notes','GET','/a','{}'],['notes','HEAD','/a','{}'],['notes','DELETE','/a','{}'],
  ['notes','GET','/a','?x'],['notes','GET','/a#b'],['Bad_Name','GET','/a'],['--list','--help2']];
 for(const args of bad){const r=await run(c.socket,args);assert.equal(r.code,2,args.join(' '));assert.ok(r.err.includes(usage),args.join(' '));}
 assert.equal(c.calls.length,0);
});

test('bridge-call --help prints the usage and sends nothing',async t=>{
 const c=await fakeClient(()=>text('{}'));t.after(()=>c.close());
 assert.deepEqual(await run(c.socket,['--help']),{code:0,out:usage,err:''});assert.deepEqual(await run(c.socket,['notes','-h']),{code:0,out:usage,err:''});
 assert.equal(c.calls.length,0);assert.match(usage,/--list/);assert.match(usage,/-H/);assert.match(usage,/-o/);
});

test('bridge-call prints one line and exits 1 when Bridge refuses, the client is not connected or there is no socket',async t=>{
 const c=await fakeClient(()=>Error('没有机器提供服务「notes」'));t.after(()=>c.close());
 let r=await run(c.socket,['notes','GET','/me']);assert.deepEqual(r,{code:1,out:'',err:'bridge-call: 没有机器提供服务「notes」\n'});
 c.disconnect();r=await run(c.socket,['notes','GET','/me']);assert.equal(r.code,1);assert.match(r.err,/没有连上控制面/);
 r=await run(path.join(c.dir,'none.sock'),['notes','GET','/me']);assert.equal(r.code,1);assert.match(r.err,/连不上本机的 Bridge 客户端/);
});
