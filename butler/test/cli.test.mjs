import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setup,waitFor,sleep,post,LINK_BASE} from './helpers.mjs';
import {Matters,NOT_MINE} from '../matters.mjs';
import {Topics} from '../topics.mjs';
import {Processor} from '../processor.mjs';
import {Grader} from '../grader.mjs';
import {Digests} from '../digest.mjs';
import {DEFAULT_SCHEDULE} from '../schedule.mjs';
import {dayOf,startOf,nextDay} from '../reading.mjs';

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

test('level commands: set by name or id, refuse ambiguous names and unknown levels, clear mine; groups shows each group\'s level',async t=>{
 const {lark,store,dir}=await setup(t);const config=writeConfig(dir,lark);
 const project=lark.chat({name:'项目群',memberCount:42}),a=lark.chat({name:'测试群A'}),b=lark.chat({name:'测试群B',memberCount:7});lark.chat({name:'张三',chatMode:'direct'});
 let r=await cli(config,'groups');assert.equal(r.code,0,r.stderr);
 for(const name of ['项目群','测试群A','测试群B'])assert.match(r.stdout,new RegExp(name));assert.doesNotMatch(r.stdout,/张三/);assert.match(r.stdout,/42/);
 assert.match(r.stdout.split('\n').find(l=>l.includes('项目群')),/^未分级（按只存不看） /);
 r=await cli(config,'level');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/还没有聊天有级别/);assert.match(r.stdout,/没有级别的私聊按即时.*群按只存不看/);
 r=await cli(config,'level','set','instant','项目群');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/项目群：未分级（按只存不看） → 即时（我定的）/);
 r=await cli(config,'level','set','instant','测试群');assert.equal(r.code,1);assert.match(r.stderr,/测试群A/);assert.match(r.stderr,/测试群B/);
 r=await cli(config,'level','set','watched','项目群');assert.equal(r.code,1);assert.match(r.stderr,/instant daily store ignore/);
 r=await cli(config,'level','set','ignore',b);assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/测试群B：未分级（按只存不看） → 忽略（我定的）/);
 assert.deepEqual(store.levels().map(l=>[l.feedId,l.level,l.by]),[[project,'instant','owner'],[b,'ignore','owner']]);
 assert.ok(Math.abs(store.level(project).since-Date.now())<60e3,'instant from when it was set');
 r=await cli(config,'level','list');assert.match(r.stdout,/即时（我定的）\s+项目群/);assert.match(r.stdout,/忽略（我定的）\s+测试群B/);assert.doesNotMatch(r.stdout,/测试群A/);
 r=await cli(config,'groups');assert.match(r.stdout.split('\n').find(l=>l.includes('项目群')),/^即时（我定的） /);
 r=await cli(config,'groups','--json');assert.equal(JSON.parse(r.stdout).find(g=>g.feedId===project).level.level,'instant');
 r=await cli(config,'level','clear','项目群');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/项目群：即时（我定的） → 未分级（按只存不看）\n/);
 assert.deepEqual(store.levels().map(l=>l.feedId),[b]);
 r=await cli(config,'level','clear','测试群A');assert.equal(r.code,1,'only a level I set is cleared');assert.match(r.stderr,/没有找到/);
 // A bot's direct chat goes by its level, which is instant until it is graded; a topic group is set with a warning:
 // butler does not read it by position.
 store.upsertChatInfo({feedId:'oc_bits',name:'Bits',chatMode:'direct'});
 r=await cli(config,'level','set','store','Bits');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/Bits：未分级（按即时） → 只存不看（我定的）/);
 assert.equal(store.level('oc_bits').level,'store');
 r=await cli(config,'level','clear','Bits');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/Bits：只存不看（我定的） → 未分级（按即时）\n/);
 r=await cli(config,'level','set','instant','Bits');assert.equal(r.code,0,r.stderr);assert.equal(store.level('oc_bits').level,'instant');
 const topic=lark.chat({name:'需求讨论',chatMode:'topic'});
 r=await cli(config,'level','set','instant','需求讨论');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/是话题群/);assert.equal(store.instantSince(topic)>0,true);
 r=await cli(config,'level','set','instant',b);assert.doesNotMatch(r.stdout,/是话题群/);assert.match(r.stdout,/忽略（我定的） → 即时（我定的）/);
 assert.ok(a);assert.deepEqual(lark.writes(),[]);
});

test('level history lists the changes of levels, the latest first, with who made them and why; my corrections are counted',async t=>{
 const {lark,store,dir}=await setup(t);const config=writeConfig(dir,lark),hour=3600e3,now=Date.now();
 store.upsertChatInfo({feedId:'g1',name:'项目群',chatMode:'group'});
 store.setLevel('g1','store',{by:'model',reason:'多是转发',now:now-3*hour});store.setLevel('g1','instant',{by:'owner',now:now-2*hour});
 store.setLevel('g2','daily',{by:'model',reason:'有讨论',now:now-10*24*hour});
 let r=await cli(config,'level','history');assert.equal(r.code,0,r.stderr);
 const lines=r.stdout.trim().split('\n');
 assert.match(lines[0],/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d  项目群：只存不看 → 即时（我定的）  我改的  g1$/);
 assert.match(lines[1],/^\d{4}-.*  项目群：未分级（按只存不看） → 只存不看  模型改的  理由：多是转发  g1$/);
 assert.equal(lines.at(-1),'最近 7 天共 2 次改动：我改了 1 次（其中纠正 1 次），模型改了 1 次');
 assert.doesNotMatch(r.stdout,/有讨论/,'a week by default');
 r=await cli(config,'level','history','--since','30d');assert.match(r.stdout,/g2：未分级（按只存不看） → 每日  模型改的  理由：有讨论/);assert.match(r.stdout,/^从 .* 起共 3 次改动/m);
 r=await cli(config,'level','history','--since','1m');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/这段时间没有级别的改动/);
 r=await cli(config,'level','history','--json');assert.equal(r.code,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stdout).map(c=>[c.feedId,c.name,c.by,c.before,c.after,c.reason,c.correction]),
  [['g1','项目群','owner',{level:'store',by:'model'},{level:'instant',by:'owner'},null,true],['g1','项目群','model',null,{level:'store',by:'model'},'多是转发',false]],'the latest first, as in text');
 r=await cli(config,'level','history','--since','1m','--json');assert.deepEqual(JSON.parse(r.stdout),[]);
});

test('status and list show what the collector recorded',async t=>{
 const {lark,store,dir,running}=await setup(t);const config=writeConfig(dir,lark);
 const group=lark.chat({name:'大群'}),dm=lark.chat({name:'张三',chatMode:'direct'});
 const c=await running();const at=lark.post(group,{atMe:true,text:'请看下'}),d=lark.post(dm,{text:'私聊内容'});
 await waitFor(()=>store.message(at.id)?.chatName&&store.message(d.id));c.flushStatus();
 let r=await cli(config,'status');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/推送：已连接/);assert.match(r.stdout,/对账/);assert.match(r.stdout,/live/);assert.match(r.stdout,/mention 1/);assert.match(r.stdout,/dm 1/);
 assert.match(r.stdout,/聊天级别：即时 0 个、每日 0 个、只存不看 0 个、忽略 0 个（我定的 0 个），没有级别的私聊按即时、群按只存不看/);
 r=await cli(config,'status','--json');const s=JSON.parse(r.stdout);assert.equal(s.events.connected,true);assert.equal(s.counts.total,2);
 store.setLevel(group,'instant',{by:'owner'});store.setLevel(dm,'store',{by:'model',reason:'x'});
 r=await cli(config,'status');assert.match(r.stdout,/聊天级别：即时 1 个、每日 0 个、只存不看 1 个、忽略 0 个（我定的 1 个）/);
 r=await cli(config,'status','--json');assert.deepEqual(JSON.parse(r.stdout).levels,{instant:1,daily:0,store:1,ignore:0,owner:1});
 r=await cli(config,'list','--category','mention');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/请看下/);assert.match(r.stdout,/大群/);assert.doesNotMatch(r.stdout,/私聊内容/);
 assert.ok(r.stdout.includes(`${LINK_BASE}/messenger/${group}?message=${at.id}`));
 r=await cli(config,'list','--json','--since','1h');const items=JSON.parse(r.stdout);
 assert.deepEqual(items.map(i=>i.id).sort(),[at.id,d.id].sort());assert.ok(items.every(i=>i.link&&Array.isArray(i.categories)&&i.chatName));
 r=await cli(config,'list','--category','nope');assert.equal(r.code,1);
 const chatter=lark.post(lark.chat({name:'闲聊群'}),{text:'和我无关的闲聊'});await waitFor(()=>store.message(chatter.id));
 r=await cli(config,'list','--category','stored');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/和我无关的闲聊/);assert.match(r.stdout,/\[stored\]/);
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
 r=await cli(config,'ignore','--json');assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[]);
 r=await cli(config,'ignore','add','Zebra2.0自动化投放平台','7623741666586840285');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/^Zebra2\.0自动化投放平台（6994621142325526532）：没有忽略 → 忽略，之后它的消息不再交给模型$/m);assert.match(r.stdout,/赤尾工具人/);
 r=await cli(config,'ignore','add','赤');assert.equal(r.code,1);assert.match(r.stderr,/赤尾工具人/);assert.match(r.stderr,/7000000000000000004/);
 r=await cli(config,'ignore','add','赤尾','--json');assert.equal(r.code,0,'an exact name is not ambiguous');
 let [x]=JSON.parse(r.stdout);assert.deepEqual([x.senderId,x.name,x.before,x.after.senderId,x.after.name,typeof x.after.since],['7000000000000000004','赤尾',null,'7000000000000000004','赤尾','number']);
 r=await cli(config,'ignore','add','赤尾','--json');[x]=JSON.parse(r.stdout);assert.deepEqual(x.before,x.after,'on the list already: nothing changes');
 r=await cli(config,'ignore','add','赤尾');assert.match(r.stdout,/^赤尾（7000000000000000004）：已经在忽略名单上，没有改动$/m);
 r=await cli(config,'ignore','add','王五');assert.equal(r.code,1);assert.match(r.stderr,/没有找到发送方/);
 r=await cli(config,'ignore','add','原智鸿');assert.equal(r.code,1,'I am not a sender to ignore');
 const matters=new Matters(store);
 assert.deepEqual(matters.ignoredSenders().map(s=>s.name).sort(),['Zebra2.0自动化投放平台','赤尾','赤尾工具人'].sort());
 r=await cli(config,'ignore','list');assert.match(r.stdout,/6994621142325526532/);assert.match(r.stdout,/赤尾工具人/);
 r=await cli(config,'ignore','list','--json');assert.deepEqual(JSON.parse(r.stdout).map(s=>Object.keys(s).sort()),Array(3).fill(['name','senderId','since']));
 r=await cli(config,'ignore','remove','赤尾工具人','--json');assert.equal(r.code,0,r.stderr);
 [x]=JSON.parse(r.stdout);assert.deepEqual([x.senderId,x.before.name,x.after],['7623741666586840285','赤尾工具人',null]);
 r=await cli(config,'ignore','remove','赤尾');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/^赤尾（7000000000000000004）：忽略 → 没有忽略，之后的新消息照常交给模型$/m);
 r=await cli(config,'ignore','add','赤尾');assert.equal(r.code,0,r.stderr);
 assert.deepEqual(matters.ignoredSenders().map(s=>s.name).sort(),['Zebra2.0自动化投放平台','赤尾'].sort());
 assert.deepEqual(lark.writes(),[]);
});

test('level set takes my reason, kept with my level; level list, set and clear print what they show as JSON with --json',async t=>{
 const {lark,store,dir}=await setup(t);const config=writeConfig(dir,lark);
 store.upsertChatInfo({feedId:'g1',name:'项目群',chatMode:'group'});store.upsertChatInfo({feedId:'t1',name:'需求讨论',chatMode:'topic'});
 store.setLevel('g1','store',{by:'model',reason:'多是转发'});
 let r=await cli(config,'level','list','--json');assert.equal(r.code,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stdout).map(l=>[l.feedId,l.name,l.chatMode,l.level,l.by,l.reason]),[['g1','项目群','group','store','model','多是转发']]);
 r=await cli(config,'level','set','daily','项目群','--reason','  我要每天\n看一眼 ');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/^项目群：只存不看 → 每日（我定的），理由：我要每天 看一眼，从 /m);
 assert.deepEqual([store.level('g1').level,store.level('g1').by,store.level('g1').reason,store.level('g1').modelReason],['daily','owner','我要每天 看一眼','多是转发']);
 r=await cli(config,'level','set','daily','项目群');assert.equal(r.code,0,r.stderr);
 assert.equal(r.stdout,'项目群：已经是我定的每日，没有改动\n');assert.equal(store.level('g1').reason,'我要每天 看一眼','my reason stays');
 r=await cli(config,'level','set','daily','项目群','--reason','换个理由','--json');assert.equal(r.code,0,r.stderr);
 let [x]=JSON.parse(r.stdout);
 assert.deepEqual([x.feedId,x.name,x.chatMode,x.before.level,x.before.reason,x.after.level,x.after.by,x.after.reason,x.after.modelLevel],['g1','项目群','group','daily','我要每天 看一眼','daily','owner','换个理由','store']);
 assert.equal(store.levelChanges(0).length,2,'a new reason alone is no change of level');
 r=await cli(config,'level','set','instant','需求讨论','--json');[x]=JSON.parse(r.stdout);
 assert.deepEqual([x.before,x.after.level,x.after.reason],[null,'instant',null]);assert.match(x.warning,/话题群/,'the topic-group caveat');
 r=await cli(config,'level','set','store','项目群','--reason','');assert.equal(r.code,1);assert.match(r.stderr,/--reason/);
 r=await cli(config,'level','set','store','项目群','--reason','长'.repeat(201));assert.equal(r.code,1);assert.match(r.stderr,/200/);
 r=await cli(config,'level','clear','项目群','需求讨论','--json');assert.equal(r.code,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stdout).map(c=>[c.feedId,c.before.level,c.after?.level??null,c.after?.by??null]),[['g1','daily','store','model'],['t1','instant',null,null]]);
 r=await cli(config,'level','--json');assert.deepEqual(JSON.parse(r.stdout).map(l=>[l.feedId,l.level,l.by]),[['g1','store','model']]);
});

// The rows of a digest card: the matters it lists.
const listed=card=>card.body.elements.filter(e=>e.tag==='column_set').map(e=>e.columns[2].elements[0].behaviors[0].value.matter);

test('matters close and reopen a matter by number as mine, saying what changed; the running processor brings the latest digest up to date within a quick check',async t=>{
 const {lark,store,dir}=await setup(t),config=writeConfig(dir,lark),matters=new Matters(store),now=Date.now();
 const made=(title,urgency)=>{const id=post(store,{text:title,at:now-600e3});return matters.apply({created:[{title,who:'陈帆',ask:title,urgency,messageIds:[id]}],processedIds:[id]})[0];};
 const a=made('填开发进展文档','high'),b=made('看 GEO 数据','normal');
 // The service as cli.mjs wires it: the processor tells the digests, which update the latest digest in place. 关于TA
 // and the review are up to date, so no model is asked.
 const bot={connected:true,updated:[],async toOwner(){return {messageId:'om_new'};},async updateCard(messageId,card){bot.updated.push({messageId,card});}};
 store.setMeta('digest',{at:now-60e3,slot:now-60e3,sent:1,messageId:'om_digest'});
 store.setMeta('profile',{text:'【工作】\n角色：后端',at:now,notes:[],messages:1});store.setMeta('review',{at:now,reviewed:2,closed:0,profileAt:now,notes:[]});
 const digests=new Digests({store,matters,bot,schedule:DEFAULT_SCHEDULE,refreshDelayMs:10});
 const processor=new Processor({store,matters,model:{async ask(){throw Error('no model run expected');}},options:{everyMs:3600e3,ownerCheckMs:20},onMattersChanged:()=>digests.refresh()});
 await processor.start();t.after(async()=>{await processor.stop();await digests.stop();});

 let r=await cli(config,'matters','close',String(a),'--reason','已经填完了');assert.equal(r.code,0,r.stderr);
 assert.equal(r.stdout,`#${a} 填开发进展文档：未结束 → 已结束：你关掉的：已经填完了\n`);
 assert.deepEqual([matters.matter(a).status,matters.matter(a).closedBy,matters.matter(a).reason],['closed','owner','已经填完了'],'closed by me, as the card\'s 完成 does');
 await waitFor(()=>bot.updated.length===1,{message:'the latest digest brought up to date'});
 assert.equal(bot.updated[0].messageId,'om_digest');assert.deepEqual(listed(bot.updated[0].card),[b]);
 r=await cli(config,'matters','close',`#${a}`);assert.equal(r.code,0,r.stderr);
 assert.equal(r.stdout,`#${a} 填开发进展文档：已经结束了（你关掉的：已经填完了），没有改动\n`);
 await sleep(100);assert.equal(bot.updated.length,1,'nothing changed: no update');
 r=await cli(config,'matters','reopen',String(a),'--json');assert.equal(r.code,0,r.stderr);
 let j=JSON.parse(r.stdout);
 assert.deepEqual([j.before.id,j.before.status,j.before.closedBy,j.before.reason,j.after.status,j.after.closedBy,j.after.reason],[a,'closed','owner','已经填完了','open',null,null]);
 await waitFor(()=>bot.updated.length===2,{message:'the digest follows the reopened matter'});assert.deepEqual(listed(bot.updated[1].card),[a,b]);
 r=await cli(config,'matters','reopen',String(a));assert.equal(r.stdout,`#${a} 填开发进展文档：没有结束，没有改动\n`);
 r=await cli(config,'matters','close',String(b),'--reason',NOT_MINE,'--json');j=JSON.parse(r.stdout);
 assert.deepEqual([j.before.status,j.after.status,j.after.closedBy,j.after.reason],['open','closed','owner',NOT_MINE]);
 assert.deepEqual(matters.notMine(20).map(m=>m.id),[b],'closed as not mine, as the card\'s 不归我 does');
 r=await cli(config,'matters','reopen',String(b));assert.equal(r.stdout,`#${b} 看 GEO 数据：已结束：你关掉的：不归我 → 未结束\n`);
 r=await cli(config,'matters','list','--json');assert.deepEqual(JSON.parse(r.stdout).map(m=>m.id),[a,b]);
 for(const args of [['close','99'],['reopen','99']]){r=await cli(config,'matters',...args);assert.equal(r.code,1);assert.match(r.stderr,/没有 #99 这个事项/);}
 for(const args of [['close'],['close','abc'],['reopen']]){r=await cli(config,'matters',...args);assert.equal(r.code,1,args.join(' '));assert.match(r.stderr,/编号/);}
 r=await cli(config,'matters','close',String(a),'--reason','长'.repeat(201));assert.equal(r.code,1);assert.match(r.stderr,/200/);assert.equal(matters.matter(a).status,'open');
 r=await cli(config,'matters','finish',String(a));assert.equal(r.code,1);assert.match(r.stderr,/matters 没有这个操作/);
 await processor.stop();await digests.stop();
});

test('notes: my notes in my words, listed, added and removed by number; one from the command line is what any note is: 关于TA is written again with it, the open matters are reviewed, and grading takes it in',async t=>{
 const {lark,store,dir}=await setup(t),config=writeConfig(dir,lark),matters=new Matters(store),now=Date.now(),before=now-60e3;
 // The processor and grading have seen my notes as they were (none); an open matter for the review to judge, and a
 // message of mine to write 关于TA from once no note is left.
 const id=post(store,{text:'@原智鸿 帮忙审批',at:before}),mine=post(store,{mine:true,text:'GEO 的接口我来看',at:before});
 matters.apply({created:[{title:'审批预算',who:'陈帆',ask:'审批',urgency:'normal',messageIds:[id]}],processedIds:[id,mine]});
 store.setMeta('profile',{text:'【工作】\n角色：后端',at:before,notes:[],messages:1});store.setMeta('review',{at:before,reviewed:1,closed:0,profileAt:before,notes:[]});
 const calls=[],model={async ask({prompt}){const d=JSON.parse(prompt.slice(prompt.indexOf('{')));calls.push(d);return JSON.stringify(d.matters?{updates:[]}:{work:'角色：后端',interests:'',added:[]});}};
 const kinds=()=>calls.map(d=>d.matters?'review':d.openMatters?'batch':'profile');
 let clock=now;const processor=new Processor({store,matters,model}),grader=new Grader({store,matters,now:()=>clock});
 grader.check();assert.deepEqual(store.meta('grading').notes,[]);

 let r=await cli(config,'notes');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/还没有说明/);assert.match(r.stdout,/notes add/);
 r=await cli(config,'notes','list','--json');assert.deepEqual(JSON.parse(r.stdout),[]);
 r=await cli(config,'notes','add','审批不归我管');assert.equal(r.code,0,r.stderr);
 const [note]=matters.notes();assert.equal(note.text,'审批不归我管');
 assert.match(r.stdout,new RegExp(`^已记下说明 #${note.id}：审批不归我管。`));assert.match(r.stdout,/关于TA/);assert.match(r.stdout,/重新给聊天分级/);
 r=await cli(config,'notes','add','审批不归我管','--json');assert.deepEqual(JSON.parse(r.stdout),{before:note,after:note},'the same words again: nothing new');
 assert.equal(matters.notes().length,1);
 await processor.runOnce();
 assert.deepEqual(kinds(),['profile','review'],'关于TA written again with it, then the open matters reviewed by it');
 assert.deepEqual([calls[0].notes,calls[1].notes],[['审批不归我管'],['审批不归我管']]);assert.deepEqual(store.meta('profile').notes,[note.id]);
 grader.check();assert.deepEqual([store.meta('grading').notes,store.meta('grading').notesAt],[[note.id],now],'grading grades the chats again once the notes have stood');

 r=await cli(config,'notes','add','值班群','都不看','--json');assert.equal(r.code,0,r.stderr);
 const added=JSON.parse(r.stdout);assert.deepEqual([added.before,added.after.text,typeof added.after.id,typeof added.after.at],[null,'值班群 都不看','number','number']);
 r=await cli(config,'notes');assert.match(r.stdout,new RegExp(`^#${note.id} 审批不归我管（`,'m'));assert.match(r.stdout,new RegExp(`^#${added.after.id} 值班群 都不看（`,'m'));
 r=await cli(config,'notes','--json');assert.deepEqual(JSON.parse(r.stdout).map(n=>[n.id,n.text]),[[note.id,'审批不归我管'],[added.after.id,'值班群 都不看']]);
 r=await cli(config,'notes','remove',`#${note.id}`);assert.equal(r.code,0,r.stderr);assert.match(r.stdout,new RegExp(`^已删除说明 #${note.id}：审批不归我管。`));
 r=await cli(config,'notes','remove',String(added.after.id),'--json');assert.deepEqual(JSON.parse(r.stdout),{before:added.after,after:null});
 assert.deepEqual(matters.notes(),[]);
 calls.length=0;await processor.runOnce();
 assert.deepEqual(kinds(),['profile','review'],'removing does the same');assert.deepEqual(calls[0].notes,[]);
 clock=now+60e3;grader.check();assert.deepEqual([store.meta('grading').notes,store.meta('grading').notesAt],[[],now+60e3]);

 r=await cli(config,'notes','remove','9');assert.equal(r.code,1);assert.match(r.stderr,/没有说明 #9/);
 for(const args of [['add'],['add','  '],['remove'],['remove','x']]){r=await cli(config,'notes',...args);assert.equal(r.code,1,args.join(' '));}
 r=await cli(config,'notes','add','长'.repeat(201));assert.equal(r.code,1);assert.match(r.stderr,/200/);
 r=await cli(config,'notes','edit','1');assert.equal(r.code,1);assert.match(r.stderr,/notes 没有这个操作/);
 r=await cli(config,'profile');assert.match(r.stdout,/notes add/,'where notes come from now');assert.doesNotMatch(r.stdout,/私聊/);
});

// A local time of a day (YYYY-MM-DD), hh:mm, and as the command line prints it.
const on=(day,hm)=>{const [h,m]=hm.split(':').map(Number);return startOf(day)+h*3600e3+m*60e3;};
const shown=ms=>new Date(ms).toLocaleString('sv-SE');
// Someone else's message in chat that the collector only kept.
const said=(store,chat,text,day,hm,more)=>post(store,{chat,sender:'u5',name:'王五',text,at:on(day,hm),categories:['stored'],...more});
// Topics the daily read made of a day, as it stores them (created: each feedId, title, summary, area, picked, reason,
// messageIds), and the chats it read that day; returns their numbers.
const made=(topics,day,created,read=[])=>topics.apply({day,created,read:read.map(feedId=>({feedId,level:'daily',messages:1,done:true}))});
// The topic numbers a topics listing shows, in order.
const numbered=out=>[...out.matchAll(/^#(\d+) /gm)].map(x=>Number(x[1]));

test('topics lists the daily read\'s topics by chat, by day or days, by words and by pick, the latest day first, each with its link',async t=>{
 const {lark,store,dir}=await setup(t),config=writeConfig(dir,lark),topics=new Topics(store);
 const m1=said(store,'g1','接口方案评审定在周五','2026-11-03','10:00'),m2=post(store,{chat:'g1',mine:true,text:'我会准备材料',at:on('2026-11-03','10:05'),categories:['own']});
 const m3=said(store,'g1','中午吃啥','2026-11-04','12:00'),m4=said(store,'g2','GEO 数据周报出来了','2026-11-04','09:00'),m5=said(store,'g2','周报里提到 Redis 迁移','2026-11-04','09:10');
 const m6=said(store,'g2','周六团建去爬山','2026-11-05','15:00');
 const [a]=made(topics,'2026-11-03',[{feedId:'g1',title:'接口方案评审',summary:'评审定在周五，TA准备材料',area:'work',picked:true,reason:'TA负责的接口',messageIds:[m1,m2]}]);
 const [b,c]=made(topics,'2026-11-04',[{feedId:'g1',title:'午饭',summary:'中午吃什么',area:'other',picked:false,reason:'闲聊',messageIds:[m3]},
  {feedId:'g2',title:'GEO 周报',summary:'本周的数据',area:'work',picked:false,reason:'例行通知',messageIds:[m4,m5]}]);
 const [d]=made(topics,'2026-11-05',[{feedId:'g2',title:'团建',summary:'周六去爬山',area:'interest',picked:true,reason:'TA喜欢爬山',messageIds:[m6]}]);
 let r=await cli(config,'topics');assert.equal(r.code,0,r.stderr);
 assert.deepEqual(numbered(r.stdout),[d,b,c,a],'the latest day first, in the order made within a day');
 assert.ok(r.stdout.includes(`#${a} 2026-11-03 项目群：接口方案评审（挑出 · 工作）\n  评审定在周五，TA准备材料\n  理由：TA负责的接口 · 2 条消息\n  ${store.message(m1).link}\n`),r.stdout);
 assert.ok(r.stdout.includes(`#${c} 2026-11-04 大群：GEO 周报（没挑 · 工作）\n`),r.stdout);assert.ok(r.stdout.includes(`#${d} 2026-11-05 大群：团建（挑出 · 兴趣）\n`),r.stdout);
 assert.doesNotMatch(r.stdout,/共 \d+ 个话题/,'all of them are listed');
 r=await cli(config,'topics','项目群');assert.equal(r.code,0,r.stderr);assert.deepEqual(numbered(r.stdout),[b,a]);
 r=await cli(config,'topics','--day','2026-11-04');assert.deepEqual(numbered(r.stdout),[b,c]);
 r=await cli(config,'topics','--since','2026-11-04','--until','2026-11-05');assert.deepEqual(numbered(r.stdout),[b,c],'the days that start before until');
 r=await cli(config,'topics','--since','2026-11-04');assert.deepEqual(numbered(r.stdout),[d,b,c]);
 r=await cli(config,'topics','g2','--since','2026-11-04');assert.deepEqual(numbered(r.stdout),[d,c]);
 r=await cli(config,'topics','--search','redis');assert.deepEqual(numbered(r.stdout),[c],'the words of its messages too, in any case');
 r=await cli(config,'topics','--search','评审');assert.deepEqual(numbered(r.stdout),[a]);r=await cli(config,'topics','--search','爬山');assert.deepEqual(numbered(r.stdout),[d]);
 r=await cli(config,'topics','--picked');assert.deepEqual(numbered(r.stdout),[d,a]);r=await cli(config,'topics','--not-picked');assert.deepEqual(numbered(r.stdout),[b,c]);
 r=await cli(config,'topics','--limit','1');assert.deepEqual(numbered(r.stdout),[d]);assert.match(r.stdout,/共 4 个话题，只列出了 1 个/);
 r=await cli(config,'topics','--day','2026-11-04','--json');assert.equal(r.code,0,r.stderr);
 const [x]=JSON.parse(r.stdout);
 assert.deepEqual(x,{id:b,day:'2026-11-04',chatId:'g1',chatName:'项目群',title:'午饭',summary:'中午吃什么',area:'other',picked:false,reason:'闲聊',messageIds:[m3],link:store.message(m3).link,at:x.at,updatedAt:x.updatedAt});
 r=await cli(config,'topics','--day','2026-11-01');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/没有符合条件的话题/);assert.match(r.stdout,/butler messages/);
 r=await cli(config,'topics','--day','2026-11-01','--json');assert.deepEqual(JSON.parse(r.stdout),[]);
 for(const [args,error] of [[['不存在的群'],/没有找到聊天/],[['--day','2026-13-01'],/--day/],[['--day','2026-11-04','--since','1d'],/--day/],[['--picked','--not-picked'],/只能用一个/],
  [['--limit','0'],/--limit/],[['项目群','大群'],/一个聊天/]]){
  r=await cli(config,'topics',...args);assert.equal(r.code,1,args.join(' '));assert.match(r.stderr,error);
 }
});

test('messages reads a chat\'s own messages, whole and oldest first, of a day or a time span, with given words in them, the latest when there are more than the limit',async t=>{
 const {lark,store,dir}=await setup(t),config=writeConfig(dir,lark);
 const long=`接口的 API 文档在这里，${'细节'.repeat(150)}`;
 const a=said(store,'g1','早上好','2026-11-04','00:30'),b=said(store,'g1',long,'2026-11-04','09:00'),c=said(store,'g1','下班了','2026-11-04','23:50');
 // An ignored sender's message is read too: the agent reads a chat to answer me, not to make matters.
 const d=said(store,'g1','投放完成','2026-11-04','12:00',{sender:'zebra',name:'Zebra',type:'bot'});new Matters(store).ignore('zebra','Zebra');
 const e=said(store,'g1','第二天','2026-11-05','01:00');said(store,'g2','大群的消息','2026-11-04','10:00');
 const line=(id,who,text)=>`${shown(store.message(id).createdAt)}  ${who}：${text}\n  ${store.message(id).link}\n`;
 const order=out=>out.split('\n').filter(l=>/^\d{4}-/.test(l)).map(l=>l.slice(21).split('：')[1].slice(0,4));
 let r=await cli(config,'messages','项目群','--day','2026-11-04');assert.equal(r.code,0,r.stderr);
 assert.ok(r.stdout.startsWith('项目群（2026-11-04 00:00:00 起，2026-11-05 00:00:00 前）的消息：共 4 条，从早到晚：\n'),r.stdout);
 assert.ok(r.stdout.includes(line(a,'王五','早上好')+line(b,'王五',long)+line(d,'Zebra','投放完成')+line(c,'王五','下班了')),r.stdout);
 r=await cli(config,'messages','项目群','--since','2026-11-04','--until','2026-11-05');assert.equal(r.code,0,r.stderr);
 assert.deepEqual(order(r.stdout),['早上好','接口的 ','投放完成','下班了'],'a date alone is that day\'s local midnight');
 r=await cli(config,'messages','g1','--day','2026-11-04','--search','api');assert.equal(r.code,0,r.stderr);
 assert.ok(r.stdout.startsWith('项目群（2026-11-04 00:00:00 起，2026-11-05 00:00:00 前）含「api」的消息：共 1 条，从早到晚：\n'),r.stdout);assert.ok(r.stdout.includes(line(b,'王五',long)));
 r=await cli(config,'messages','项目群','--day','2026-11-04','--limit','2');
 assert.ok(r.stdout.startsWith('项目群（2026-11-04 00:00:00 起，2026-11-05 00:00:00 前）的消息：共 4 条，下面是最近的 2 条，从早到晚：\n'),r.stdout);
 assert.deepEqual(order(r.stdout),['投放完成','下班了']);
 r=await cli(config,'messages','项目群');assert.ok(r.stdout.startsWith('项目群的消息：共 5 条，从早到晚：\n'),r.stdout);assert.equal(order(r.stdout).at(-1),'第二天');
 r=await cli(config,'messages','项目群','--day','2026-11-04','--json');assert.equal(r.code,0,r.stderr);
 const j=JSON.parse(r.stdout);assert.deepEqual(j.map(m=>m.id),[a,b,d,c]);assert.deepEqual([j[1].text,j[1].link,j[1].senderName,j[1].chatName],[long,store.message(b).link,'王五','项目群']);
 r=await cli(config,'messages','项目群','--day','2026-11-01');assert.equal(r.code,0,r.stderr);assert.equal(r.stdout,'项目群（2026-11-01 00:00:00 起，2026-11-02 00:00:00 前）的消息：没有\n');
 for(const [args,error] of [[[],/聊天名或 id/],[['不存在的群'],/没有找到聊天/],[['项目群','--day','2026-11-04','--until','1h'],/--day/],[['项目群','--limit','abc'],/--limit/],
  [['项目群','--since','2026-02-30'],/--since/],[['项目群','大群'],/一个聊天/]]){
  r=await cli(config,'messages',...args);assert.equal(r.code,1,args.join(' '));assert.match(r.stderr,error);
 }
 assert.ok(e);
});

test('corrections: what I say of the read\'s picks in my words, on a topic or on a chat and a day no topic holds; a topic shows the latest, and its pick goes by it; listed and removed by number',async t=>{
 const {lark,store,dir}=await setup(t),config=writeConfig(dir,lark),topics=new Topics(store);
 const [a,b,c]=made(topics,'2026-11-04',[
  {feedId:'g1',title:'接口方案评审',summary:'评审定在周五',area:'work',picked:true,reason:'TA负责的接口',messageIds:[said(store,'g1','评审定在周五','2026-11-04','10:00')]},
  {feedId:'g1',title:'午饭',summary:'中午吃什么',area:'other',picked:false,reason:'闲聊',messageIds:[said(store,'g1','中午吃啥','2026-11-04','12:00')]},
  {feedId:'g2',title:'GEO 周报',summary:'本周的数据',area:'work',picked:true,reason:'TA的项目',messageIds:[said(store,'g2','GEO 周报','2026-11-04','09:00')]}],['g1','g2']);
 said(store,'g2','李四说 Redis 迁移下周做','2026-11-04','15:00');post(store,{chat:'d1',sender:'u3',name:'张三',text:'明天开个会',at:on('2026-11-04','16:00')});
 const A=`话题 #${a} 接口方案评审（项目群 2026-11-04）`;
 let r=await cli(config,'corrections');assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/还没有纠正/);
 r=await cli(config,'corrections','list','--json');assert.deepEqual(JSON.parse(r.stdout),[]);
 r=await cli(config,'corrections','unpick',String(a),'这是别的组的事');assert.equal(r.code,0,r.stderr);
 assert.equal(r.stdout,`${A}：模型挑出 → 我说不该挑（纠正 #1）：这是别的组的事\n`);
 r=await cli(config,'corrections','unpick',`#${a}`,'这是别的组的事');assert.equal(r.stdout,`${A}：已经记过同样的纠正 #1，没有改动\n`);
 r=await cli(config,'corrections','unpick',String(a),'这是别的组的事','--json');let j=JSON.parse(r.stdout);
 assert.deepEqual(j.before,j.after,'the same words again: nothing new');assert.equal(j.after.correction.id,1);
 r=await cli(config,'corrections','pick',String(b),'午饭的事','我也要知道','--json');assert.equal(r.code,0,r.stderr);j=JSON.parse(r.stdout);
 assert.deepEqual([j.before.id,j.before.picked,j.before.correction,j.after.picked],[b,false,undefined,false],'the model\'s pick stays as it was');
 assert.deepEqual(j.after.correction,{id:2,kind:'pick',topicId:b,day:'2026-11-04',chatId:'g1',chatName:'项目群',words:'午饭的事 我也要知道',at:j.after.correction.at});
 r=await cli(config,'corrections','pick',String(c),'本来就该挑');assert.equal(r.code,0,r.stderr);
 assert.equal(r.stdout,`话题 #${c} GEO 周报（大群 2026-11-04）：模型已经挑出了它，不用纠正，没有改动\n`);
 r=await cli(config,'topics','--picked');assert.deepEqual(numbered(r.stdout),[b,c],'as I said, else as the model did');
 r=await cli(config,'topics','--not-picked');assert.deepEqual(numbered(r.stdout),[a]);
 r=await cli(config,'corrections','pick',String(a),'还是该挑');assert.equal(r.stdout,`${A}：我说不该挑（纠正 #1） → 我说该挑（纠正 #3）：还是该挑\n`);
 r=await cli(config,'topics','项目群');assert.ok(r.stdout.includes(`理由：TA负责的接口 · 1 条消息\n  我的纠正 #3（${shown(topics.correction(3).at)}）：该挑：还是该挑\n`),r.stdout);
 r=await cli(config,'topics','--picked');assert.deepEqual(numbered(r.stdout),[a,b,c]);

 r=await cli(config,'corrections','missed','大群','2026-11-04','李四说的 Redis 迁移没挑出来');assert.equal(r.code,0,r.stderr);
 assert.equal(r.stdout,'大群 2026-11-04：记下漏挑（纠正 #4）：李四说的 Redis 迁移没挑出来\n');
 r=await cli(config,'corrections','missed','g2','2026-11-04','李四说的 Redis 迁移没挑出来','--json');j=JSON.parse(r.stdout);assert.deepEqual([j.before,j.after.id],[j.after,4]);
 r=await cli(config,'corrections','missed','张三','2026-11-04','张三约的会','--json');assert.equal(r.code,0,r.stderr);j=JSON.parse(r.stdout);
 assert.deepEqual([j.before,j.after],[null,{id:5,kind:'missed',day:'2026-11-04',chatId:'d1',chatName:'张三',words:'张三约的会',at:j.after.at,topic:null}]);
 assert.match(j.warning,/没有读过/,'a chat the read did not take up that day');
 r=await cli(config,'corrections','missed','张三','2026-11-04','张三约的另一个会');assert.match(r.stdout,/^注意：.*没有读过.*level set daily 张三/m);

 r=await cli(config,'corrections');assert.equal(r.code,0,r.stderr);
 const lines=r.stdout.trim().split('\n');
 assert.equal(lines[0],`#1 话题 #${a} 接口方案评审（项目群 2026-11-04，模型挑出）不该挑：这是别的组的事（${shown(topics.correction(1).at)}）`);
 assert.equal(lines[3],`#4 大群 2026-11-04 漏挑：李四说的 Redis 迁移没挑出来（${shown(topics.correction(4).at)}）`);
 r=await cli(config,'corrections','--json');j=JSON.parse(r.stdout);
 assert.deepEqual(j.map(k=>[k.id,k.kind,k.topicId??null,k.chatId,k.topic?.title??null]),[[1,'unpick',a,'g1','接口方案评审'],[2,'pick',b,'g1','午饭'],[3,'pick',a,'g1','接口方案评审'],[4,'missed',null,'g2',null],[5,'missed',null,'d1',null],[6,'missed',null,'d1',null]]);
 r=await cli(config,'corrections','remove','3');assert.equal(r.code,0,r.stderr);
 assert.equal(r.stdout,`已删除纠正 #3：话题 #${a} 接口方案评审（项目群 2026-11-04，模型挑出）该挑：还是该挑；这个话题现在：我说不该挑（纠正 #1）\n`);
 r=await cli(config,'corrections','remove','#4','--json');j=JSON.parse(r.stdout);assert.deepEqual([j.before.id,j.before.kind,j.before.topic,j.after],[4,'missed',null,null]);
 assert.deepEqual(topics.corrections().map(k=>k.id),[1,2,5,6]);assert.equal(topics.topic(a).picked,true,'a correction never changes the topic');

 for(const [args,error] of [[['pick','99','x'],/没有 #99 这个话题/],[['pick','abc','x'],/编号/],[['unpick',String(a)],/不能是空的/],[['pick',String(a),'长'.repeat(201)],/200/],
  [['missed','大群',dayOf(Date.now()),'x'],/还没有读/],[['missed','不存在的群','2026-11-04','x'],/没有找到聊天/],[['missed','大群','11-04','x'],/日期/],[['missed'],/聊天名或 id/],
  [['remove','99'],/没有纠正 #99/],[['remove'],/编号/],[['fix','1'],/corrections 没有这个操作/]]){
  r=await cli(config,'corrections',...args);assert.equal(r.code,1,args.join(' '));assert.match(r.stderr,error);
 }
 assert.deepEqual(topics.corrections().map(k=>k.id),[1,2,5,6],'nothing written when refused');
});

test('help lists every command and its flags, and nothing of a conversation in the direct chat',async t=>{
 const {lark,dir}=await setup(t);
 const r=await cli(writeConfig(dir,lark),'--help');assert.equal(r.code,0,r.stderr);
 for(const usage of ['run','status [--json]','list [--category 类别] [--since 时间] [--until 时间] [--limit 条数] [--json]','groups [--search 文字] [--json]',
  'level [list] [--json]','level set <级别> <聊天名或 id>... [--reason 文字] [--json]','level clear <聊天名或 id>... [--json]','level history [--since 时间] [--json]',
  'level grade [<聊天名或 id>...] [--json]','process [--once]','matters [list] [--all] [--json]','matters close <编号> [--reason 文字] [--json]','matters reopen <编号> [--json]',
  'notes [list] [--json]','notes add <文字> [--json]','notes remove <编号> [--json]','profile [--json]','ignore [list] [--json]','ignore add <发送方名称或 id>... [--json]',
  'ignore remove <发送方名称或 id>... [--json]','bot create [--name 名称]','bot update','--config 配置文件',
  'topics [<聊天名或 id>] [--day 日期] [--since 时间] [--until 时间] [--search 文字] [--picked | --not-picked] [--limit 条数] [--json]',
  'messages <聊天名或 id> [--day 日期] [--since 时间] [--until 时间] [--search 文字] [--limit 条数] [--json]','corrections [list] [--json]',
  'corrections pick <话题编号> <我的原话> [--json]','corrections unpick <话题编号> <我的原话> [--json]','corrections missed <聊天名或 id> <日期> <我的原话> [--json]',
  'corrections remove <编号> [--json]'])
  assert.ok(r.stdout.includes(usage),`help shows: ${usage}`);
 assert.match(r.stdout,/只写日期时是那天 0 点/);
 assert.doesNotMatch(r.stdout,/私聊对话|私聊里让管家/);
 assert.match(r.stdout,/instant 即时（全部消息交给模型，每天也读一遍）/);assert.match(r.stdout,/daily 每日（存下，每天读一遍、挑出话题）/);
 assert.doesNotMatch(r.stdout,/每日整理还没有做/);
 assert.match(r.stdout,/每天早上 6 点把前一天每日和即时的聊天读一遍/);assert.match(r.stdout,/不分级，不读/);
 assert.match(r.stdout,/类别：mention dm reply thread instant flagged own stored/);
});

// A herdr executable for the CLI: a shell script that runs the fake with its state directory.
function fakeHerdr(dir,script){
 const state=path.join(dir,'herdr');fs.mkdirSync(state);fs.writeFileSync(path.join(state,'script.json'),JSON.stringify(script));
 const bin=path.join(dir,'herdr.sh'),fake=fileURLToPath(new URL('./fake-herdr.mjs',import.meta.url));
 fs.writeFileSync(bin,`#!/bin/sh\nexec "${process.execPath}" "${fake}" "${state}" "$@"\n`,{mode:0o755});return bin;
}
// What claude was started with in each agent start the fake herdr saw: the arguments after --.
const agentStarts=dir=>fs.readFileSync(path.join(dir,'herdr','calls.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l))
 .filter(a=>a[2]==='agent'&&a[3]==='start').map(a=>a.slice(a.indexOf('--')+1));

test('process --once turns the backlog into matters through herdr; matters lists them with links',async t=>{
 const {lark,store,dir}=await setup(t);
 const ask=post(store,{text:'@原智鸿 帮忙审批下这个合并请求',categories:['mention','instant']}),noise=post(store,{chat:'g2',name:'李四',text:'收到'});
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

test('BUTLER_MODEL_NAME picks the model claude is asked for, and each run records the name',async t=>{
 const {lark,store,dir}=await setup(t),NAME='auto_model/alwaysday1_max';
 const herdr=fakeHerdr(dir,{});
 const machine=`BUTLER_MODEL_MACHINE=cpu1-butler\nBUTLER_MODEL_CWD=/home/me/.local/share/butler-model\nBUTLER_HERDR=${herdr}\n`;
 const starts=()=>agentStarts(dir);
 post(store,{text:'在吗'});
 let r=await cli(writeConfig(dir,lark,0o600,`${machine}BUTLER_MODEL_NAME=${NAME}\n`),'process','--once');assert.equal(r.code,0,r.stderr);
 let [args]=starts();
 assert.equal(args[args.indexOf('--model')+1],NAME);assert.deepEqual(JSON.parse(args[args.indexOf('--settings')+1]),{availableModels:[NAME]});
 post(store,{text:'还在吗'});
 r=await cli(writeConfig(dir,lark,0o600,`${machine}BUTLER_MODEL_NAME=\n`),'process','--once');assert.equal(r.code,0,r.stderr);
 args=starts()[1];assert.ok(!args.includes('--model')&&!args.includes('--settings'),'empty: claude\'s default model');
 assert.deepEqual(new Matters(store).runs().map(x=>[x.kind,x.model]),[['batch',NAME],['batch',undefined]]);
});

test('BUTLER_MODEL_EFFORT sets the effort claude is asked for, and only one claude knows',async t=>{
 const {lark,store,dir}=await setup(t);
 const herdr=fakeHerdr(dir,{});
 const machine=`BUTLER_MODEL_MACHINE=cpu1-butler\nBUTLER_MODEL_CWD=/home/me/.local/share/butler-model\nBUTLER_HERDR=${herdr}\n`;
 post(store,{text:'在吗'});
 let r=await cli(writeConfig(dir,lark,0o600,`${machine}BUTLER_MODEL_EFFORT=xhigh\n`),'process','--once');assert.equal(r.code,0,r.stderr);
 let [args]=agentStarts(dir);assert.equal(args[args.indexOf('--effort')+1],'xhigh');
 post(store,{text:'还在吗'});
 r=await cli(writeConfig(dir,lark,0o600,`${machine}BUTLER_MODEL_EFFORT=\n`),'process','--once');assert.equal(r.code,0,r.stderr);
 args=agentStarts(dir)[1];assert.ok(!args.includes('--effort'),'empty: claude\'s default effort');
 r=await cli(writeConfig(dir,lark,0o600,`${machine}BUTLER_MODEL_EFFORT=medium-high\n`),'status');assert.equal(r.code,1);
 assert.match(r.stderr,/BUTLER_MODEL_EFFORT/);assert.match(r.stderr,/low、medium、high、xhigh 或 max/);assert.match(r.stderr,/medium-high/);
});

test('level grade has the model grade the chats named, or every active chat whose level I did not set, through herdr; status shows grading',async t=>{
 const {lark,store,dir}=await setup(t),hour=3600e3,now=Date.now();
 // Butler has kept every message for three days; 项目群 is the busiest chat, 大群 the next.
 for(let i=0;i<3;i++)post(store,{chat:'g1',sender:'u5',name:'王五',text:`项目讨论 ${i}`,at:now-3*24*hour+i*hour,seen:now-3*24*hour,categories:['stored']});
 post(store,{chat:'g2',sender:'u5',name:'王五',text:'午饭吃什么',at:now-30*hour,categories:['stored']});
 post(store,{chat:'g3',text:'值班交接',at:now-hour,categories:['instant']});store.setLevel('g3','instant',{by:'owner'});
 let r=await cli(writeConfig(dir,lark),'status');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/分级：还没有分过；现在有 2 个聊天等着分级；模型定了级别的聊天 0 个/);
 r=await cli(writeConfig(dir,lark),'level','grade','项目群');assert.equal(r.code,1);assert.match(r.stderr,/BUTLER_MODEL_MACHINE/);
 const grade=(chat,level,reason)=>({text:JSON.stringify({chats:[{chat,level,reason}]})});
 const herdr=fakeHerdr(dir,{replies:[grade('c1','daily','项目讨论，和TA的工作有关'),{text:JSON.stringify({chats:[{chat:'c1',level:'store',reason:'项目讨论，TA只是旁观'},{chat:'c2',level:'ignore',reason:'闲聊'}]})},{text:'都挺重要的'},
  grade('c1','store','新群，和TA的工作无关')]});
 const config=writeConfig(dir,lark,0o600,`BUTLER_MODEL_MACHINE=cpu1-butler\nBUTLER_MODEL_CWD=/home/me/.local/share/butler-model\nBUTLER_HERDR=${herdr}\n`);
 r=await cli(config,'level','grade','项目群');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/^项目群：未分级（按只存不看） → 每日：项目讨论，和TA的工作有关$/m);assert.match(r.stdout,/分了 1 个聊天里的 1 个，模型运行 1 次/);
 assert.deepEqual([store.level('g1').level,store.level('g1').by],['daily','model']);
 r=await cli(config,'level','grade','值班群');assert.equal(r.code,1);assert.match(r.stderr,/没有找到聊天/);
 r=await cli(config,'level','grade','g3');assert.equal(r.code,1);assert.match(r.stderr,/g3 的级别是我定的（即时），模型不改/);assert.match(r.stderr,/level clear/);
 r=await cli(config,'level','grade');assert.equal(r.code,0,r.stderr);
 assert.match(r.stdout,/^项目群：每日 → 只存不看：项目讨论，TA只是旁观$/m);assert.match(r.stdout,/^大群：未分级（按只存不看） → 忽略：闲聊$/m);assert.doesNotMatch(r.stdout,/g3/);
 r=await cli(config,'level','list');assert.match(r.stdout,/只存不看\s+项目群.*理由：项目讨论，TA只是旁观/);
 r=await cli(config,'status');
 assert.match(r.stdout,/分级：上次 \d{4}-\d\d-\d\d \d\d:\d\d:\d\d（2 个聊天，分了 2 个）；下一次在 \d{4}-\d\d-\d\d \d\d:\d\d:\d\d 之后；模型定了级别的聊天 2 个/);
 assert.equal(JSON.parse((await cli(config,'status','--json')).stdout).grading.byModel,2);
 post(store,{chat:'g4',sender:'u5',name:'王五',text:'新群',at:now-30*hour,categories:['stored']});
 r=await cli(config,'level','grade','g4');assert.equal(r.code,1);assert.match(r.stdout,/没有分级：g4（模型的回复不是 JSON/);
 r=await cli(config,'status');assert.match(r.stdout,/分级：上次 .*（1 个聊天，分了 0 个，没有分完：模型的回复不是 JSON/);assert.match(r.stdout,/现在有 1 个聊天等着分级，\d{4}-.* 之后再分/);
 r=await cli(config,'level','grade','g4','--json');assert.equal(r.code,0,r.stderr);
 const j=JSON.parse(r.stdout);
 assert.deepEqual([j.chats,j.runs,j.graded.map(g=>[g.feedId,g.name,g.before,g.after.level,g.after.by,g.after.modelReason]),j.left],[1,1,[['g4','g4',null,'store','model','新群，和TA的工作无关']],[]]);
 assert.deepEqual(new Matters(store).runs().map(x=>[x.kind,x.ok]),[['grade',true],['grade',true],['grade',false],['grade',true]]);
 assert.deepEqual(lark.writes(),[]);
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

test('status shows the daily read: the last day read to the end with its topics picked and not, the messages flagged and the chats given up; a read that did not finish; the days passed over',async t=>{
 const {lark,store,dir}=await setup(t),config=writeConfig(dir,lark),time=ms=>new Date(ms).toLocaleString('sv-SE');
 const line=out=>out.split('\n').find(l=>l.startsWith('每日读取：'));
 let r=await cli(config,'status');assert.equal(r.code,0,r.stderr);
 assert.equal(line(r.stdout),'每日读取：还没有读完过一天；还没有开始收下全部消息，开始以后第一个完整的一天过完再读');
 const now=Date.now(),kept=startOf(dayOf(now))-12*3600e3;post(store,{chat:'g2',text:'收下全部消息以后的第一条',at:kept,seen:kept,categories:['stored']});
 r=await cli(config,'status');
 assert.equal(line(r.stdout),`每日读取：还没有读完过一天；下一次读 ${dayOf(now)}，在 ${time(startOf(nextDay(dayOf(now)))+6*3600e3)} 之后`,'the first whole day, the morning after');
 const at=Date.parse('2026-11-07T03:20:00+08:00');
 store.setMeta('reading',{from:'2026-11-06',through:'2026-11-06',last:{day:'2026-11-06',at,chats:23,picked:12,notPicked:30,flagged:3,failed:[{feedId:'oc_x',name:'坏群',error:'模型的回复不是 JSON：x'}]}});
 r=await cli(config,'status');
 assert.ok(line(r.stdout).startsWith(`每日读取：上次读完 2026-11-06（${time(at)}，23 个聊天，挑出 12 个话题、没挑 30 个，3 条消息交给批次，1 个聊天读不成、放弃了：坏群）；`),r.stdout);
 store.setMeta('reading',{...store.meta('reading'),through:'2026-11-09',skipped:['2026-11-07','2026-11-08'],failedAt:at+86400e3,failedDay:'2026-11-10',error:'herdr workspace create（cpu1-butler） 失败，退出码 1'});
 r=await cli(config,'status');
 assert.ok(line(r.stdout).endsWith(`；读 2026-11-10 没有完成：herdr workspace create（cpu1-butler） 失败，退出码 1，${time(at+86400e3+30*60e3)} 之后再试；停机期间没读的 2026-11-07、2026-11-08 不补读了`),r.stdout);
 const j=JSON.parse((await cli(config,'status','--json')).stdout).reading;
 assert.deepEqual([j.last.picked,j.last.notPicked,j.failedDay,j.retryAt],[12,30,'2026-11-10',at+86400e3+30*60e3]);
});

test('bot update needs a configured bot: it only ever updates that app',async t=>{
 const {lark,dir}=await setup(t);
 const r=await cli(writeConfig(dir,lark),'bot','update');assert.equal(r.code,1);assert.match(r.stderr,/没有配置机器人/);assert.match(r.stderr,/bot create/);
 const help=await cli(writeConfig(dir,lark),'--help');assert.match(help.stdout,/bot update/);
});

test('bot create refuses to replace a configured bot',async t=>{
 const {lark,dir}=await setup(t);
 const config=writeConfig(dir,lark,0o600,'BUTLER_BOT_APP_ID=cli_a1b2c3d4e5f6\nBUTLER_BOT_APP_SECRET=s\nBUTLER_BOT_OWNER=ou_owner0000000000000000000000001\n');
 const r=await cli(config,'bot','create');assert.equal(r.code,1);assert.match(r.stderr,/已经配置/);assert.match(r.stderr,/cli_a1b2c3d4e5f6/);
});
