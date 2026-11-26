import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setup,post} from './helpers.mjs';
import {FakeBridge,KEY} from './fake-bridge.mjs';
import {loadConfig,routingSetup} from '../config.mjs';

const CLI=fileURLToPath(new URL('../cli.mjs',import.meta.url));
const BOT='7100000000000000001',OC1=`oc_${'1'.repeat(32)}`;
const TOPIC={id:'T1',title:'火山发文平台映射',goal:'改火山发文的接口',chatId:OC1,chatName:'火山发文 - [需求同步群]',createdAt:1,adopted:false,pending:0,exchanges:[],sources:[],drafts:[]};
function run(config,env,...args){
 return new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['--disable-warning=ExperimentalWarning',CLI,'--config',config,...args],{stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
  let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));
 });
}
// A herdr executable that is the fake, whose model gives the replies in order.
function herdr(dir,replies){
 const state=path.join(dir,'herdr');fs.mkdirSync(state);fs.writeFileSync(path.join(state,'script.json'),JSON.stringify({replies}));
 const bin=path.join(dir,'herdr.sh'),fake=fileURLToPath(new URL('./fake-herdr.mjs',import.meta.url));
 fs.writeFileSync(bin,`#!/bin/sh\nexec "${process.execPath}" "${fake}" "${state}" "$@"\n`,{mode:0o755});return bin;
}
function writeConfig(dir,lark,extra=''){
 const file=path.join(dir,'butler.env');
 fs.writeFileSync(file,`BUTLER_OPEN_LARK_TOKEN="${lark.token}"\nBUTLER_OPEN_LARK_URL=${lark.url}\nBUTLER_DATA_DIR=${dir}\nBUTLER_MODEL_MACHINE=cpu1-butler\nBUTLER_MODEL_CWD=/tmp\n${extra}`,{mode:0o600});return file;
}
// A world for the command line: a fake open-lark that knows group g1 by OC1, a fake Bridge with topic T1 there, and a message in g1 a
// minute ago, which a round would route.
async function world(t){
 const w=await setup(t),bridge=await new FakeBridge().listen();t.after(()=>bridge.close());
 w.lark.chat({name:'火山发文 - [需求同步群]',feedId:'g1'});w.lark.conversations.get('g1').openChatId=OC1;bridge.topics=[TOPIC];
 const id=post(w.store,{chat:'g1',name:'金垠廷',text:'接口文档更新了',at:Date.now()-60e3,seen:Date.now()-60e3,categories:['stored']});
 return {...w,bridge,id,env:{BUTLER_BRIDGE_URL:bridge.url,BUTLER_BRIDGE_KEY:KEY}};
}
const ROUTE={text:JSON.stringify({routes:[{topic:'t1',messages:['m1'],digest:'金垠廷 刚才在「项目群」说：接口文档更新了（m1）'}]})};

test('route --dry-run prints what one round would hand to each topic, and writes and sends nothing',async t=>{
 const w=await world(t),config=writeConfig(w.dir,w.lark,`BUTLER_HERDR=${herdr(w.dir,[ROUTE,ROUTE])}\nBUTLER_BRIDGE_BOT_ID=${BOT}\n`);
 let r=await run(config,{},'route','--dry-run');
 assert.equal(r.code,1);assert.match(r.stderr,/BUTLER_BRIDGE_URL/,'it needs Bridge\'s topics');
 r=await run(config,w.env,'route','--dry-run');
 assert.equal(r.code,0,r.stderr);
 for(const part of ['1 条新消息','1 个进行中的话题','话题「火山发文平台映射」',`金垠廷 刚才在「项目群」说：接口文档更新了（消息 ${w.id}）`,'没有转给任何话题的消息：0 条','什么都没有发，也没有记下'])assert.ok(r.stdout.includes(part),part);
 assert.doesNotMatch(r.stdout+r.stderr,new RegExp(KEY),'the key is never printed');
 assert.deepEqual(w.bridge.digests(),[],'nothing handed over');
 assert.equal(w.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='routed'").get().n,0,'no table');
 assert.equal(w.store.db.prepare('SELECT count(*) n FROM model_runs').get().n,0,'the run is not recorded');
 assert.equal(w.store.meta('routing'),undefined,'no watermark');
 r=await run(config,w.env,'route','--dry-run','--since','2h','--json');
 assert.equal(r.code,0,r.stderr);const out=JSON.parse(r.stdout);
 assert.deepEqual(out.digests,[{topicId:'T1',title:'火山发文平台映射',messageIds:[w.id],text:`金垠廷 刚才在「项目群」说：接口文档更新了（消息 ${w.id}）`}]);
 assert.ok(out.from<=Date.now()-2*3600e3+5000);assert.equal(out.messages,1);
 r=await run(config,w.env,'route');assert.equal(r.code,1);assert.match(r.stderr,/用法/);
});

test('process --once routes when BUTLER_ROUTING says so: dry-run records what each topic would get and sends nothing; route log lists it',async t=>{
 const w=await world(t),at=Date.now();
 w.store.setMeta('profile',{text:'x',at,notes:[],messages:1});w.store.setMeta('review',{at,reviewed:0,closed:0,profileAt:at,notes:[]});
 const config=writeConfig(w.dir,w.lark,`BUTLER_HERDR=${herdr(w.dir,[ROUTE])}\nBUTLER_BRIDGE_BOT_ID=${BOT}\nBUTLER_BRIDGE_URL=${w.bridge.url}\nBUTLER_BRIDGE_KEY=${KEY}\nBUTLER_ROUTING=dry-run\n`);
 let r=await run(config,{},'process','--once');
 assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/转交（干跑）：1 条新消息，1 份摘要/);
 assert.deepEqual(w.bridge.digests(),[]);
 r=await run(config,{},'route','log');
 assert.equal(r.code,0,r.stderr);
 for(const part of ['干跑','话题「火山发文平台映射」',`（消息 ${w.id}）`])assert.ok(r.stdout.includes(part),part);
 r=await run(config,{},'route','log','--json');assert.deepEqual(JSON.parse(r.stdout).map(x=>[x.status,x.topicId,x.messageIds]),[['dry','T1',[w.id]]]);
});

test('config: BUTLER_ROUTING is off, dry-run or on, off by default; routing needs Bridge\'s address and key and its bot\'s id',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR??'/tmp','butler-routing-')),file=text=>{const f=path.join(dir,'butler.env');fs.writeFileSync(f,text,{mode:0o600});return f;};
 try{
  const bridge='BUTLER_BRIDGE_URL=http://127.0.0.1:9\nBUTLER_BRIDGE_KEY=k\nBUTLER_BRIDGE_BOT_ID=7100\n';
  assert.equal(routingSetup(loadConfig(file(bridge))),undefined,'off by default');
  assert.equal(routingSetup(loadConfig(file(`${bridge}BUTLER_ROUTING=off\n`))),undefined);
  assert.deepEqual(routingSetup(loadConfig(file(`${bridge}BUTLER_ROUTING=dry-run\nBUTLER_BOT_LARK_ID=7200\n`))),{mode:'dry-run',bridgeUrl:'http://127.0.0.1:9',bridgeKey:'k',botId:'7100',ownBotId:'7200'});
  assert.equal(routingSetup(loadConfig(file(`${bridge}BUTLER_ROUTING=on\n`))).mode,'on');
  assert.throws(()=>loadConfig(file('BUTLER_ROUTING=yes\n')),/BUTLER_ROUTING 只能是 off、dry-run 或 on：yes/);
  assert.throws(()=>routingSetup(loadConfig(file('BUTLER_ROUTING=on\nBUTLER_BRIDGE_URL=http://127.0.0.1:9\n'))),/转交.*BUTLER_BRIDGE_KEY、BUTLER_BRIDGE_BOT_ID/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
