import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setup} from './helpers.mjs';
import {FakeBridge,KEY} from './fake-bridge.mjs';
import {loadConfig,newChatSetup} from '../config.mjs';

const CLI=fileURLToPath(new URL('../cli.mjs',import.meta.url));
const MEEGO='https://meego.example.com/ug/story/detail/7398902081';
const VERDICT={requirement:true,mine:true,reason:'你是这个需求的 Server 开发。',title:'火山发文平台映射',prompt:`先读 PRD：${MEEGO}`,projectId:'genvi',agentConfigId:'cc-cpu2'};
function run(config,env,...args){
 return new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['--disable-warning=ExperimentalWarning',CLI,'--config',config,...args],{stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
  let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));
 });
}
// A herdr executable that is the fake, and a bytedcli that answers a Meego link with a work item the way the real one wraps it.
function executables(dir,script){
 const state=path.join(dir,'herdr');fs.mkdirSync(state);fs.writeFileSync(path.join(state,'script.json'),JSON.stringify(script));
 const herdr=path.join(dir,'herdr.sh'),fake=fileURLToPath(new URL('./fake-herdr.mjs',import.meta.url));
 fs.writeFileSync(herdr,`#!/bin/sh\nexec "${process.execPath}" "${fake}" "${state}" "$@"\n`,{mode:0o755});
 const item={work_item_attribute:{work_item_name:'火山发文平台映射',work_item_status:{name:'进行中'},create_by:{name:'金垠廷',email:'x@y.z',key:'1'}}};
 const answer={status:'success',data:{result:{content:[{type:'text',text:JSON.stringify(item)}]}}};
 const bytedcli=path.join(dir,'bytedcli.sh');fs.writeFileSync(bytedcli,`#!/bin/sh\necho "$@" >> "${dir}/bytedcli.calls"\ncat <<'EOF'\n${JSON.stringify(answer)}\nEOF\n`,{mode:0o755});
 return {herdr,bytedcli};
}
function writeConfig(dir,lark,extra=''){
 const file=path.join(dir,'butler.env');
 fs.writeFileSync(file,`BUTLER_OPEN_LARK_TOKEN="${lark.token}"\nBUTLER_OPEN_LARK_URL=${lark.url}\nBUTLER_DATA_DIR=${dir}\nBUTLER_MODEL_MACHINE=cpu1-butler\nBUTLER_MODEL_CWD=/tmp\n${extra}`,{mode:0o600});return file;
}

test('newchat judge: prints the material, the verdict and the card, and writes and sends nothing',async t=>{
 const {lark,dir}=await setup(t);
 const bridge=await new FakeBridge({state:{projects:[{id:'genvi',name:'GenVI',description:'GEO',repos:[]}],agentConfigs:[{id:'cc-cpu2',name:'Claude Code（cpu2）',machineId:'cpu2',kind:'claude'}],machines:[{id:'cpu2',name:'cpu2'}]}}).listen();
 t.after(()=>bridge.close());
 const feed=lark.chat({name:'火山发文平台映射 - [需求同步群]'});lark.conversations.get(feed).description=MEEGO;
 const view=lark.conversationView.bind(lark);lark.conversationView=c=>({...view(c),description:c.description,openChatId:`oc_${c.feedId}`});
 lark.post(feed,{text:'需求建好了',senderName:'金垠廷'});
 const {herdr,bytedcli}=executables(dir,{replies:[{text:JSON.stringify(VERDICT)},{text:JSON.stringify(VERDICT)},{text:JSON.stringify({requirement:true,mine:false,reason:'金垠廷只是拉你进来知情。'})}]});
 const config=writeConfig(dir,lark,`BUTLER_HERDR=${herdr}\nBUTLER_BYTEDCLI=${bytedcli}\n`);
 let r=await run(config,{},'newchat','judge',feed);
 assert.equal(r.code,1);assert.match(r.stderr,/BUTLER_BRIDGE_URL/,'it needs Bridge\'s lists');
 r=await run(config,{BUTLER_BRIDGE_URL:bridge.url,BUTLER_BRIDGE_KEY:KEY},'newchat','judge',feed);
 assert.equal(r.code,0,r.stderr);
 for(const part of ['火山发文平台映射 - [需求同步群]','火山发文平台映射（进行中）','需求群：是','你是这个需求的 Server 开发','GenVI','Claude Code（cpu2）','先读 PRD','新需求群：火山发文平台映射 - [需求同步群]','交给 Agent'])assert.match(r.stdout,new RegExp(part.replace(/[[\]()]/g,'\\$&')),part);
 assert.doesNotMatch(r.stdout+r.stderr,new RegExp(KEY),'the key is never printed');
 assert.deepEqual(lark.writes(),[],'nothing written in open-lark');assert.deepEqual(bridge.opens(),[],'no topic opened');
 assert.match(fs.readFileSync(path.join(dir,'bytedcli.calls'),'utf8'),/meego workitem get --url .*7398902081 --json/);
 const {Store}=await import('../store.mjs');const store=new Store(path.join(dir,'butler.db'),{linkBase:'http://x'});t.after(()=>store.close());
 assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='new_chats'").get().n,0,'no table, no row');
 assert.equal(store.db.prepare("SELECT count(*) n FROM model_runs").get().n,0,'the run is not recorded');
 r=await run(config,{BUTLER_BRIDGE_URL:bridge.url,BUTLER_BRIDGE_KEY:KEY},'newchat','judge',feed,'--json');
 assert.equal(r.code,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.verdict.requirement,true);assert.equal(out.card.header.title.content,'新需求群：火山发文平台映射 - [需求同步群]');assert.equal(out.material.name,'火山发文平台映射 - [需求同步群]');
 r=await run(config,{BUTLER_BRIDGE_URL:bridge.url,BUTLER_BRIDGE_KEY:KEY},'newchat','judge',feed);
 assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/这个判断不交给 Agent，不会发卡片/);
 r=await run(config,{BUTLER_BRIDGE_URL:bridge.url,BUTLER_BRIDGE_KEY:KEY},'newchat','judge');assert.equal(r.code,1);assert.match(r.stderr,/用法/);
});

test('config: the four keys of 新需求群 are all there or none; Bridge\'s url and key may come from the environment',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-cfg-'));
 const file=(extra)=>{const f=path.join(dir,'butler.env');fs.writeFileSync(f,`BUTLER_OPEN_LARK_TOKEN=r\nBUTLER_BOT_APP_ID=a\nBUTLER_BOT_APP_SECRET=s\nBUTLER_BOT_OWNER=o\n${extra}`,{mode:0o600});return f;};
 const all='BUTLER_BRIDGE_URL=http://10.0.0.1:8080/\nBUTLER_BRIDGE_KEY=k\nBUTLER_OPEN_LARK_WRITE_TOKEN=w\nBUTLER_BRIDGE_BOT_ID=cli_x\n';
 assert.equal(newChatSetup(loadConfig(file(''))),undefined,'none: the feature is off');
 assert.deepEqual(newChatSetup(loadConfig(file(all))),{bridgeUrl:'http://10.0.0.1:8080',bridgeKey:'k',writeToken:'w',botId:'cli_x'});
 assert.throws(()=>newChatSetup(loadConfig(file('BUTLER_BRIDGE_URL=http://10.0.0.1:8080\nBUTLER_BRIDGE_KEY=k\n'))),/「新需求群」的配置不全.*(BUTLER_OPEN_LARK_WRITE_TOKEN.*BUTLER_BRIDGE_BOT_ID|BUTLER_BRIDGE_BOT_ID.*BUTLER_OPEN_LARK_WRITE_TOKEN)/);
 assert.throws(()=>loadConfig(file('BUTLER_BRIDGE_URL=nope\n')),/BUTLER_BRIDGE_URL/);
 process.env.BUTLER_BRIDGE_URL='http://127.0.0.1:9';process.env.BUTLER_BRIDGE_KEY='from-env';
 try{const c=loadConfig(file(all));assert.equal(c.newChat.bridgeUrl,'http://127.0.0.1:9');assert.equal(c.newChat.bridgeKey,'from-env');}
 finally{delete process.env.BUTLER_BRIDGE_URL;delete process.env.BUTLER_BRIDGE_KEY;}
 fs.rmSync(dir,{recursive:true,force:true});
});
test('the processor refuses 新需求群 without the bot, whose cards it needs',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-cfg-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config=writeConfig(dir,{url:'http://127.0.0.1:9',token:'r'},'BUTLER_BRIDGE_URL=http://127.0.0.1:9\nBUTLER_BRIDGE_KEY=k\nBUTLER_OPEN_LARK_WRITE_TOKEN=w\nBUTLER_BRIDGE_BOT_ID=cli_x\n');
 const r=await run(config,{},'process','--once');
 assert.equal(r.code,1);assert.match(r.stderr,/配置了「新需求群」，但没有配置管家机器人/);
});
