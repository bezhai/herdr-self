// Tests of message-command.ts (see package.json); run with node --test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {serve} from './client.ts';
import {main,usage} from './message-command.ts';
import {sourceLine} from './outbound-cards.ts';
import type {ControlApi,Peer} from './link.ts';
import type {Draft,Source} from './state.ts';

// A source and a draft as the control plane answers bridge-message with them.
const source:Source={messageId:'m1',chatId:'c1',chatName:'GEO 小分队',chatType:'group',sender:{id:'u1',name:'陈帆'},at:Date.parse('2026-11-11T10:49:00+08:00')};
const draft:Draft={id:'d1',clientId:'client-1',chatId:'c1',chatName:'GEO 小分队',chatType:'group',text:'请看一下',mentions:[],state:'pending',createdAt:source.at};
const answers={attach:{source},reply:{draft},send:{draft}};
type Request={op:string,body:unknown};
type Call=[string,Request,{timeoutMs:number}|undefined];
// A Bridge client on its real Unix-socket server, with a fake control-plane peer; calls records what the command forwards.
async function fakeClient(answer:(op:string,body:unknown)=>unknown=(op)=>answers[op as keyof typeof answers]){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-message-')),socket=path.join(dir,'client.sock'),calls:Call[]=[];let connected=true;
 const peer={call:async(method:string,params:Request,options:{timeoutMs:number}|undefined)=>{calls.push([method,params,options]);return answer(params.op,params.body);}} as unknown as Peer<ControlApi>;
 const server=await serve(socket,()=>connected?peer:null);
 return {dir,socket,calls,disconnect(){connected=false;},async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(dir,{recursive:true});}};
}
// Runs bridge-message against socket and captures its two output streams and exit status.
async function run(socket:string,args:string[],env:NodeJS.ProcessEnv={}){
 let out='',err='';const code=await main(args,{env:{BRIDGE_CLIENT_SOCKET:socket,HERDR_PANE_ID:'w1:p1',...env},stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}}});return {code,out,err};
}

test('bridge-message sends attach, reply and send to /messages/<op> with their ids, text, repeated mentions and the pane and session of the agent',async()=>{
 const client=await fakeClient();try{
  const before=Date.now(),attached=await run(client.socket,['attach','m1'],{HERDR_SESSION:'work'}),after=Date.now();
  assert.equal(attached.code,0);assert.equal(attached.err,'');assert.ok([before,after].some(now=>attached.out===`已放进话题：${sourceLine(source,now)}\n`),attached.out);
  assert.deepEqual(await run(client.socket,['reply','m1','--text','第一行\n第二行 @陈帆 @孙栎倩','--mention','u1=陈帆','--mention=u2=孙栎倩']),{code:0,out:'已发出确认卡片，主人点「发送」后才会发出\n',err:''});
  assert.deepEqual(await run(client.socket,['--json','send','c2','--mention','u3=名字=含等号','--text=--以选项开头的正文','--pane','w2:p3','--session=other']),{code:0,out:JSON.stringify(answers.send,null,2)+'\n',err:''});
  assert.deepEqual(client.calls,[
   ['messages',{op:'attach',body:{messageId:'m1',pane:'w1:p1',session:'work'}},{timeoutMs:60000}],
   ['messages',{op:'reply',body:{messageId:'m1',text:'第一行\n第二行 @陈帆 @孙栎倩',mentions:[{id:'u1',name:'陈帆'},{id:'u2',name:'孙栎倩'}],pane:'w1:p1'}},{timeoutMs:60000}],
   ['messages',{op:'send',body:{chatId:'c2',text:'--以选项开头的正文',mentions:[{id:'u3',name:'名字=含等号'}],pane:'w2:p3',session:'other'}},{timeoutMs:60000}],
  ]);
 }finally{await client.close();}
});

test('bridge-message prints the source or confirmation text and the untouched JSON answer for every operation',async()=>{
 const client=await fakeClient();try{
  for(const op of ['reply','send'] as const){
   const id=op==='reply'?'m1':'c1',result=await run(client.socket,[op,id,'--text','正文']);
   assert.deepEqual(result,{code:0,out:'已发出确认卡片，主人点「发送」后才会发出\n',err:''},op);
   assert.deepEqual(await run(client.socket,[op,id,'--text','正文','--json']),{code:0,out:JSON.stringify(answers[op],null,2)+'\n',err:''},op);
  }
  const result=await run(client.socket,['attach','m1','--json']);assert.deepEqual(result,{code:0,out:JSON.stringify(answers.attach,null,2)+'\n',err:''});
 }finally{await client.close();}
});

test('bridge-message reports malformed command lines with the complete usage and status 2 without calling Bridge',async()=>{
 const client=await fakeClient();try{
  const cases:[string[],RegExp][]=[
   [[],/缺少操作/],[['read','m1'],/未知的操作：read/],[['attach'],/缺少消息 ID/],[['reply'],/缺少消息 ID/],[['send'],/缺少聊天 ID/],
   [['reply','m1'],/reply 需要 --text/],[['send','c1'],/send 需要 --text/],[['attach','m1','extra'],/多余的参数：extra/],
   [['attach','m1','--text','正文'],/--text 只用于 reply 和 send/],[['attach','m1','--mention','u1=陈帆'],/--mention 只用于 reply 和 send/],
   [['send','c1','--text'],/--text 缺少值/],[['send','c1','--text','正文','--unknown'],/未知的参数：--unknown/],
   [['send','c1','--text','正文','--mention','陈帆'],/--mention 要写成 <用户 ID>=<名字>/],
   [['send','c1','--text','正文','--mention','=陈帆'],/--mention 要写成 <用户 ID>=<名字>/],
   [['send','c1','--text','正文','--mention','u1='],/--mention 要写成 <用户 ID>=<名字>/],
  ];
  for(const [args,error] of cases){const result=await run(client.socket,args);assert.equal(result.code,2,args.join(' '));assert.equal(result.out,'');assert.match(result.err,error,args.join(' '));assert.ok(result.err.endsWith(usage),args.join(' '));}
  assert.deepEqual(client.calls,[]);
 }finally{await client.close();}
});

test('bridge-message prints why Bridge refused and exits 1, and explains a client that is disconnected or absent',async()=>{
 const reason='这条消息不在本话题的来源里，先用 attach 放进来',client=await fakeClient(()=>{throw Error(reason);});try{
  assert.deepEqual(await run(client.socket,['reply','m9','--text','正文']),{code:1,out:'',err:`bridge-message: ${reason}\n`});
  client.disconnect();assert.deepEqual(await run(client.socket,['attach','m1']),{code:1,out:'',err:'bridge-message: 本机的 Bridge 客户端没有连上控制面：请稍后重试，一直这样时请主人查看这台机器上客户端的日志\n'});
  const absent=path.join(client.dir,'absent.sock');assert.deepEqual(await run(absent,['attach','m1']),{code:1,out:'',err:`bridge-message: 连不上本机的 Bridge 客户端（${absent}）：客户端没有运行，或者没有打开这个 socket\n`});
 }finally{await client.close();}
});

test('bridge-message --help is complete on its own and does not call Bridge',async()=>{
 const client=await fakeClient();try{
  for(const flag of ['--help','-h'])assert.deepEqual(await run(client.socket,[flag]),{code:0,out:usage,err:''});
  for(const op of ['attach','reply','send'])assert.ok(usage.includes(`  bridge-message ${op} `),op);
  for(const fact of ['--text','--mention','--json','--pane','--session','HERDR_PANE_ID','HERDR_SESSION','多行','退出码','确认卡片','主人点「发送」后才会发出','连不上本机的 Bridge 客户端','本机的 Bridge 客户端没有连上控制面','没有权限连接本机的 Bridge 客户端','不属于任何进行中的飞书话题','这条消息不在本话题的来源里','正文里没有 @','没有配置 open-lark','open-lark 没有响应'])assert.ok(usage.includes(fact),fact);
  assert.deepEqual(client.calls,[]);
 }finally{await client.close();}
});
