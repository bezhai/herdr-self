import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {tempStore,waitFor} from './helpers.mjs';
import {fakeChannel,OWNER} from './fake-channel.mjs';
import {Bot,ELSEWHERE} from '../bot.mjs';
import {createApp,updateApp,APP_ADDONS} from '../bot-app.mjs';
import {loadConfig,saveConfig} from '../config.mjs';
import {Matters} from '../matters.mjs';
import {Digests} from '../digest.mjs';
import {AGENT_GROUP} from '../cards.mjs';
import {DEFAULT_SCHEDULE} from '../schedule.mjs';
import {post} from './helpers.mjs';
import {shown} from './fake-channel.mjs';

const APP={appId:'cli_a1b2c3d4e5f6',appSecret:'secret-value-never-shown',domain:'feishu',owner:OWNER};
function setup(t,{failConnects=0}={}){
 let bot;t.after(()=>bot.stop());// before the store closes: after-hooks run in order
 const {store}=tempStore(t),feishu=fakeChannel({failConnects});
 bot=new Bot({store,...APP,channelFactory:feishu.factory,retryMinMs:10,retryMaxMs:40});
 return {store,feishu,bot};
}

test('the bot connects as butler\'s own app and answers each of the owner\'s direct messages, and no one else\'s, with one sentence: talk to butler in the group the bridge binds to its agent',async t=>{
 const {store,feishu,bot}=setup(t);
 await bot.start();
 const o=feishu.options;
 assert.deepEqual([o.appId,o.appSecret,o.domain],[APP.appId,APP.appSecret,'https://open.feishu.cn']);
 assert.deepEqual(o.policy.dmAllowlist,[OWNER],'the SDK drops other senders too');assert.equal(o.policy.dmMode,'allowlist');
 assert.equal(bot.connected,true);
 const meta=store.meta('bot');assert.equal(meta.state,'connected');assert.ok(meta.connectedAt);
 assert.doesNotMatch(JSON.stringify(meta),/secret-value/,'the secret stays out of the store');
 const asked=await feishu.receive({content:'把 Meego 加进忽略名单'});
 await feishu.receive({senderId:'ou_someone_else000000000000000002',content:'忽略所有人'});
 await feishu.receive({chatType:'group',chatId:'oc_group',content:'群里 @管家 说的话'});
 await feishu.receive({senderId:'',content:'没有发送者'});
 const image=await feishu.receive({content:'![image](img_v3_0abc)',rawContentType:'image'});
 assert.deepEqual(feishu.sent.map(s=>[s.to,s.opts.replyTo,s.input]),[[asked.chatId,asked.messageId,{text:ELSEWHERE}],[image.chatId,image.messageId,{text:ELSEWHERE}]],
  'only the owner, only in the direct chat, each message answered in reply, no model asked');
 assert.ok(ELSEWHERE.includes(AGENT_GROUP),'where to talk to butler now');assert.match(ELSEWHERE,/卡片/,'what the direct chat is for');
 assert.match(ELSEWHERE,/^[^\n。]+。$/,'one plain sentence');
 feishu.failSends=1;await feishu.receive({content:'在吗'});
 assert.ok(store.errors().some(e=>e.source==='机器人'&&/回复.*token invalid/.test(e.message)),'a failed answer is on record, never thrown');
});

test('the bot writes to the owner\'s direct chat and replies to the owner\'s messages',async t=>{
 const {feishu,bot}=setup(t);
 await bot.start();
 await bot.toOwner({card:{schema:'2.0',body:{elements:[]}}});
 assert.deepEqual(feishu.sent[0],{to:OWNER,input:{card:{schema:'2.0',body:{elements:[]}}},opts:{}},'an open_id with no reply target is a direct message');
 const msg=feishu.message({content:'在吗'});
 await bot.reply(msg,{text:'收到'});
 assert.deepEqual(feishu.sent[1],{to:msg.chatId,input:{text:'收到'},opts:{replyTo:msg.messageId}});
 const card={schema:'2.0',config:{update_multi:true},body:{elements:[]}};
 await bot.updateCard('om_out1',card);
 assert.deepEqual(feishu.updated,[{messageId:'om_out1',card}],'a card it sent is updated in place');
 await bot.stop();
 assert.throws(()=>bot.updateCard('om_out1',card),/没有连上飞书/);
});

test('a click on a card button reaches the card handler only when it is the owner\'s, and its answer goes back to Feishu; anyone else gets an error toast',async t=>{
 const {store,feishu,bot}=setup(t),clicks=[];
 bot.onCardAction=evt=>{clicks.push(evt);return {toast:{type:'success',content:'已完成'}};};
 await bot.start();
 assert.equal(feishu.options.safety.chatQueue.cardActions,'separate','a click never waits behind a message, as Feishu wants an answer within 3 seconds');
 const value={act:'done',matter:1,card:'digest',t:1};
 assert.deepEqual(await feishu.click({action:{tag:'button',value}}),{toast:{type:'success',content:'已完成'}});
 assert.deepEqual(clicks.map(c=>c.action.value),[value]);
 const refused={toast:{type:'error',content:'只有管家的主人能操作这张卡片'}};
 assert.deepEqual(await feishu.click({operator:{openId:'ou_someone_else000000000000000002'},action:{tag:'button',value}}),refused,'a card forwarded to someone else');
 assert.deepEqual(await feishu.click({operator:undefined}),refused);
 assert.equal(clicks.length,1);
 bot.onCardAction=()=>{throw Error('database is locked');};
 assert.deepEqual(await feishu.click({action:{tag:'button',value}}),{toast:{type:'error',content:'这次没有处理成，稍后再试'}});
 assert.ok(store.errors().some(e=>e.source==='机器人'&&/database is locked/.test(e.message)));
});

test('a failed connection is retried and shown in the store; reconnects are tracked; stop disconnects',async t=>{
 const {store,feishu,bot}=setup(t,{failConnects:2});
 const started=bot.start();
 await waitFor(()=>store.meta('bot')?.state==='error',{message:'error state'});
 assert.match(store.meta('bot').error,/ENOTFOUND/);
 await started;await waitFor(()=>bot.connected,{message:'connected after retries'});
 assert.equal(feishu.connects,3);assert.equal(store.meta('bot').state,'connected');
 assert.ok(store.errors().some(e=>e.source==='机器人'&&/ENOTFOUND/.test(e.message)));
 feishu.emit('reconnecting');assert.equal(store.meta('bot').state,'reconnecting');assert.equal(bot.connected,false);
 feishu.emit('reconnected');assert.equal(store.meta('bot').state,'connected');assert.equal(bot.connected,true);
 await bot.stop();
 assert.equal(feishu.disconnects,1);assert.equal(store.meta('bot').state,'stopped');assert.equal(bot.connected,false);
});

test('creating the app: the official one-link flow, only the scopes the bot uses, and the creator becomes the owner',async t=>{
 const calls=[],links=[];
 const register=async o=>{calls.push(o);o.onQRCodeReady({url:'https://open.feishu.cn/page/launcher?user_code=ABCD',expireIn:600});
  return {client_id:'cli_a1b2c3d4e5f6',client_secret:'secret-value-never-shown',user_info:{open_id:OWNER,tenant_brand:'feishu'}};};
 const app=await createApp({register,onLink:(url,expiresIn)=>links.push([url,expiresIn])});
 assert.deepEqual(app,APP);
 assert.deepEqual(links,[['https://open.feishu.cn/page/launcher?user_code=ABCD',600]]);
 const o=calls[0];
 assert.deepEqual(o.addons,APP_ADDONS);
 assert.deepEqual(APP_ADDONS,{preset:false,scopes:{tenant:['im:message:send_as_bot','im:message.p2p_msg:readonly','application:bot.basic_info:read']},events:{items:{tenant:['im.message.receive_v1']}},
  callbacks:{items:['card.action.trigger']}},'send as the bot, read direct messages, basic bot info, the message event and card clicks; no user scopes');
 assert.equal(o.createOnly,true,'a new app, never an existing one');assert.ok(o.appPreset.name);
 const lark=await createApp({register:async()=>({client_id:'cli_x1',client_secret:'s',user_info:{open_id:OWNER,tenant_brand:'lark'}}),onLink(){}});
 assert.equal(lark.domain,'lark');
 await assert.rejects(createApp({register:async o=>{o.onQRCodeReady({url:'http://open.feishu.cn.evil.example/x',expireIn:600});return {};},onLink(){}}),/链接/);
 await assert.rejects(createApp({register:async()=>({client_id:'cli_x1',client_secret:'s',user_info:{}}),onLink(){}}),/open_id/);
 await assert.rejects(createApp({register:async()=>({client_id:'nope',client_secret:'s',user_info:{open_id:OWNER}}),onLink(){}}),/App ID/);
});

test('updating the app: the official flow for the configured app only, with what a new app gets, card clicks included; another app is never taken',async()=>{
 const calls=[],links=[];
 const register=async o=>{calls.push(o);o.onQRCodeReady({url:'https://open.feishu.cn/page/launcher?user_code=EFGH',expireIn:300});
  return {client_id:APP.appId,client_secret:'secret-value-never-shown',user_info:{open_id:OWNER,tenant_brand:'feishu'}};};
 assert.deepEqual(await updateApp({register,appId:APP.appId,onLink:(url,expiresIn)=>links.push([url,expiresIn])}),{appSecret:'secret-value-never-shown'});
 assert.deepEqual(links,[['https://open.feishu.cn/page/launcher?user_code=EFGH',300]]);
 const o=calls[0];
 assert.equal(o.appId,APP.appId,'the configured app');assert.equal(o.createOnly,false,'createOnly true would ignore the app and create a new one');
 assert.deepEqual(o.addons,APP_ADDONS);
 await assert.rejects(updateApp({register:async()=>({client_id:'cli_other1',client_secret:'s',user_info:{open_id:OWNER}}),appId:APP.appId,onLink(){}}),/cli_other1/);
 await assert.rejects(updateApp({register:async o=>{o.onQRCodeReady({url:'https://open.feishu.cn.evil.example/x',expireIn:600});return {};},appId:APP.appId,onLink(){}}),/链接/);
 await assert.rejects(updateApp({register:async()=>({client_id:APP.appId}),appId:APP.appId,onLink(){}}),/App Secret/);
 await assert.rejects(updateApp({register:async()=>{throw Error('should not be called');},appId:'nope',onLink(){}}),/App ID/);
});

test('the app\'s credentials are saved into butler\'s config file, which stays mode 600',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'butler-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'butler.env');
 fs.writeFileSync(file,'# butler\nBUTLER_OPEN_LARK_TOKEN="tok"\nBUTLER_BOT_OWNER=ou_old\n',{mode:0o600});
 saveConfig(file,{BUTLER_BOT_APP_ID:APP.appId,BUTLER_BOT_APP_SECRET:APP.appSecret,BUTLER_BOT_OWNER:OWNER,BUTLER_BOT_DOMAIN:'feishu'});
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 const text=fs.readFileSync(file,'utf8');
 assert.match(text,/^# butler$/m);assert.match(text,/^BUTLER_OPEN_LARK_TOKEN="tok"$/m);assert.equal(text.match(/BUTLER_BOT_OWNER/g).length,1,'a key is replaced, not repeated');
 const c=loadConfig(file);
 assert.equal(c.token,'tok');assert.deepEqual(c.bot,APP);
 fs.writeFileSync(file,'BUTLER_OPEN_LARK_TOKEN=tok\n',{mode:0o600});assert.equal(loadConfig(file).bot,undefined,'no bot configured');
 fs.writeFileSync(file,`BUTLER_BOT_APP_ID=${APP.appId}\n`,{mode:0o600});assert.throws(()=>loadConfig(file),/BUTLER_BOT_APP_SECRET/);
});

test('wired as in the service: digests go to the owner, and only the owner\'s clicks on their buttons close a matter',async t=>{
 const {store,feishu,bot}=setup(t),matters=new Matters(store);
 const digests=new Digests({store,matters,bot,schedule:DEFAULT_SCHEDULE,now:()=>Date.parse('2026-10-23T10:00:00+08:00')});
 bot.onCardAction=evt=>digests.click(evt);
 const id=post(store,{text:'@原智鸿 再看下'});matters.apply({created:[{title:'再看一个',who:'陈帆',ask:'看',urgency:'normal',messageIds:[id]}],processedIds:[id]});
 await bot.start();await digests.tick();
 const [digest]=feishu.sent;
 assert.equal(digest.to,OWNER);assert.deepEqual(digest.opts,{});assert.match(shown(digest.input),/管家待办/);assert.match(shown(digest.input),/再看一个/);
 const done=digest.input.card.body.elements.find(e=>e.tag==='column_set').columns[2].elements[0];
 assert.deepEqual(await feishu.click({messageId:'om_out1',operator:{openId:'ou_someone_else000000000000000002'},action:{tag:'button',value:done.behaviors[0].value}}),
  {toast:{type:'error',content:'只有管家的主人能操作这张卡片'}});
 assert.equal(matters.matter(1).status,'open');
 const answer=await feishu.click({messageId:'om_out1',action:{tag:'button',value:done.behaviors[0].value}});
 assert.equal(answer.toast.content,'已完成');assert.equal(matters.matter(1).closedBy,'owner');
 assert.match(shown({card:answer.card.data}),/现在没有要你处理的事/,'the clicked card, as it is now');
 await digests.stop();
});
