// Tests of open-lark.ts (see package.json); run with node --test.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {openLarkMethods} from './open-lark.ts';

// JSON that a fake open-lark receives or returns.
type Json=any;
// A request that the fake open-lark received, after reading its whole body.
type Seen={method:string|undefined,path:string|undefined,authorization:string|undefined,body:Json};
// What a fake open-lark does with one request.
type Handler=(req:http.IncomingMessage,res:http.ServerResponse,body:Json)=>void;
const token='local-test-token';
const sendParams={chatId:'feed-group',clientId:'00000000-0000-4000-8000-000000000001',text:'@小明 请看一下',mentions:[{id:'u1',name:'小明'}]};
const replyParams={messageId:'m1',clientId:'00000000-0000-4000-8000-000000000002',text:'@小明 请看一下',mentions:[{id:'u1',name:'小明'}]};
// A JSON response of a fake open-lark.
function answer(res:http.ServerResponse,status:number,body:Json){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
// A fake open-lark on an ephemeral loopback port, with no connection to a real service.
async function fixture(t:TestContext,handler:Handler){
 const seen:Seen[]=[],server=http.createServer((req,res)=>{
  let raw='';req.setEncoding('utf8');req.on('data',s=>{raw+=s;});req.on('end',()=>{
   const body=raw?JSON.parse(raw):undefined;seen.push({method:req.method,path:req.url,authorization:req.headers.authorization,body});handler(req,res,body);
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');
 return {config:{url:`http://127.0.0.1:${address.port}`,token},seen};
}
// Every request of the owner's channel uses the full token without putting it in an error.
function assertAuthorization(seen:Seen[]){for(const r of seen)assert.equal(r.authorization,'Bearer '+token);}
// The coded rejection of a method, which never exposes the credential.
async function rejectsCode(p:unknown,code:string){
 await assert.rejects(Promise.resolve(p),(e:Error&{code?:string})=>{assert.equal(e.code,code);assert.ok(!e.message.includes(token));return true;});
}

test('the four methods use the agent API, project messages and chats, and send as the cached current account',async t=>{
 const f=await fixture(t,(req,res)=>{
  if(req.url==='/agent/v1/messages/m1'&&req.method==='GET')return answer(res,200,{item:{id:'m1',feedId:'feed-group',senderId:'u2',senderName:'陈帆',createdAt:'2026-11-10T01:02:03.000Z',parts:[
   {kind:'text',text:'你好 '},{kind:'at',text:'@小明'},{kind:'image'},{kind:'file',text:'方案.pdf'},{kind:'link',text:'链接'},
  ]},attachments:[{id:'a1'}]});
  if(req.url==='/agent/v1/conversations/feed-group'&&req.method==='GET')return answer(res,200,{feedId:'feed-group',name:'研发群',isGroup:true,chatMode:'group'});
  if(req.url==='/agent/v1/conversations/feed-direct'&&req.method==='GET')return answer(res,200,{feedId:'feed-direct',name:'陈帆',isGroup:false,chatMode:'direct'});
  if(req.url==='/agent/v1/conversations/feed-topic'&&req.method==='GET')return answer(res,200,{feedId:'feed-topic',name:'话题群',isGroup:true,chatMode:'topic'});
  if(req.url==='/agent/v1/messages/m1/link'&&req.method==='POST')return answer(res,200,{url:'https://feishu.example/m1'});
  if(req.url==='/agent/v1/me'&&req.method==='GET')return answer(res,200,{userId:'owner-id',displayName:'主人账号'});
  if(req.url==='/agent/v1/conversations/feed-group/messages'&&req.method==='POST')return answer(res,202,{messageId:'sent-1',createdAt:'2026-11-11T02:03:04.000Z'});
  if(req.url==='/agent/v1/messages/m1/replies'&&req.method==='POST')return answer(res,202,{messageId:'sent-2',feedId:'feed-group',replyToMessageId:'m1'});
  answer(res,404,{error:{code:'NOT_FOUND',message:'unknown fake route',recoverable:false,traceId:'test'}});
 });
 const api=openLarkMethods(f.config);
 assert.deepEqual(await api.openLarkMessage({messageId:'m1'}),{chatId:'feed-group',chatName:'研发群',chatType:'group',messageId:'m1',sender:{id:'u2',name:'陈帆'},at:Date.parse('2026-11-10T01:02:03.000Z'),text:'你好 @小明[图片][文件] 方案.pdf链接',link:'https://feishu.example/m1'});
 assert.deepEqual(await api.openLarkChat({chatId:'feed-direct'}),{chatId:'feed-direct',chatName:'陈帆',chatType:'p2p'});
 assert.deepEqual(await api.openLarkChat({chatId:'feed-topic'}),{chatId:'feed-topic',chatName:'话题群',chatType:'group'});
 assert.deepEqual(await api.openLarkSend(sendParams),{messageId:'sent-1',at:Date.parse('2026-11-11T02:03:04.000Z'),owner:'主人账号'});
 const before=Date.now(),reply=await api.openLarkReply(replyParams),after=Date.now();
 assert.deepEqual(reply,{messageId:'sent-2',at:reply.at,owner:'主人账号'});assert.ok(reply.at>=before&&reply.at<=after);
 assert.deepEqual(f.seen.map(r=>[r.method,r.path]),[
  ['GET','/agent/v1/messages/m1'],['GET','/agent/v1/conversations/feed-group'],['POST','/agent/v1/messages/m1/link'],
  ['GET','/agent/v1/conversations/feed-direct'],['GET','/agent/v1/conversations/feed-topic'],
  ['GET','/agent/v1/me'],['POST','/agent/v1/conversations/feed-group/messages'],['POST','/agent/v1/messages/m1/replies'],
 ]);
 assertAuthorization(f.seen);
 assert.equal(f.seen[2]!.body&&Object.keys(f.seen[2]!.body).length,0);
 assert.deepEqual(f.seen[6]!.body,{text:sendParams.text,mentions:[{userId:'u1',name:'小明'}],clientId:sendParams.clientId,expectedSenderId:'owner-id'});
 assert.deepEqual(f.seen[7]!.body,{text:replyParams.text,mentions:[{userId:'u1',name:'小明'}],clientId:replyParams.clientId,expectedSenderId:'owner-id',replyMode:'direct'});
 // The two sends share one /me lookup, but every request still carries the token.
 assert.equal(f.seen.filter(r=>r.path==='/agent/v1/me').length,1);
});

test('a send refused with SENDER_CHANGED drops the cached account so the next send reads /me again',async t=>{
 let lookups=0,sends=0;
 const f=await fixture(t,(req,res)=>{
  if(req.url==='/agent/v1/me')return answer(res,200,++lookups===1?{userId:'owner-id',displayName:'主人账号'}:{userId:'new-id',displayName:'新账号'});
  if(req.url==='/agent/v1/conversations/feed-group/messages'&&++sends===1)return answer(res,409,{error:{code:'SENDER_CHANGED',message:'账号已更换',recoverable:true,traceId:'test'}});
  answer(res,202,{messageId:'sent-1',createdAt:'2026-11-11T02:03:04.000Z'});
 });
 const api=openLarkMethods(f.config);
 await assert.rejects(Promise.resolve(api.openLarkSend(sendParams)),(e:Error&{code?:string})=>{assert.equal(e.code,'channel_refused');assert.match(e.message,/^SENDER_CHANGED：/);return true;});
 assert.equal(lookups,1);
 assert.deepEqual(await api.openLarkSend(sendParams),{messageId:'sent-1',at:Date.parse('2026-11-11T02:03:04.000Z'),owner:'新账号'});
 assert.equal(lookups,2);assert.equal(f.seen.at(-1)!.body.expectedSenderId,'new-id');assertAuthorization(f.seen);
});

test('message text falls back to textPreview and a failed link lookup leaves link out without failing the read',async t=>{
 const f=await fixture(t,(req,res)=>{
  if(req.url==='/agent/v1/messages/m2')return answer(res,200,{item:{id:'m2',feedId:'feed-direct',senderId:'u2',senderName:'陈帆',createdAt:'2026-11-10T01:02:03.000Z',parts:[],textPreview:'只有预览'},attachments:[]});
  if(req.url==='/agent/v1/conversations/feed-direct')return answer(res,200,{feedId:'feed-direct',name:'陈帆',isGroup:false,chatMode:'direct'});
  if(req.url==='/agent/v1/messages/m2/link')return answer(res,503,{error:{code:'LINK_UNAVAILABLE',message:'暂时没有链接',recoverable:true,traceId:'test'}});
  answer(res,404,{error:{code:'NOT_FOUND',message:'unknown fake route',recoverable:false,traceId:'test'}});
 });
 assert.deepEqual(await openLarkMethods(f.config).openLarkMessage({messageId:'m2'}),{chatId:'feed-direct',chatName:'陈帆',chatType:'p2p',messageId:'m2',sender:{id:'u2',name:'陈帆'},at:Date.parse('2026-11-10T01:02:03.000Z'),text:'只有预览'});
 assert.equal(f.seen.length,3);assertAuthorization(f.seen);
});

test('all four methods reject with channel_unconfigured when the client has no open-lark config',async()=>{
 const api=openLarkMethods(undefined);
 await rejectsCode(api.openLarkMessage({messageId:'m1'}),'channel_unconfigured');
 await rejectsCode(api.openLarkChat({chatId:'feed-group'}),'channel_unconfigured');
 await rejectsCode(api.openLarkReply(replyParams),'channel_unconfigured');
 await rejectsCode(api.openLarkSend(sendParams),'channel_unconfigured');
});

test('malformed params reject with invalid_params before any request',async t=>{
 const f=await fixture(t,(_req,res)=>answer(res,500,{error:{code:'UNEXPECTED',message:'must not be called',recoverable:false,traceId:'test'}}));
 const api=openLarkMethods(f.config) as unknown as Record<string,(params:Json)=>Promise<unknown>>;
 const bad:[string,Json][]=[
  ['openLarkMessage',{messageId:''}],['openLarkMessage',{messageId:3}],['openLarkChat',{chatId:''}],
  ['openLarkSend',{...sendParams,clientId:''}],['openLarkSend',{...sendParams,text:'  \n'}],
  ['openLarkSend',{...sendParams,text:'x'.repeat(100001)}],['openLarkSend',{...sendParams,mentions:{}}],
  ['openLarkSend',{...sendParams,mentions:[{id:'',name:'小明'}]}],['openLarkSend',{...sendParams,mentions:[{id:'u1',name:''}]}],
  ['openLarkSend',{...sendParams,text:'请看一下'}],['openLarkReply',{...replyParams,messageId:''}],
  ['openLarkReply',{...replyParams,timeoutMs:0}],['openLarkChat',{chatId:'feed-group',timeoutMs:Number.NaN}],
 ];
 for(const [method,params]of bad)await rejectsCode(api[method]!(params),'invalid_params');
 assert.equal(f.seen.length,0);
});

test('open-lark error responses reject with channel_refused and its code and explanation',async t=>{
 const f=await fixture(t,(req,res)=>{
  const direct=req.url==='/agent/v1/conversations/feed-4';answer(res,direct?404:500,{error:{code:direct?'CONVERSATION_NOT_FOUND':'UPSTREAM_UNAVAILABLE',message:direct?'没有这个聊天':'飞书暂时不可用',recoverable:!direct,traceId:'test'}});
 });
 const api=openLarkMethods(f.config);
 await assert.rejects(Promise.resolve(api.openLarkChat({chatId:'feed-4'})),(e:Error&{code?:string})=>{assert.equal(e.code,'channel_refused');assert.equal(e.message,'CONVERSATION_NOT_FOUND：没有这个聊天');assert.ok(!e.message.includes(token));return true;});
 await assert.rejects(Promise.resolve(api.openLarkChat({chatId:'feed-5'})),(e:Error&{code?:string})=>{assert.equal(e.code,'channel_refused');assert.equal(e.message,'UPSTREAM_UNAVAILABLE：飞书暂时不可用');assert.ok(!e.message.includes(token));return true;});
 assertAuthorization(f.seen);
});

test('a closed loopback port rejects with channel_unreachable without exposing the token',async()=>{
 const server=net.createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const address=server.address();assert.ok(address&&typeof address==='object');const port=address.port;
 await new Promise<void>(resolve=>server.close(()=>resolve()));
 await rejectsCode(openLarkMethods({url:`http://127.0.0.1:${port}`,token}).openLarkChat({chatId:'feed-group'}),'channel_unreachable');
});

test('a server that does not answer within timeoutMs is aborted and rejects with channel_unreachable',async t=>{
 const f=await fixture(t,()=>{});
 await rejectsCode(openLarkMethods(f.config).openLarkChat({chatId:'feed-group',timeoutMs:20}),'channel_unreachable');
 assert.equal(f.seen.length,1);assertAuthorization(f.seen);
});
