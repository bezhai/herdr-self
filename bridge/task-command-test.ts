// Tests of task-command.ts (see package.json); run with node --test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {serve} from './client.ts';
import {main,usage} from './task-command.ts';
import type {ControlApi,Peer} from './link.ts';

// The answer of the control plane: the task, and the outcome and reason that it was asked for.
const echo=(_op:string,body:unknown)=>({task:'k1',outcome:(body as {outcome:string}).outcome,reason:(body as {reason:string}).reason});
type Request={op:string,body:unknown};
type Call=[string,Request,{timeoutMs:number}|undefined];
// A Bridge client on its real Unix-socket server, with a fake control-plane peer; calls records what the command forwards.
async function fakeClient(reply:(op:string,body:unknown)=>unknown=echo){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-task-')),socket=path.join(dir,'client.sock'),calls:Call[]=[];let connected=true;
 const peer={call:async(method:string,params:Request,options:{timeoutMs:number}|undefined)=>{calls.push([method,params,options]);return reply(params.op,params.body);}} as unknown as Peer<ControlApi>;
 const server=await serve(socket,()=>connected?peer:null);
 return {dir,socket,calls,disconnect(){connected=false;},async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(dir,{recursive:true});}};
}
// Runs bridge-task against socket and captures its two output streams and exit status.
async function run(socket:string,args:string[],env:NodeJS.ProcessEnv={}){
 let out='',err='';const code=await main(args,{env:{BRIDGE_CLIENT_SOCKET:socket,HERDR_PANE_ID:'w1:p1',...env},stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}}});return {code,out,err};
}

test('bridge-task end sends the outcome, the reason and the pane and session of the agent to /tasks/end',async()=>{
 const client=await fakeClient();try{
  assert.deepEqual(await run(client.socket,['end','--achieved','--reason','周报已整理'],{HERDR_SESSION:'work'}),{code:0,out:'任务会在当前这一轮结束时结束（已完成）：周报已整理\n',err:''});
  assert.deepEqual(await run(client.socket,['end','--dropped','--reason=主人说不用了','--pane','w2:p3','--session=other','--json']),{code:0,out:JSON.stringify({task:'k1',outcome:'dropped',reason:'主人说不用了'},null,2)+'\n',err:''});
  assert.deepEqual(await run(client.socket,['end','--reason','--dropped','--dropped']),{code:0,out:'任务会在当前这一轮结束时结束（已放弃）：--dropped\n',err:''});
  assert.deepEqual(client.calls,[
   ['tasks',{op:'end',body:{outcome:'achieved',reason:'周报已整理',pane:'w1:p1',session:'work'}},{timeoutMs:60000}],
   ['tasks',{op:'end',body:{outcome:'dropped',reason:'主人说不用了',pane:'w2:p3',session:'other'}},{timeoutMs:60000}],
   ['tasks',{op:'end',body:{outcome:'dropped',reason:'--dropped',pane:'w1:p1'}},{timeoutMs:60000}],
  ]);
 }finally{await client.close();}
});

test('bridge-task prints the dropped wording for a dropped task',async()=>{
 const client=await fakeClient();try{
  assert.deepEqual(await run(client.socket,['end','--dropped','--reason','不用了']),{code:0,out:'任务会在当前这一轮结束时结束（已放弃）：不用了\n',err:''});
 }finally{await client.close();}
});

test('bridge-task reports malformed command lines with the complete usage and status 2 without calling Bridge',async()=>{
 const client=await fakeClient();try{
  const cases:[string[],RegExp][]=[
   [[],/缺少操作/],[['stop','--achieved','--reason','x'],/未知的操作：stop/],[['end','--reason','x'],/要给出 --achieved 或 --dropped/],
   [['end','--achieved','--dropped','--reason','x'],/--achieved 和 --dropped 只能给一个/],[['end','--achieved'],/end 需要 --reason/],
   [['end','--achieved','--reason','   '],/--reason 不能为空/],[['end','--achieved','--reason'],/--reason 缺少值/],
   [['end','--achieved','--reason','x','extra'],/多余的参数：extra/],[['end','--achieved','--reason','x','--unknown'],/未知的参数：--unknown/],
   [['end','--achieved=1','--reason','x'],/未知的参数：--achieved=1/],
  ];
  for(const [args,error] of cases){const result=await run(client.socket,args);assert.equal(result.code,2,args.join(' '));assert.equal(result.out,'');assert.match(result.err,error,args.join(' '));assert.ok(result.err.endsWith(usage),args.join(' '));}
  assert.deepEqual(client.calls,[]);
 }finally{await client.close();}
});

test('bridge-task prints why Bridge refused and exits 1, and explains a client that is disconnected or absent',async()=>{
 const reason='还有草稿在等主人确认',client=await fakeClient(()=>{throw Error(reason);});try{
  assert.deepEqual(await run(client.socket,['end','--achieved','--reason','x']),{code:1,out:'',err:`bridge-task: ${reason}\n`});
  client.disconnect();assert.deepEqual(await run(client.socket,['end','--achieved','--reason','x']),{code:1,out:'',err:'bridge-task: 本机的 Bridge 客户端没有连上控制面：请稍后重试，一直这样时请主人查看这台机器上客户端的日志\n'});
  const absent=path.join(client.dir,'absent.sock');assert.deepEqual(await run(absent,['end','--achieved','--reason','x']),{code:1,out:'',err:`bridge-task: 连不上本机的 Bridge 客户端（${absent}）：客户端没有运行，或者没有打开这个 socket\n`});
 }finally{await client.close();}
});

test('bridge-task --help is complete on its own and does not call Bridge',async()=>{
 const client=await fakeClient();try{
  for(const flag of ['--help','-h'])assert.deepEqual(await run(client.socket,[flag]),{code:0,out:usage,err:''});
  assert.ok(usage.includes('  bridge-task end '));
  for(const fact of ['--achieved','--dropped','--reason','--json','--pane','--session','HERDR_PANE_ID','HERDR_SESSION','退出码','当前这一轮结束','主人再写一条消息','还有草稿在等主人确认','任务已经结束','不属于任何进行中的飞书话题'])assert.ok(usage.includes(fact),fact);
  assert.deepEqual(client.calls,[]);
 }finally{await client.close();}
});
