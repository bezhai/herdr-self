import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setup,waitFor,LINK_BASE} from './helpers.mjs';

const CLI=fileURLToPath(new URL('../cli.mjs',import.meta.url));
// The CLI runs as its own process against the same store file; async so the in-process fake can answer it.
function cli(config,...args){
 return new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['--disable-warning=ExperimentalWarning',CLI,'--config',config,...args],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));
 });
}
function writeConfig(dir,lark,mode=0o600){
 const file=path.join(dir,'butler.env');
 fs.writeFileSync(file,`# butler\nBUTLER_OPEN_LARK_TOKEN="${lark.token}"\nBUTLER_OPEN_LARK_URL=${lark.url}\nBUTLER_LINK_BASE=${LINK_BASE}\nBUTLER_DATA_DIR=${dir}\n`,{mode});fs.chmodSync(file,mode);return file;
}

test('the config file holds the token and must not be readable by others',async t=>{
 const {lark,dir}=await setup(t);const config=writeConfig(dir,lark,0o644);
 let r=await cli(config,'status');assert.equal(r.code,1);assert.match(r.stderr,/600/);
 fs.chmodSync(config,0o600);r=await cli(config,'status');assert.equal(r.code,0,r.stderr);
 r=await cli(path.join(dir,'missing.env'),'status');assert.equal(r.code,1);assert.match(r.stderr,/配置文件/);
});

test('watch list commands: add by name or id, refuse ambiguous names, remove; groups lists my groups',async t=>{
 const {lark,store,dir}=await setup(t);const config=writeConfig(dir,lark);
 const project=lark.chat({name:'项目群',memberCount:42}),a=lark.chat({name:'测试群A'}),b=lark.chat({name:'测试群B',memberCount:7});lark.chat({name:'张三',chatMode:'direct'});
 let r=await cli(config,'groups');assert.equal(r.code,0,r.stderr);
 for(const name of ['项目群','测试群A','测试群B'])assert.match(r.stdout,new RegExp(name));assert.doesNotMatch(r.stdout,/张三/);assert.match(r.stdout,/42/);
 r=await cli(config,'watch','add','项目群');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/项目群/);
 r=await cli(config,'watch','add','测试群');assert.equal(r.code,1);assert.match(r.stderr,/测试群A/);assert.match(r.stderr,/测试群B/);
 r=await cli(config,'watch','add',b);assert.equal(r.code,0,r.stderr);
 assert.deepEqual(store.watches().map(w=>w.feedId).sort(),[project,b].sort());
 assert.ok(store.watches().every(w=>Math.abs(w.since-Date.now())<60e3),'collected from when it was added');
 r=await cli(config,'watch','list');assert.match(r.stdout,/项目群/);assert.match(r.stdout,/测试群B/);assert.doesNotMatch(r.stdout,/测试群A/);
 r=await cli(config,'groups');assert.match(r.stdout.split('\n').find(l=>l.includes('项目群')),/★/);
 r=await cli(config,'watch','remove','项目群');assert.equal(r.code,0,r.stderr);assert.deepEqual(store.watches().map(w=>w.feedId),[b]);
 // A topic group is added, with a warning: butler does not read topic groups by position.
 const topic=lark.chat({name:'需求讨论',chatMode:'topic'});
 r=await cli(config,'watch','add','需求讨论');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/是话题群/);assert.ok(store.watchSince(topic));
 r=await cli(config,'watch','add',b);assert.doesNotMatch(r.stdout,/是话题群/);
 assert.ok(a);assert.deepEqual(lark.writes(),[]);
});

test('status and list show what the collector recorded',async t=>{
 const {lark,store,dir,running}=await setup(t);const config=writeConfig(dir,lark);
 const group=lark.chat({name:'大群'}),dm=lark.chat({name:'张三',chatMode:'direct'});
 const c=await running();const at=lark.post(group,{atMe:true,text:'请看下'}),d=lark.post(dm,{text:'私聊内容'});
 await waitFor(()=>store.message(at.id)?.chatName&&store.message(d.id));c.flushStatus();
 let r=await cli(config,'status');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/推送：已连接/);assert.match(r.stdout,/对账/);assert.match(r.stdout,/live/);assert.match(r.stdout,/mention 1/);assert.match(r.stdout,/dm 1/);
 r=await cli(config,'status','--json');const s=JSON.parse(r.stdout);assert.equal(s.events.connected,true);assert.equal(s.counts.total,2);
 r=await cli(config,'list','--category','mention');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/请看下/);assert.match(r.stdout,/大群/);assert.doesNotMatch(r.stdout,/私聊内容/);
 assert.ok(r.stdout.includes(`${LINK_BASE}/messenger/${group}?message=${at.id}`));
 r=await cli(config,'list','--json','--since','1h');const items=JSON.parse(r.stdout);
 assert.deepEqual(items.map(i=>i.id).sort(),[at.id,d.id].sort());assert.ok(items.every(i=>i.link&&Array.isArray(i.categories)&&i.chatName));
 r=await cli(config,'list','--category','nope');assert.equal(r.code,1);
});

test('run collects as a long-running process and stops cleanly on SIGTERM',async t=>{
 const {lark,store,dir}=await setup(t);const config=writeConfig(dir,lark);const dm=lark.chat({name:'张三',chatMode:'direct'});
 const p=spawn(process.execPath,[CLI,'--config',config,'run'],{stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);
 t.after(()=>p.kill('SIGKILL'));
 await waitFor(()=>/推送已连接/.test(out),{timeout:5000,message:'collector up'});
 const v=lark.post(dm,{text:'服务收到的私聊'});
 await waitFor(()=>store.message(v.id),{timeout:5000,message:'pushed message stored by the service'});
 const exited=new Promise(r=>p.on('close',(code,signal)=>r({code,signal})));p.kill('SIGTERM');
 assert.deepEqual(await exited,{code:0,signal:null});
 assert.ok(store.status().collector.stoppedAt,'the stop is recorded');assert.doesNotMatch(out,/ExperimentalWarning/);
});
