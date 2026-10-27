import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setup,waitFor,post,LINK_BASE} from './helpers.mjs';
import {Matters} from '../matters.mjs';

const CLI=fileURLToPath(new URL('../cli.mjs',import.meta.url));
// The CLI runs as its own process against the same store file; async so the in-process fake can answer it.
function cli(config,...args){
 return new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['--disable-warning=ExperimentalWarning',CLI,'--config',config,...args],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));
 });
}
function writeConfig(dir,lark,mode=0o600,extra=''){
 const file=path.join(dir,'butler.env');
 fs.writeFileSync(file,`# butler\nBUTLER_OPEN_LARK_TOKEN="${lark.token}"\nBUTLER_OPEN_LARK_URL=${lark.url}\nBUTLER_LINK_BASE=${LINK_BASE}\nBUTLER_DATA_DIR=${dir}\n${extra}`,{mode});fs.chmodSync(file,mode);return file;
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

test('ignore list commands: add senders by name or id, refuse ambiguous or unknown ones, remove',async t=>{
 const {lark,store,dir}=await setup(t);const config=writeConfig(dir,lark);
 post(store,{sender:'6994621142325526532',name:'Zebra2.0自动化投放平台',type:'bot'});post(store,{sender:'7623741666586840285',name:'赤尾工具人',type:'bot'});
 post(store,{sender:'7000000000000000004',name:'赤尾',type:'bot'});post(store,{sender:'u1',name:'陈帆'});post(store,{mine:true,text:'我发的'});
 let r=await cli(config,'ignore','list');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/忽略名单是空的/);
 r=await cli(config,'ignore','add','Zebra2.0自动化投放平台','7623741666586840285');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/Zebra2\.0自动化投放平台/);assert.match(r.stdout,/赤尾工具人/);
 r=await cli(config,'ignore','add','赤');assert.equal(r.code,1);assert.match(r.stderr,/赤尾工具人/);assert.match(r.stderr,/7000000000000000004/);
 r=await cli(config,'ignore','add','赤尾');assert.equal(r.code,0,'an exact name is not ambiguous');
 r=await cli(config,'ignore','add','王五');assert.equal(r.code,1);assert.match(r.stderr,/没有找到发送方/);
 r=await cli(config,'ignore','add','原智鸿');assert.equal(r.code,1,'I am not a sender to ignore');
 const matters=new Matters(store);
 assert.deepEqual(matters.ignoredSenders().map(s=>s.name).sort(),['Zebra2.0自动化投放平台','赤尾','赤尾工具人'].sort());
 r=await cli(config,'ignore','list');assert.match(r.stdout,/6994621142325526532/);assert.match(r.stdout,/赤尾工具人/);
 r=await cli(config,'ignore','remove','赤尾工具人');assert.equal(r.code,0,r.stderr);
 assert.deepEqual(matters.ignoredSenders().map(s=>s.name).sort(),['Zebra2.0自动化投放平台','赤尾'].sort());
 assert.deepEqual(lark.writes(),[]);
});

// A herdr executable for the CLI: a shell script that runs the fake with its state directory.
function fakeHerdr(dir,script){
 const state=path.join(dir,'herdr');fs.mkdirSync(state);fs.writeFileSync(path.join(state,'script.json'),JSON.stringify(script));
 const bin=path.join(dir,'herdr.sh'),fake=fileURLToPath(new URL('./fake-herdr.mjs',import.meta.url));
 fs.writeFileSync(bin,`#!/bin/sh\nexec "${process.execPath}" "${fake}" "${state}" "$@"\n`,{mode:0o755});return bin;
}

test('process --once turns the backlog into matters through herdr; matters lists them with links',async t=>{
 const {lark,store,dir}=await setup(t);
 const ask=post(store,{text:'@原智鸿 帮忙审批下这个合并请求',categories:['mention','watched']}),noise=post(store,{chat:'g2',name:'李四',text:'收到'});
 const herdr=fakeHerdr(dir,{replies:[{text:JSON.stringify({new:[{title:'审批合并请求',who:'陈帆',ask:'审批 MR',due:null,urgency:'high',messages:['m1']}],updates:[]})}]});
 let r=await cli(writeConfig(dir,lark),'process','--once');assert.equal(r.code,1);assert.match(r.stderr,/BUTLER_MODEL_MACHINE/);
 const config=writeConfig(dir,lark,0o600,`BUTLER_MODEL_MACHINE=cpu1-butler\nBUTLER_MODEL_CWD=/home/me/.local/share/butler-model\nBUTLER_HERDR=${herdr}\n`);
 r=await cli(config,'process','--once');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/模型运行 1 次/);
 assert.match(r.stdout,/整理了 1 个未结束的事项，关掉 0 个/,'no review yet, so the round reviews too');
 r=await cli(config,'matters');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/#1/);assert.match(r.stdout,/审批合并请求/);assert.match(r.stdout,/陈帆/);assert.match(r.stdout,/紧急/);
 assert.ok(r.stdout.includes(store.message(ask).link));
 r=await cli(config,'matters','--json');const [m]=JSON.parse(r.stdout);assert.deepEqual(m.messageIds,[ask]);assert.equal(m.link,store.message(ask).link);
 new Matters(store).apply({created:[],updated:[{matterId:1,messageIds:[noise],changes:{},close:'对方说不用了'}],processedIds:[]});
 r=await cli(config,'matters');assert.match(r.stdout,/没有未结束的事项/);
 r=await cli(config,'matters','--all');assert.match(r.stdout,/已结束：对方说不用了/);
 r=await cli(config,'status');assert.match(r.stdout,/加工：/);assert.match(r.stdout,/待加工 0 条/);assert.match(r.stdout,/未结束的事项 0 个/);assert.match(r.stdout,/跳过 0 条/);
});

test('status shows the bot connection, the last digest and the next one when one is due',async t=>{
 const {lark,store,dir}=await setup(t);
 let r=await cli(writeConfig(dir,lark),'status');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/机器人：没有配置/);
 const config=writeConfig(dir,lark,0o600,'BUTLER_BOT_APP_ID=cli_a1b2c3d4e5f6\nBUTLER_BOT_APP_SECRET=secret-value-never-shown\nBUTLER_BOT_OWNER=ou_owner0000000000000000000000001\n');
 r=await cli(config,'status');assert.match(r.stdout,/机器人：未运行（加工端未运行）/);assert.match(r.stdout,/汇总：还没有发过/);
 assert.doesNotMatch(r.stdout,/secret-value/);
 const now=Date.now(),matters=new Matters(store);
 store.setMeta('processor',{pid:process.pid,startedAt:now,heartbeatAt:now});
 store.setMeta('bot',{state:'connected',since:now-60e3,connectedAt:now-60e3});
 store.setMeta('digest',{at:now-1800e3,slot:now-1800e3,sent:3});
 r=await cli(config,'status');
 assert.match(r.stdout,/机器人：已连接/);assert.match(r.stdout,/汇总：上次 \d{4}-\d\d-\d\d \d\d:\d\d/);assert.match(r.stdout,/下一份：暂无/);
 const id=post(store,{text:'@原智鸿 看下'});matters.apply({created:[{title:'看一下',who:'陈帆',ask:'看',urgency:'normal',messageIds:[id]}],processedIds:[id]});
 r=await cli(config,'status');assert.match(r.stdout,/下一份：\d{4}-\d\d-\d\d \d\d:\d\d/);assert.match(r.stdout,/新事项 1 个/);
 const s=JSON.parse((await cli(config,'status','--json')).stdout);
 assert.equal(s.bot.state,'connected');assert.equal(s.digest.sent,3);assert.equal(typeof s.digest.next,'number');
 store.setMeta('bot',{state:'error',since:now,error:'WebSocket connect failed'});
 r=await cli(config,'status');assert.match(r.stdout,/机器人：连接失败.*WebSocket connect failed/);
});

test('status shows the last review of the open matters and when the next is due; BUTLER_REVIEW_EVERY sets how often',async t=>{
 const {lark,store,dir}=await setup(t);
 let r=await cli(writeConfig(dir,lark),'status');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/整理：还没有整理过/);
 const at=Date.parse('2026-10-27T12:00:00+08:00'),time=ms=>new Date(ms).toLocaleString('sv-SE');
 store.setMeta('review',{at,reviewed:119,closed:80});
 r=await cli(writeConfig(dir,lark),'status');
 assert.ok(r.stdout.includes(`整理：上次 ${time(at)}（119 个未结束的事项，关掉 80 个），下一次在 ${time(at+3*3600e3)} 之后`),r.stdout);
 const every=writeConfig(dir,lark,0o600,'BUTLER_REVIEW_EVERY=90m\n');
 r=await cli(every,'status');assert.ok(r.stdout.includes(`下一次在 ${time(at+90*60e3)} 之后`),r.stdout);
 store.setMeta('review',{at,reviewed:119,closed:80,failedAt:at+4*3600e3,error:'herdr workspace create（cpu1-butler） 失败，退出码 1'});
 r=await cli(every,'status');
 assert.ok(r.stdout.includes(`；${time(at+4*3600e3)} 没有完成，下一轮再试：herdr workspace create`),r.stdout);assert.doesNotMatch(r.stdout,/下一次在/);
 assert.equal(JSON.parse((await cli(every,'status','--json')).stdout).review.everyMs,90*60e3);
 r=await cli(writeConfig(dir,lark,0o600,'BUTLER_REVIEW_EVERY=3 hours\n'),'status');assert.equal(r.code,1);assert.match(r.stderr,/整理事项的间隔的格式不对/);
});

test('status shows 关于TA in one line and profile prints it with my notes; BUTLER_PROFILE_EVERY sets how often it is written',async t=>{
 const {lark,store,dir}=await setup(t),config=writeConfig(dir,lark);
 let r=await cli(config,'status');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/关于TA：还没有写过，加工端的下一轮就写/);
 r=await cli(config,'profile');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/还没有写过「关于TA」/);assert.match(r.stdout,/还没有说明/);
 const at=Date.parse('2026-10-27T12:00:00+08:00'),time=ms=>new Date(ms).toLocaleString('sv-SE'),text='角色：GEO 服务的后端\n通常不归TA：审批';
 const matters=new Matters(store),note=matters.addNote('审批不归我管',at-3600e3);
 store.setMeta('profile',{text,at,notes:[note],messages:243});
 const line=out=>out.split('\n').find(l=>l.startsWith('关于TA：'));
 r=await cli(config,'status');
 assert.equal(line(r.stdout),`关于TA：写于 ${time(at)}（${text.length} 字，根据 243 条我发的消息和 1 条说明），下一次在 ${time(at+86400e3)} 之后，说明有变化时也重写`);
 const every=writeConfig(dir,lark,0o600,'BUTLER_PROFILE_EVERY=12h\n');
 r=await cli(every,'status');assert.ok(line(r.stdout).includes(`下一次在 ${time(at+12*3600e3)} 之后`),r.stdout);
 assert.equal(JSON.parse((await cli(every,'status','--json')).stdout).profile.everyMs,12*3600e3);
 store.setMeta('profile',{text,at,notes:[note],messages:243,failedAt:at+3600e3,error:'模型的回复不是 JSON：x'});
 r=await cli(every,'status');assert.ok(line(r.stdout).endsWith(`；${time(at+3600e3)} 没有写成，下一轮再试：模型的回复不是 JSON：x`),r.stdout);
 r=await cli(every,'profile');assert.equal(r.code,0,r.stderr);
 assert.ok(r.stdout.includes(`关于TA（写于 ${time(at)}，根据 243 条我发的消息和 1 条说明）：\n${text}`),r.stdout);
 assert.ok(r.stdout.includes(`#${note} 审批不归我管（${time(at-3600e3)}）`),r.stdout);
 const j=JSON.parse((await cli(every,'profile','--json')).stdout);
 assert.equal(j.profile.text,text);assert.deepEqual(j.notes.map(n=>[n.id,n.text]),[[note,'审批不归我管']]);
 r=await cli(writeConfig(dir,lark,0o600,'BUTLER_PROFILE_EVERY=1 day\n'),'status');assert.equal(r.code,1);assert.match(r.stderr,/写「关于TA」的间隔的格式不对/);
});

test('bot create refuses to replace a configured bot',async t=>{
 const {lark,dir}=await setup(t);
 const config=writeConfig(dir,lark,0o600,'BUTLER_BOT_APP_ID=cli_a1b2c3d4e5f6\nBUTLER_BOT_APP_SECRET=s\nBUTLER_BOT_OWNER=ou_owner0000000000000000000000001\n');
 const r=await cli(config,'bot','create');assert.equal(r.code,1);assert.match(r.stderr,/已经配置/);assert.match(r.stderr,/cli_a1b2c3d4e5f6/);
});
