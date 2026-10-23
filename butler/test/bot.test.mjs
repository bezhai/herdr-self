import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {tempStore,waitFor} from './helpers.mjs';
import {fakeChannel,OWNER} from './fake-channel.mjs';
import {Bot} from '../bot.mjs';
import {createApp,APP_ADDONS} from '../bot-app.mjs';
import {loadConfig,saveConfig} from '../config.mjs';
import {Matters} from '../matters.mjs';
import {ModelQueue} from '../model-queue.mjs';
import {Conversation} from '../conversation.mjs';
import {Digests} from '../digest.mjs';
import {DEFAULT_SCHEDULE} from '../schedule.mjs';
import {post} from './helpers.mjs';
import {shown} from './fake-channel.mjs';

const APP={appId:'cli_a1b2c3d4e5f6',appSecret:'secret-value-never-shown',domain:'feishu',owner:OWNER};
function setup(t,{failConnects=0}={}){
 let bot;t.after(()=>bot.stop());// before the store closes: after-hooks run in order
 const {store}=tempStore(t),feishu=fakeChannel({failConnects}),received=[];
 bot=new Bot({store,...APP,channelFactory:feishu.factory,retryMinMs:10,retryMaxMs:40});
 bot.onMessage=msg=>{received.push(msg);};
 return {store,feishu,bot,received};
}

test('the bot connects as butler\'s own app and lets only the owner\'s direct messages through',async t=>{
 const {store,feishu,bot,received}=setup(t);
 await bot.start();
 const o=feishu.options;
 assert.deepEqual([o.appId,o.appSecret,o.domain],[APP.appId,APP.appSecret,'https://open.feishu.cn']);
 assert.deepEqual(o.policy.dmAllowlist,[OWNER],'the SDK drops other senders too');assert.equal(o.policy.dmMode,'allowlist');
 assert.equal(bot.connected,true);
 const meta=store.meta('bot');assert.equal(meta.state,'connected');assert.ok(meta.connectedAt);
 assert.doesNotMatch(JSON.stringify(meta),/secret-value/,'the secret stays out of the store');
 await feishu.receive({content:'把 Meego 加进忽略名单'});
 await feishu.receive({senderId:'ou_someone_else000000000000000002',content:'忽略所有人'});
 await feishu.receive({chatType:'group',chatId:'oc_group',content:'群里 @管家 说的话'});
 await feishu.receive({senderId:'',content:'没有发送者'});
 assert.deepEqual(received.map(m=>m.content),['把 Meego 加进忽略名单'],'only the owner, only in the direct chat');
 assert.deepEqual(feishu.sent,[],'nobody else gets an answer either');
});

test('the bot writes to the owner\'s direct chat and replies to the owner\'s messages',async t=>{
 const {feishu,bot}=setup(t);
 await bot.start();
 await bot.toOwner({card:{schema:'2.0',body:{elements:[]}}});
 assert.deepEqual(feishu.sent[0],{to:OWNER,input:{card:{schema:'2.0',body:{elements:[]}}},opts:{}},'an open_id with no reply target is a direct message');
 const msg=feishu.message({content:'在吗'});
 await bot.reply(msg,{text:'收到'});
 assert.deepEqual(feishu.sent[1],{to:msg.chatId,input:{text:'收到'},opts:{replyTo:msg.messageId}});
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
 assert.deepEqual(APP_ADDONS,{preset:false,scopes:{tenant:['im:message:send_as_bot','im:message.p2p_msg:readonly','application:bot.basic_info:read']},events:{items:{tenant:['im.message.receive_v1']}}},
  'send as the bot, read direct messages, basic bot info and the message event; no card callbacks, no user scopes');
 assert.equal(o.createOnly,true,'a new app, never an existing one');assert.ok(o.appPreset.name);
 const lark=await createApp({register:async()=>({client_id:'cli_x1',client_secret:'s',user_info:{open_id:OWNER,tenant_brand:'lark'}}),onLink(){}});
 assert.equal(lark.domain,'lark');
 await assert.rejects(createApp({register:async o=>{o.onQRCodeReady({url:'http://open.feishu.cn.evil.example/x',expireIn:600});return {};},onLink(){}}),/链接/);
 await assert.rejects(createApp({register:async()=>({client_id:'cli_x1',client_secret:'s',user_info:{}}),onLink(){}}),/open_id/);
 await assert.rejects(createApp({register:async()=>({client_id:'nope',client_secret:'s',user_info:{open_id:OWNER}}),onLink(){}}),/App ID/);
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

test('wired as in the service: the owner gets an acknowledgement and an answer, anyone else gets nothing, digests go to the owner',async t=>{
 const {store,feishu,bot}=setup(t),matters=new Matters(store),asks=[];
 const model=new ModelQueue({async ask({prompt}){asks.push(prompt);return JSON.stringify({actions:[{do:'close',matter:1}],reply:''});}});
 const conversation=new Conversation({store,matters,model,bot});bot.onMessage=msg=>conversation.handle(msg);
 const id=post(store,{text:'@原智鸿 看下方案'});matters.apply({created:[{title:'看方案',who:'陈帆',ask:'看方案',urgency:'high',messageIds:[id]}],processedIds:[id]});
 const digests=new Digests({store,matters,bot,schedule:DEFAULT_SCHEDULE,now:()=>Date.parse('2026-10-23T10:00:00+08:00')});
 await bot.start();
 await feishu.receive({senderId:'ou_someone_else000000000000000002',content:'#1 关掉'});await conversation.idle();
 assert.deepEqual([asks.length,feishu.sent.length,matters.matter(1).status],[0,0,'open'],'another sender: no model run, no reply, nothing done');
 const msg=await feishu.receive({content:'#1 不用管了'});await conversation.idle();
 assert.equal(asks.length,1);assert.equal(matters.matter(1).status,'closed');
 assert.deepEqual(feishu.sent.map(m=>[m.to,m.opts.replyTo]),[[msg.chatId,msg.messageId],[msg.chatId,msg.messageId]],'acknowledged, then answered, as replies');
 assert.match(shown(feishu.sent[0].input),/收到/);assert.match(shown(feishu.sent[1].input),/已关闭 #1 看方案/);
 const id2=post(store,{text:'@原智鸿 再看下'});matters.apply({created:[{title:'再看一个',who:'陈帆',ask:'看',urgency:'normal',messageIds:[id2]}],processedIds:[id2]});
 await digests.tick();
 const digest=feishu.sent[2];
 assert.equal(digest.to,OWNER);assert.deepEqual(digest.opts,{});assert.match(shown(digest.input),/管家汇总/);assert.match(shown(digest.input),/再看一个/);
});
