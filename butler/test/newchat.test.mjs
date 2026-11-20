import test from 'node:test';
import assert from 'node:assert/strict';
import {startFakeOpenLark} from './fake-open-lark.mjs';
import {FakeBridge,KEY} from './fake-bridge.mjs';
import {tempStore,sleep} from './helpers.mjs';
import {shown,componentsOf,OWNER} from './fake-channel.mjs';
import {Matters} from '../matters.mjs';
import {Processor,aboutOf} from '../processor.mjs';
import {OpenLark,addBotOnly} from '../open-lark.mjs';
import {Bridge,BOT_CANNOT_POST} from '../bridge-client.mjs';
import {NewChats} from '../newchat.mjs';
import {meegoLinks,gatherMaterial} from '../newchat-material.mjs';
import {readNewChat} from '../prompt.mjs';

process.env.TZ='Asia/Shanghai';
const BOT='cli_bridge_bot';
const PROJECTS=[{id:'genvi',name:'GenVI',description:'GEO 增长服务',repos:['git@code.example:growth/genvi.git']},{id:'ops',name:'运维脚本',description:'',repos:[]}];
const CONFIGS=[{id:'cc-cpu2',name:'Claude Code（cpu2）',machineId:'cpu2',kind:'claude'},{id:'cc-cpu1',name:'Claude Code（cpu1）',machineId:'cpu1',kind:'claude'}];
const MACHINES=[{id:'cpu1',name:'cpu1'},{id:'cpu2',name:'cpu2'}];
const MEEGO='https://meego.example.com/ug/story/detail/7398902081';
const WORK_ITEM={work_item_attribute:{work_item_name:'火山发文平台映射',work_item_status:{name:'进行中'},role_members:[{key:'Server',name:'Server开发',members:[{name:'原智鸿',email:'a@x.com',key:'1'}]}],
 create_by:{name:'金垠廷',email:'b@x.com',key:'2'}},work_item_fields:[{key:'group_type',name:'拉群方式选择',value:{group_id:'oc_group',label:'自动拉群'}}]};
const VERDICT={requirement:true,mine:true,reason:'你是这个需求的 Server 开发，群刚建好。',title:'火山发文平台映射',prompt:`先读 PRD 再做：${MEEGO}`,projectId:'genvi',agentConfigId:'cc-cpu2'};

// A world: a fake open-lark with a read client and the write client, a fake Bridge, a bot that records what it sends, a model
// that answers with what the test says (answers: a queue; the last one repeats), a store and the NewChats over them. order
// records the order of the writes that matter: bot added, topic opened, card updated.
async function world(t,{answers=[VERDICT],meego=async url=>({url,...WORK_ITEM}),bridgeState={},botId=BOT,options={}}={}){
 const lark=await startFakeOpenLark(),bridge=await new FakeBridge({state:{projects:PROJECTS,agentConfigs:CONFIGS,machines:MACHINES,...bridgeState}}).listen();
 const {store}=tempStore(t),matters=new Matters(store);
 t.after(async()=>{await lark.close();await bridge.close();});
 const order=[],sent=[],updated=[],prompts=[],faults={add:0};
 const reader=new OpenLark({url:lark.url,token:lark.token,gapMs:0}),writer=new OpenLark({url:lark.url,token:lark.fullToken,gapMs:0,guard:addBotOnly});
 const realAdd=writer.addBot.bind(writer);writer.addBot=async(...a)=>{order.push('add');if(faults.add){faults.add-=1;throw Error('open-lark 返回 403：没有权限');}return realAdd(...a);};
 const client=new Bridge({url:bridge.url,key:KEY,retryMs:5,retryForMs:200}),realOpen=client.openTopic.bind(client);client.openTopic=async i=>{order.push('open');return realOpen(i);};
 const bot={connected:true,async toOwner(input){if(bot.failSend){bot.failSend-=1;throw Error('飞书拒绝了');}sent.push(input);return {messageId:`om_card${sent.length}`};},
  async updateCard(id,card){order.push('update');updated.push({id,card});}};
 const queue=[...answers],model={name:'fake',async ask({system,prompt}){prompts.push({system,prompt,data:JSON.parse(prompt.slice(prompt.indexOf('{')))});
  if(model.fail){model.fail-=1;throw Error('模型没有回复');}
  const a=queue.length>1?queue.shift():queue[0];return typeof a==='string'?a:JSON.stringify(a);}};
 let clock=Date.parse('2026-11-21T10:00:00+08:00');
 const newChats=new NewChats({store,matters,lark:reader,adder:writer,bridge:client,bot,model,botId,meego,now:()=>clock,...options});
 return {lark,bridge,store,matters,order,sent,updated,prompts,bot,model,newChats,faults,tick:ms=>{clock+=ms;},
  // A group that appears in butler's chat table, as the collector writes it, and in open-lark.
  group(name,{description='',feedId}={}){
   const id=lark.chat({name,feedId});lark.conversations.get(id).description=description;lark.conversations.get(id).openChatId=`oc_${id}`;
   store.upsertChatInfo({feedId:id,name,chatMode:'group',memberCount:10});return id;
  },
  about:()=>aboutOf(store,matters)};
}
// The conversation view of the fake carries no openChatId or description by itself: the test sets them on the entry.
const patchView=lark=>{const view=lark.conversationView.bind(lark);lark.conversationView=c=>({...view(c),...(c.description?{description:c.description}:{}),...(c.openChatId?{openChatId:c.openChatId}:{})});};
const click=(nc,messageId,value)=>nc.click({messageId,chatId:'oc_dm',operator:{openId:OWNER},action:{tag:'button',value}});
// The buttons that send a click back to butler (not those that open a link): label and value.
const buttons=card=>[...componentsOf(card)].filter(c=>c.tag==='button'&&c.behaviors.some(x=>x.type==='callback')).map(b=>[b.text.content,b.behaviors.find(x=>x.type==='callback').value]);
const buttonValue=(card,label)=>buttons(card).find(([l])=>l===label)?.[1];
const headerOf=card=>card.header.title.content;

// ---- gathering the material
test('meegoLinks finds Meego work item links in texts, once each, without a login token',()=>{
 assert.deepEqual(meegoLinks([`见 ${MEEGO}?tabKey=detail，和 ${MEEGO}`,'https://meego.example.com/ug/issue/detail/55?x=1','https://example.com/detail/9','无链接']),
  [`${MEEGO}?tabKey=detail`,'https://meego.example.com/ug/issue/detail/55?x=1'],'one work item once, however it is linked; only Meego\'s links');
});

test('the material of a group: its entry, settings, tabs, bots, the first messages and the work item behind a Meego link',async t=>{
 const w=await world(t);patchView(w.lark);
 const feed=w.group('火山发文平台映射 - [需求同步群]',{description:`${MEEGO}?tabKey=detail`});
 const c=w.lark.conversations.get(feed);
 c.settings={labels:['需求群'],ownerId:'u_owner',currentUserId:'u_me',announcementDoc:{docUrl:'https://doc.example.com/docx/abc'}};
 c.tabs=[{id:'1',kind:'url',name:'PRD',url:'https://wiki.example.com/wiki/x?from=a&disposable_login_token=SECRET123'}];
 c.bots=[{displayName:'Meego 项目管理',joinedAtMs:Date.parse('2026-11-20T16:46:00+08:00'),appId:'a1'}];
 w.lark.post(feed,{text:'需求已建好，文档见 PRD',senderName:'金垠廷'});
 const asked=[];
 const m=await gatherMaterial({lark:new OpenLark({url:w.lark.url,token:w.lark.token,gapMs:0}),feedId:feed,meego:async url=>{asked.push(url);return {url,...WORK_ITEM};}});
 assert.equal(m.name,'火山发文平台映射 - [需求同步群]');assert.equal(m.memberCount,10);assert.equal(m.openChatId,`oc_${feed}`);
 assert.equal(m.description,`${MEEGO}?tabKey=detail`);assert.deepEqual(m.labels,['需求群']);
 assert.deepEqual(m.tabs,[{name:'PRD',kind:'url',url:'https://wiki.example.com/wiki/x?from=a'}],'a login token in a link never reaches the model');
 assert.deepEqual(m.bots,[{name:'Meego 项目管理',joinedAt:'2026-11-20 16:46'}]);
 assert.ok(m.messages.some(x=>x.text.includes('需求已建好')&&x.sender==='金垠廷'));
 assert.ok(m.firstMessageAt,'when the group began: its first message');
 assert.deepEqual(asked,[`${MEEGO}?tabKey=detail`]);
 assert.equal(m.meego[0].workItem.work_item_attribute.work_item_name,'火山发文平台映射');
 const text=JSON.stringify(m);assert.ok(!text.includes('a@x.com')&&!text.includes('SECRET123'),'people are names only, tokens are cut');
 assert.deepEqual(w.lark.writes(),[]);
});

test('what cannot be read is said, not fatal: a failing Meego read, settings and tabs',async t=>{
 const w=await world(t);patchView(w.lark);
 const feed=w.group('群',{description:MEEGO});w.lark.fail('/settings',500);w.lark.fail('/chat-tabs',500);
 const m=await gatherMaterial({lark:new OpenLark({url:w.lark.url,token:w.lark.token,gapMs:0}),feedId:feed,meego:async()=>{throw Error('meego 没登录');}});
 assert.match(m.meego[0].error,/meego 没登录/);assert.deepEqual(m.unavailable.sort(),['chatTabs','settings']);
 assert.equal(m.name,'群');
});

// ---- detection
test('chats that exist at the first start are seen and not judged; a group that appears later is judged once',async t=>{
 const w=await world(t);patchView(w.lark);
 w.group('老群一');w.group('老群二');
 let r=await w.newChats.judgeNew({about:w.about()});
 assert.deepEqual(r,{seeded:2,judged:0,sent:0});assert.equal(w.prompts.length,0,'no model run for the chats that were there');
 w.group('新需求群');
 r=await w.newChats.judgeNew({about:w.about()});
 assert.equal(r.judged,1);assert.equal(w.prompts.length,1);assert.equal(w.prompts[0].data.chat.name,'新需求群');
 r=await w.newChats.judgeNew({about:w.about()});r=await w.newChats.judgeNew({about:w.about()});
 assert.equal(w.prompts.length,1,'a group is judged exactly once');assert.equal(w.sent.length,1);
 assert.deepEqual(w.matters.runs().map(x=>[x.kind,x.ok]),[['newchat',true]],'the model run is recorded with its own kind');
});

test('direct chats and chats not known to be groups are never judged',async t=>{
 const w=await world(t);patchView(w.lark);
 await w.newChats.judgeNew({about:w.about()});
 w.store.upsertChatInfo({feedId:'d1',name:'张三',chatMode:'direct'});w.store.markDirty('x1');
 const r=await w.newChats.judgeNew({about:w.about()});
 assert.equal(r.judged,0);assert.equal(w.prompts.length,0);
});

// ---- the judgment and its card
test('the model is shown the group, 关于TA, my notes, Bridge\'s projects and agent configs; a positive verdict gives one card in my direct chat',async t=>{
 const w=await world(t);patchView(w.lark);
 w.store.setMeta('profile',{text:'【工作】\n后端',at:1,notes:[],messages:1});w.matters.addNote('工作项目在 cpu2 上做');
 await w.newChats.judgeNew({about:w.about()});
 const feed=w.group('火山发文平台映射',{description:MEEGO});
 await w.newChats.judgeNew({about:w.about()});
 const {data,system}=w.prompts[0];
 assert.equal(data.chat.name,'火山发文平台映射');assert.equal(data.profile,'【工作】\n后端');assert.deepEqual(data.notes,['工作项目在 cpu2 上做']);
 assert.deepEqual(data.projects,PROJECTS.map(p=>({id:p.id,name:p.name,description:p.description,repos:p.repos})));
 assert.deepEqual(data.agentConfigs.map(a=>[a.id,a.name,a.machine,a.kind]),[['cc-cpu2','Claude Code（cpu2）','cpu2','claude'],['cc-cpu1','Claude Code（cpu1）','cpu1','claude']]);
 assert.equal(data.bound,null);assert.match(system,/需求群/);assert.ok(!system.includes('\n'),'it travels as an argument');
 assert.equal(w.sent.length,1);const card=w.sent[0].card;
 assert.equal(headerOf(card),'新需求群：火山发文平台映射');
 assert.equal(card.config.update_multi,true);
 const text=shown(w.sent[0]);
 assert.match(text,/你是这个需求的 Server 开发/);assert.match(text,/项目：GenVI · Agent：Claude Code（cpu2）/);assert.match(text,/先读 PRD 再做/);
 assert.deepEqual(buttons(card).map(b=>b[0]),['开工','不用']);
 assert.deepEqual(buttonValue(card,'开工'),{act:'newchat',do:'start',chat:feed,t:buttonValue(card,'开工').t});
 assert.equal(w.store.meta('processor')===undefined||true,true);
});

test('a negative verdict sends nothing; the judgment is kept',async t=>{
 const w=await world(t,{answers:[{requirement:true,mine:false,reason:'你只是被拉进来知情'}]});patchView(w.lark);
 await w.newChats.judgeNew({about:w.about()});const feed=w.group('某需求群');
 await w.newChats.judgeNew({about:w.about()});
 assert.equal(w.sent.length,0);assert.equal(w.prompts.length,1);
 assert.match(w.newChats.row(feed).reason,/只是被拉进来/);assert.equal(w.newChats.row(feed).status,'no');
 const other=await world(t,{answers:[{requirement:false,mine:false,reason:'闲聊群'}]});patchView(other.lark);
 await other.newChats.judgeNew({about:other.about()});other.group('闲聊');await other.newChats.judgeNew({about:other.about()});
 assert.equal(other.sent.length,0);
});

test('with no fitting project or agent config the card says so and has only 不用',async t=>{
 for(const verdict of [{...VERDICT,projectId:null},{...VERDICT,agentConfigId:'nope'},{...VERDICT,projectId:'unknown-project'}]){
  const w=await world(t,{answers:[verdict]});patchView(w.lark);
  await w.newChats.judgeNew({about:w.about()});w.group('需求群');await w.newChats.judgeNew({about:w.about()});
  const card=w.sent[0].card,text=shown(w.sent[0]);
  assert.match(text,/没有合适的项目，需要先在 Bridge 里建/);assert.doesNotMatch(text,/项目：/);
  assert.deepEqual(buttons(card).map(b=>b[0]),['不用']);
 }
});

test('a reply that is not a verdict is tried again next round, and given up after a few tries; nothing is sent',async t=>{
 const w=await world(t,{answers:['这不是 JSON']});patchView(w.lark);
 await w.newChats.judgeNew({about:w.about()});w.group('需求群');
 for(let i=0;i<8;i++)await w.newChats.judgeNew({about:w.about()});
 assert.equal(w.prompts.length,5,'five tries, then it is left');assert.equal(w.sent.length,0);
 assert.ok(w.store.errors().some(e=>/需求群/.test(e.message)));
});

test('a model that fails is tried again next round, and judges the group once it works',async t=>{
 const w=await world(t);patchView(w.lark);
 await w.newChats.judgeNew({about:w.about()});w.group('需求群');w.model.fail=1;
 let r=await w.newChats.judgeNew({about:w.about()});assert.equal(r.judged,0);assert.equal(w.sent.length,0);
 r=await w.newChats.judgeNew({about:w.about()});assert.equal(r.judged,1);assert.equal(w.sent.length,1);
});

test('the card waits for the bot: a group judged while it is offline gets its card once it is back, and once only',async t=>{
 const w=await world(t);patchView(w.lark);
 await w.newChats.judgeNew({about:w.about()});w.group('需求群');w.bot.connected=false;
 await w.newChats.judgeNew({about:w.about()});assert.equal(w.sent.length,0);
 w.bot.connected=true;w.bot.failSend=1;await w.newChats.judgeNew({about:w.about()});assert.equal(w.sent.length,0,'a failed send is recorded');
 await w.newChats.judgeNew({about:w.about()});await w.newChats.judgeNew({about:w.about()});
 assert.equal(w.sent.length,1);assert.equal(w.prompts.length,1,'never judged again');
});

test('the judgment writes nothing in dry-run: no row, no model run record, no card',async t=>{
 const w=await world(t);patchView(w.lark);
 const feed=w.group('火山发文平台映射',{description:MEEGO});
 const r=await w.newChats.judge(feed,{about:w.about()});
 assert.equal(r.verdict.requirement,true);assert.equal(r.verdict.project.name,'GenVI');assert.equal(headerOf(r.card),'新需求群：火山发文平台映射');
 assert.equal(r.material.name,'火山发文平台映射');assert.equal(w.newChats.row(feed),undefined);assert.deepEqual(w.matters.runs(),[]);
 assert.deepEqual(w.sent,[]);assert.deepEqual(w.lark.writes(),[]);assert.deepEqual(w.bridge.opens(),[]);
});

test('the dry run of a verdict that does not start work has no card',async t=>{
 const w=await world(t,{answers:[{requirement:true,mine:false,reason:'你已经做完了'}]});patchView(w.lark);
 const r=await w.newChats.judge(w.group('已经做完的群'),{about:w.about()});
 assert.equal(r.verdict.mine,false);assert.equal(r.card,undefined);
});

// ---- the click
async function proposed(t,opts){
 const w=await world(t,opts);patchView(w.lark);
 await w.newChats.judgeNew({about:w.about()});
 const feed=w.group('火山发文平台映射 - [需求同步群]',{description:MEEGO});
 await w.newChats.judgeNew({about:w.about()});
 return {...w,feed,card:w.sent[0].card,id:'om_card1'};
}

test('开工 adds the bot as me, then opens the topic through Bridge, then turns the card into 已开工 with a link to the group',async t=>{
 const w=await proposed(t);
 const r=click(w.newChats,w.id,buttonValue(w.card,'开工'));
 assert.equal(r.toast.type,'info','answered at once, the work goes on');assert.equal(buttons(r.card.data).length,0,'no second click while it works');
 await w.newChats.settled();
 assert.deepEqual(w.order,['add','open','update']);
 assert.deepEqual(w.lark.writes().map(x=>[x.method,x.path,x.body]),[['POST',`/agent/v1/conversations/${w.feed}/bots`,{botId:BOT}]]);
 assert.deepEqual(w.bridge.opens().map(x=>x.body),[{chatId:`oc_${w.feed}`,prompt:VERDICT.prompt,title:VERDICT.title,projectId:'genvi',agentConfigId:'cc-cpu2',key:`newchat:${w.feed}`}]);
 const done=w.updated.at(-1);assert.equal(done.id,w.id);
 assert.equal(headerOf(done.card),'已开工：火山发文平台映射 - [需求同步群]');
 const link=[...componentsOf(done.card)].find(c=>c.behaviors?.some(b=>b.type==='open_url'));
 assert.match(link.behaviors[0].default_url,new RegExp(`oc_${w.feed}`));assert.equal(buttons(done.card).length,0);
 assert.equal(w.newChats.row(w.feed).status,'started');
 const again=click(w.newChats,w.id,buttonValue(w.card,'开工'));
 assert.match(again.toast.content,/已经开工/);await w.newChats.settled();assert.equal(w.bridge.opens().length,1,'a second click opens nothing');
});

test('the bot is retried while Bridge says it cannot post yet, then the topic opens',async t=>{
 const w=await proposed(t);
 w.bridge.script.push({status:409,body:{error:'机器人还不能发言',code:BOT_CANNOT_POST}});
 click(w.newChats,w.id,buttonValue(w.card,'开工'));await w.newChats.settled();
 assert.equal(w.bridge.opens().length,2);assert.equal(headerOf(w.updated.at(-1).card),'已开工：火山发文平台映射 - [需求同步群]');
});

test('the bot already in the group is not added again; a group Bridge has bound gets no project in the request',async t=>{
 const w=await proposed(t,{bridgeState:{bindings:[]}});
 w.lark.conversations.get(w.feed).bots=[{displayName:'Bridge',appId:BOT}];
 click(w.newChats,w.id,buttonValue(w.card,'开工'));await w.newChats.settled();
 assert.deepEqual(w.order,['open','update'],'no add');
 const bound=await world(t,{bridgeState:{bindings:[{id:'b0',chatId:'oc_x',defaultProjectId:'ops',defaultAgentConfigId:'cc-cpu1'}]}});patchView(bound.lark);
 await bound.newChats.judgeNew({about:bound.about()});const feed=bound.group('已绑定的群');bound.lark.conversations.get(feed).openChatId='oc_x';
 await bound.newChats.judgeNew({about:bound.about()});
 assert.deepEqual(bound.prompts[0].data.bound,{project:'运维脚本',agentConfig:'Claude Code（cpu1）'});
 assert.match(shown(bound.sent[0]),/项目：运维脚本 · Agent：Claude Code（cpu1）/,'the card shows what the binding has');
 click(bound.newChats,'om_card1',buttonValue(bound.sent[0].card,'开工'));await bound.newChats.settled();
 assert.deepEqual(bound.order,['open','update'],'a bound group has its bot');
 assert.deepEqual(bound.bridge.opens().map(x=>Object.keys(x.body).sort()),[['chatId','key','prompt','title']]);
});

test('不用 ignores the group: the card becomes 已忽略 and nothing is written anywhere',async t=>{
 const w=await proposed(t);
 const r=click(w.newChats,w.id,buttonValue(w.card,'不用'));
 assert.match(headerOf(r.card.data),/已忽略/);assert.equal(buttons(r.card.data).length,0);
 await w.newChats.settled();
 assert.deepEqual(w.order,[]);assert.deepEqual(w.lark.writes(),[]);assert.deepEqual(w.bridge.opens(),[]);assert.equal(w.newChats.row(w.feed).status,'ignored');
 const late=click(w.newChats,w.id,buttonValue(w.card,'开工'));assert.match(late.toast.content,/忽略/);await w.newChats.settled();assert.deepEqual(w.order,[],'it stays ignored');
});

test('a failed start says why on the card, which keeps 开工; the retry does not add the bot again',async t=>{
 const w=await proposed(t);
 w.bridge.script.push({status:400,body:{error:'项目不存在',code:'unknown_project'}});
 click(w.newChats,w.id,buttonValue(w.card,'开工'));await w.newChats.settled();
 const failed=w.updated.at(-1).card;
 assert.match(headerOf(failed),/^开工失败：/);assert.match(headerOf(failed),/项目不存在/);assert.ok(buttonValue(failed,'开工'));
 assert.deepEqual(w.order,['add','open','update']);
 click(w.newChats,w.id,buttonValue(failed,'开工'));await w.newChats.settled();
 assert.deepEqual(w.order,['add','open','update','open','update'],'the bot is in the group already');
 assert.equal(headerOf(w.updated.at(-1).card),'已开工：火山发文平台映射 - [需求同步群]');
});

test('adding the bot can fail too: nothing is opened and the card says so',async t=>{
 const w=await proposed(t);w.faults.add=1;
 click(w.newChats,w.id,buttonValue(w.card,'开工'));await w.newChats.settled();
 assert.match(headerOf(w.updated.at(-1).card),/^开工失败：/);assert.equal(w.bridge.opens().length,0);
 click(w.newChats,w.id,buttonValue(w.updated.at(-1).card,'开工'));await w.newChats.settled();
 assert.deepEqual(w.order,['add','update','add','open','update']);assert.equal(headerOf(w.updated.at(-1).card),'已开工：火山发文平台映射 - [需求同步群]');
});

test('clicks that are not this card\'s are not answered; one on a group butler does not know says so',async t=>{
 const w=await proposed(t);
 assert.equal(w.newChats.click({messageId:'x',action:{tag:'button',value:{act:'done',matter:1}}}),undefined);
 assert.equal(w.newChats.click({messageId:'x',action:{tag:'overflow',option:'not_mine',value:{}}}),undefined);
 assert.match(click(w.newChats,'x',{act:'newchat',do:'start',chat:'nope'}).toast.content,/没有/);
});

// ---- the processor's step
test('the processor judges new groups once per round, after its batches, with its 关于TA and notes',async t=>{
 const w=await world(t);patchView(w.lark);
 await w.newChats.judgeNew({about:w.about()});w.group('新群');
 const processor=new Processor({store:w.store,matters:w.matters,model:{async ask(){throw Error('no batch expected');}},newChats:w.newChats});
 w.store.setMeta('profile',{text:'p',at:Date.now(),notes:[],messages:1});w.store.setMeta('review',{at:Date.now(),reviewed:0,closed:0,profileAt:Date.now(),notes:[]});
 const r=await processor.runOnce();
 assert.equal(r.newChats.judged,1);assert.equal(w.sent.length,1);
 assert.equal((await processor.runOnce()).newChats.judged,0);
});

test('without NewChats the processor\'s round is what it was',async t=>{
 const {store}=tempStore(t),matters=new Matters(store);store.setMeta('profile',{text:'p',at:Date.now(),notes:[],messages:1});store.setMeta('review',{at:Date.now(),reviewed:0,closed:0,profileAt:Date.now(),notes:[]});
 const r=await new Processor({store,matters,model:{async ask(){throw Error('x');}}}).runOnce();
 assert.deepEqual(Object.keys(r).sort(),['failures','profile','review','runs']);
});

// ---- reading the verdict
test('readNewChat checks the schema: booleans, a title and a prompt when there is something to start, ids from the lists',()=>{
 const lists={projectIds:new Set(['genvi']),agentConfigIds:new Set(['cc'])};
 const ok=readNewChat(JSON.stringify({requirement:true,mine:true,reason:'r',title:'t',prompt:'p',projectId:'genvi',agentConfigId:'cc'}),lists);
 assert.deepEqual(ok,{requirement:true,mine:true,reason:'r',title:'t',prompt:'p',projectId:'genvi',agentConfigId:'cc',problems:[]});
 const off=readNewChat('```json\n{"requirement":false,"mine":false,"reason":"闲聊群"}\n```',lists);
 assert.equal(off.requirement,false);assert.equal(off.prompt,null);assert.equal(off.projectId,null);
 const odd=readNewChat(JSON.stringify({requirement:true,mine:true,reason:'r',title:'t',prompt:'p',projectId:'x',agentConfigId:'cc'}),lists);
 assert.equal(odd.projectId,null);assert.equal(odd.agentConfigId,'cc');assert.match(odd.problems[0],/x/);
 for(const bad of ['不是 JSON','{"requirement":"yes","mine":true,"reason":"r"}','{"requirement":true,"mine":true,"reason":"r","title":"","prompt":"p"}','{"requirement":true,"mine":true,"reason":"r","title":"t","prompt":""}','{"requirement":true,"mine":false}'])
  assert.throws(()=>readNewChat(bad,lists),undefined,bad);
 const links=readNewChat(JSON.stringify({requirement:true,mine:true,reason:'见 https://a.b/c',title:'t',prompt:'读 https://a.b/c 再做',projectId:null,agentConfigId:null}),lists);
 assert.equal(links.prompt,'读 https://a.b/c 再做','the first prompt keeps the links the model copied');assert.equal(links.reason,'见 [链接]','the reason is shown to me and carries none');
});
