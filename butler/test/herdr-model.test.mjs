import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HerdrModel} from '../herdr-model.mjs';

const FAKE=fileURLToPath(new URL('./fake-herdr.mjs',import.meta.url));
const CWD='/home/me/.local/share/butler-model';
function setup(t,script={},extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-herdr-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=s=>fs.writeFileSync(path.join(dir,'script.json'),JSON.stringify(s));write(script);
 const model=new HerdrModel({machine:'cpu1-butler',cwd:CWD,command:[process.execPath,FAKE,dir],replyGraceMs:600,replyPollMs:50,...extra});
 const calls=()=>fs.readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const state=()=>JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
 const seed=s=>fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(s));
 return {model,calls,state,write,seed};
}
const SYSTEM='你在帮「原智鸿」整理飞书消息。只输出 JSON。';
const PROMPT='数据：\n{"me":"原智鸿","chats":[{"chat":"项目群","messages":[{"ref":"m1","text":"它说 \'引号\' \\"双引号\\" $HOME `x` ; rm -rf /"}]}]}';

test('each prompt goes to a fresh claude without tools in a workspace of its own, closed afterwards',async t=>{
 const {model,calls,state}=setup(t,{replies:[{text:'{"new":[],"updates":[]}'}]});
 assert.equal(await model.ask({system:SYSTEM,prompt:PROMPT}),'{"new":[],"updates":[]}');
 const c=calls();
 assert.ok(c.every(a=>a[0]==='--machine'&&a[1]==='cpu1-butler'),'every command goes to the model machine');
 const verbs=c.map(a=>a.slice(2,4).join(' '));
 assert.deepEqual(verbs,['workspace create','agent start','agent prompt','agent replies','workspace close']);
 const create=c[0];assert.equal(create[create.indexOf('--cwd')+1],CWD);assert.ok(create.includes('--no-focus'));assert.equal(create[create.indexOf('--label')+1],'butler-model');
 const start=c[1],claude=start.slice(start.indexOf('--')+1);
 assert.equal(start[start.indexOf('--kind')+1],'claude');assert.equal(start[start.indexOf('--pane')+1],'w1:p1');
 assert.deepEqual(claude.slice(0,4),['--tools','','--strict-mcp-config','--disable-slash-commands'],'no built-in tools and no MCP servers');
 assert.equal(claude[claude.indexOf('--system-prompt')+1],SYSTEM);
 const prompt=c[2];assert.equal(prompt[5],PROMPT,'the prompt arrives as it was, quotes and all');assert.ok(prompt.includes('--wait'));
 assert.equal(prompt[4],start[4],'the prompt goes to the agent just started');
 assert.deepEqual(state().workspaces,{},'nothing is left on the model machine');
 await model.ask({system:SYSTEM,prompt:'第二批'});
 const names=calls().filter(a=>a[2]==='agent'&&a[3]==='start').map(a=>a[4]);
 assert.equal(new Set(names).size,2,'a new agent for every prompt');assert.ok(names.every(n=>/^[a-z][a-z0-9_-]{0,31}$/.test(n)));
});

test('the workspace is closed whatever goes wrong, and the error says what',async t=>{
 const cases=[
  [{fail:{'agent start':{code:1,stderr:'{"error":{"code":"timeout","message":"timed out waiting for agent startup"},"id":"cli:agent:start"}\n'}}},/agent start.*timed out waiting for agent startup/],
  [{replies:[{timeout:true}]},/agent prompt.*timed out/],
  [{replies:[{none:true}]},/没有回复/],
  [{replies:[{text:'{"new":',truncated:true}]},/截断/],
  [{replies:[{blocked:true,text:'?'}]},/blocked/],
 ];
 for(const [script,error] of cases){
  const {model,state,calls}=setup(t,script);
  // answered: the model did answer (the processor may hold that against the batch); everything else is no answer.
  await assert.rejects(model.ask({system:SYSTEM,prompt:'x'}),e=>error.test(e.message)&&Boolean(e.answered)===Boolean(script.replies?.[0]?.truncated));
  assert.deepEqual(state().workspaces,{},`closed after ${JSON.stringify(script)}`);assert.deepEqual(calls().at(-1).slice(2,4),['workspace','close']);
 }
});

test('a reply that lands just after the agent settles is still taken',async t=>{
 const {model}=setup(t,{replies:[{text:'{"late":true}',lateMs:300}]});
 assert.equal(await model.ask({system:SYSTEM,prompt:'x'}),'{"late":true}');
});

test('an unreachable machine fails with herdr\'s message',async t=>{
 const {model,calls}=setup(t,{unreachable:true});
 await assert.rejects(model.ask({system:SYSTEM,prompt:'x'}),/Connection refused/);
 assert.equal(calls().length,1,'nothing more is tried');
});

test('a prompt too long for a command-line argument is refused before anything starts',async t=>{
 const {model,calls}=setup(t);
 await assert.rejects(model.ask({system:SYSTEM,prompt:'长'.repeat(50_000)}),/太长/);
 assert.throws(()=>calls(),/ENOENT/,'herdr was not called');
});

test('cleanup closes the workspaces a crashed run left behind, and only those',async t=>{
 const {model,state,seed}=setup(t);
 seed({next:4,seq:0,agents:{},workspaces:{w1:{label:'yuanzhihong.chiwei',pane:'w1:p1'},w2:{label:'butler-model',pane:'w2:p1'},w3:{label:'butler-model',pane:'w3:p1'}}});
 assert.equal(await model.cleanup(),2);
 assert.deepEqual(Object.keys(state().workspaces),['w1']);
});
