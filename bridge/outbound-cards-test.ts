// Tests of outbound-cards.ts (see package.json); run with node --test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceLine,sourceCard,draftCard} from './outbound-cards.ts';
import type {Address,Body} from './outbound-cards.ts';
import type {OwnerMessage} from './link.ts';
import type {Delivery} from './task-types.ts';

// Local wall times keep the same-day cases independent of the machine's time zone.
const local=(year:number,month:number,day:number,hour:number,minute:number)=>new Date(year,month-1,day,hour,minute).getTime();
const now=local(2026,11,11,15,30),today=local(2026,11,11,12,45),old=local(2026,1,2,10,49);
const privateSource:OwnerMessage={chatId:'feed-private',chatName:'孙栎倩',chatType:'p2p',messageId:'message-private',sender:{id:'user-sun',name:'孙栎倩'},at:today,text:'私聊原文'};
const groupSource:OwnerMessage={chatId:'feed-group',chatName:'GEO 小分队',chatType:'group',messageId:'message-group',sender:{id:'user-chen',name:'陈帆'},at:old,text:'群里的原文'};
// A delivery of a message to the owner's channel in the state of the test, with its address and body.
const delivery=(id:string,to:Address,body:Body,over:Partial<Delivery>={}):Delivery=>({id,task:'task-1',output:'output-1',target:{sink:'as-owner',to},body,key:'key-1',state:'awaiting',receipt:null,error:null,createdAt:today,...over});
const privateDraft=delivery('draft-private',{chatId:privateSource.chatId,chatName:privateSource.chatName,chatType:'p2p'},{text:'@孙栎倩 **不要加粗**\n[不要变成链接](https://invalid.example)',mentions:[]});
const groupDraft=delivery('draft-group',{chatId:groupSource.chatId,chatName:groupSource.chatName,chatType:'group',replyTo:groupSource.messageId},{text:'@陈帆 请看一下',mentions:[{id:'user-chen',name:'陈帆'}]},{state:'failed',error:'open-lark 没有响应'});
const textOf=(d:Delivery)=>(d.body as Body).text;

// Expected card building blocks, kept independent of the implementation's helpers.
const plain=(content:string,style:object={})=>({tag:'div',text:{tag:'plain_text',content,...style}});
const grey=(content:string)=>plain(content,{text_size:'notation',text_color:'grey'});
// Bold titles use the card's markdown, with every dynamic character kept literal.
const escapeMarkdown=(content:string)=>content.replace(/[\\`*_{}\[\]()#+\-.!|<>~]/g,'\\$&');
const heading=(content:string)=>({tag:'markdown',content:`**${escapeMarkdown(content)}**`});
// A draft body is a grey column_set holding one weighted column.
const quote=(content:string)=>({tag:'column_set',background_style:'grey',columns:[{tag:'column',width:'weighted',weight:1,elements:[plain(content)]}]});
const untitled=(summary:string,elements:object[],updateMulti=false)=>({schema:'2.0',config:{...updateMulti&&{update_multi:true},summary:{content:summary}},body:{elements}});
const callbackButton=(content:string,type:string,value:object)=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value}]}]});
const actions=(d:Delivery,render:number)=>({tag:'column_set',horizontal_spacing:'8px',columns:[
 callbackButton('发送','primary',{draft:'send',deliveryId:d.id,render}),
 callbackButton('修改','default',{draft:'edit',deliveryId:d.id,render}),
 callbackButton('不发','default',{draft:'drop',deliveryId:d.id,render}),
]});

test('sourceLine names the sender, a direct chat as 私聊 or the group, and a local time with the date outside today',()=>{
 assert.equal(sourceLine(privateSource,now),'孙栎倩 · 私聊 · 12:45');
 assert.equal(sourceLine(groupSource,now),'陈帆 · GEO 小分队 · 1月2日 10:49');
 assert.equal(sourceLine({...privateSource,at:local(2026,11,11,9,5)},now),'孙栎倩 · 私聊 · 09:05');
 assert.equal(sourceLine({...privateSource,at:local(2025,11,11,12,45)},now),'孙栎倩 · 私聊 · 11月11日 12:45');
});

test('a source card is an untitled grey source line and the untouched plain message text, with an optional link component',()=>{
 const message:OwnerMessage={...privateSource,text:'**原文**\n[图片]\n[文件] 方案.pdf',link:'https://feishu.example/original'};
 const line='孙栎倩 · 私聊 · 12:45';
 assert.deepEqual(sourceCard(message,now),untitled(line,[
  grey(line),plain(message.text),
  {tag:'button',text:{tag:'plain_text',content:'查看原消息'},type:'default',behaviors:[{type:'open_url',default_url:message.link}]},
 ],true));
 const groupMessage:OwnerMessage=groupSource;
 const groupLine='陈帆 · GEO 小分队 · 1月2日 10:49';
 assert.deepEqual(sourceCard(groupMessage,now),untitled(groupLine,[grey(groupLine),plain(groupMessage.text)]));
});

test('a pending private draft has its destination, identity, quoted plain text and three callbacks with the render number',()=>{
 const title='回复 孙栎倩',about='发到你和 孙栎倩 的私聊，以你的身份发送';
 assert.deepEqual(draftCard(privateDraft,'pending',{render:7,now}),untitled(title,[
  heading(title),grey(about),quote(textOf(privateDraft)),actions(privateDraft,7),
 ],true));
});

test('a bold draft title escapes markdown punctuation in the chat name',()=>{
 const d=delivery('d',{chatId:'c',chatType:'group',chatName:'*重点* [入口](x)'},{text:'正文',mentions:[]});
 const card=draftCard(d,'pending',{render:8,now}) as any;
 assert.deepEqual(card.body.elements[0],{tag:'markdown',content:String.raw`**发到 \*重点\* \[入口\]\(x\)**`});
});

test('a pending draft of a failed delivery shows the delivery error unless a failure is given, and a draft without one shows none',()=>{
 const shown=(failure?:string)=>JSON.stringify(draftCard(groupDraft,'pending',{render:1,now,...failure&&{failure}}));
 assert.match(shown(),/发送失败：open-lark 没有响应/);assert.match(shown('正文不能为空'),/发送失败：正文不能为空/);assert.doesNotMatch(shown('正文不能为空'),/open-lark 没有响应/);
 assert.doesNotMatch(JSON.stringify(draftCard(privateDraft,'pending',{render:1,now})),/发送失败/);
});

test('a pending group draft adds a failure above its text and describes the quoted source with a non-today time',()=>{
 const title='发到 GEO 小分队',about='以你的身份发送，引用 陈帆 1月2日 10:49 的消息';
 assert.deepEqual(draftCard(groupDraft,'pending',{render:8,now,quoted:groupSource}),untitled(title,[
  heading(title),grey(about),plain('发送失败：open-lark 没有响应'),quote(textOf(groupDraft)),actions(groupDraft,8),
 ],true));
});

test('a reply that goes into the thread of its source says so after the quoted source, also while it is edited',()=>{
 const d=delivery('draft-thread',{chatId:groupSource.chatId,chatName:groupSource.chatName,chatType:'group',replyTo:groupSource.messageId,thread:true},{text:'跟进一下',mentions:[]});
 const title='发到 GEO 小分队',about='以你的身份发送，引用 陈帆 1月2日 10:49 的消息，发在话题里';
 assert.deepEqual(draftCard(d,'pending',{render:4,now,quoted:groupSource}),untitled(title,[heading(title),grey(about),quote('跟进一下'),actions(d,4)],true));
 assert.deepEqual((draftCard(d,'editing',{render:5,now,quoted:groupSource}) as any).body.elements[1],grey(about));
});

test('an editing draft is a form with a multiline text input prefilled verbatim and submit and cancel callbacks',()=>{
 const title='回复 孙栎倩',about='发到你和 孙栎倩 的私聊，以你的身份发送';
 const card=draftCard(privateDraft,'editing',{render:9,now}) as ReturnType<typeof untitled>&{body:{elements:any[]}};
 assert.equal(card.config.summary.content,title);assert.equal(card.config.update_multi,true);
 assert.deepEqual(card.body.elements.slice(0,2),[heading(title),grey(about)]);
 assert.equal(card.body.elements.length,3);
 const form=card.body.elements[2];
 assert.equal(form.tag,'form');assert.equal(form.name,'draft');assert.equal(form.elements.length,3);
 assert.deepEqual(form.elements[0],{tag:'input',name:'text',input_type:'multiline_text',width:'fill',default_value:textOf(privateDraft)});
 assert.deepEqual(form.elements[1],{tag:'button',text:{tag:'plain_text',content:'发送'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{draft:'send',deliveryId:privateDraft.id,render:9}}]});
 assert.deepEqual(form.elements[2],{tag:'button',text:{tag:'plain_text',content:'取消'},type:'default',behaviors:[{type:'callback',value:{draft:'cancel',deliveryId:privateDraft.id,render:9}}]});
});

test('sent, dropped and withdrawn drafts retain their destination and text, show their outcome and have no buttons',()=>{
 const sent=delivery('draft-group',{chatId:groupSource.chatId,chatName:groupSource.chatName,chatType:'group'},groupDraft.body as Body,{state:'delivered',receipt:{messageId:'sent-message',at:old,owner:'主人'}});
 const sentTitle='发到 GEO 小分队';
 assert.deepEqual(draftCard(sent,'sent',{render:10,now}),untitled(sentTitle,[
  heading(sentTitle),grey('以你的身份发送'),quote(textOf(sent)),plain('已发送给 GEO 小分队 · 1月2日 10:49'),
 ],true));
 const dropped:Delivery={...privateDraft,state:'rejected'};
 const droppedTitle='回复 孙栎倩';
 assert.deepEqual(draftCard(dropped,'dropped',{render:11,now}),untitled(droppedTitle,[
  heading(droppedTitle),grey('发到你和 孙栎倩 的私聊，以你的身份发送'),quote(textOf(dropped)),plain('未发送'),
 ],true));
 assert.deepEqual(draftCard(dropped,'withdrawn',{render:12,now}),untitled(droppedTitle,[
  heading(droppedTitle),grey('发到你和 孙栎倩 的私聊，以你的身份发送'),quote(textOf(dropped)),plain('Agent 已撤回'),
 ],true));
});

test('all fixed wording avoids 他 and 她, and message and draft bodies stay in plain_text rather than markdown',()=>{
 const message:OwnerMessage={...privateSource,text:'**不解析** [图片] [链接](https://invalid.example)'};
 const cards=[sourceCard(message,now),draftCard(privateDraft,'pending',{render:1,now}),draftCard(privateDraft,'editing',{render:2,now}),draftCard(groupDraft,'pending',{render:3,now,quoted:groupSource})];
 const texts:string[]=[];
 const visit=(value:unknown)=>{
  if(Array.isArray(value)){for(const item of value)visit(item);return;}
  if(!value||typeof value!=='object')return;
  const item=value as Record<string,unknown>;
  if(item.tag==='markdown')assert.match(String(item.content),/^\*\*(?:回复|发到) /);
  if(item.tag==='plain_text'){const content=String(item.content);assert.doesNotMatch(content,/[他她]/);texts.push(content);}
  for(const nested of Object.values(item))visit(nested);
 };
 for(const card of cards)visit(card);
 assert.ok(texts.includes(message.text));assert.ok(texts.includes(textOf(privateDraft)));
});

// A group draft with an image and a file after its text and edit access for the docs it links, before and after it went out.
const ids=['00000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-00000000000b'];
const attached=delivery('draft-files',{chatId:groupSource.chatId,chatName:groupSource.chatName,chatType:'group'},{text:'方案见 https://example.feishu.cn/docx/abc 和 https://example.feishu.cn/sheets/def。',mentions:[],
 attachments:[{kind:'image',name:'截图.png',size:900,id:ids[0]},{kind:'file',name:'季度报告.pdf',size:3.25*1024*1024,id:ids[1]}],docAccess:'edit'});
const files=plain('正文之后发送：\n图片 截图.png · 900 B\n文件 季度报告.pdf · 3.3 MB');
const access=plain('发出后给这个聊天开放文档的编辑权限：\nhttps://example.feishu.cn/docx/abc\nhttps://example.feishu.cn/sheets/def');
const attachedSent=(docs:object)=>({...attached,state:'delivered' as const,receipt:{messageId:'s1',at:old,owner:'主人',attachments:['s2',null],...docs}});

test('a draft with attachments and doc access lists every attachment with its size and the links whose access opens, while pending and while edited',()=>{
 const title='发到 GEO 小分队';
 assert.deepEqual(draftCard(attached,'pending',{render:3,now}),untitled(title,[heading(title),grey('以你的身份发送'),quote(textOf(attached)),files,access,actions(attached,3)],true));
 const editing=(draftCard(attached,'editing',{render:4,now}) as any).body.elements;
 assert.deepEqual(editing.slice(0,4),[heading(title),grey('以你的身份发送'),files,access]);assert.equal(editing[4].tag,'form');
 const unlinked=delivery('d',{chatId:'c',chatName:'群',chatType:'group'},{text:'链接被改掉了',mentions:[],docAccess:'view'});
 assert.deepEqual((draftCard(unlinked,'pending',{render:5,now}) as any).body.elements[3],plain('发出后给这个聊天开放文档的查看权限：\n正文里没有链接'));
 assert.equal(JSON.stringify(draftCard(privateDraft,'pending',{render:6,now})).includes('正文之后发送'),false);
});

test('a sent draft with doc access says how many docs got access and which did not and why, or that none were found or the request failed',()=>{
 const title='发到 GEO 小分队',top=[heading(title),grey('以你的身份发送'),quote(textOf(attached)),files,access,plain('已发送给 GEO 小分队 · 1月2日 10:49')];
 const shown=(docs:object)=>draftCard(attachedSent(docs),'sent',{render:7,now});
 const doc=(title:string,granted:boolean,reason?:string)=>({url:'https://example.feishu.cn/'+title,title,granted,...reason&&{reason}});
 assert.deepEqual(shown({docs:[doc('方案',true),doc('表格',true)]}),untitled(title,[...top,plain('已给这个聊天开放 2 个文档的编辑权限')],true));
 assert.deepEqual(shown({docs:[doc('方案',true),doc('表格',false,'只能开放查看权限')]}),untitled(title,[...top,plain('已给这个聊天开放 1 个文档的编辑权限\n没有开放：表格：只能开放查看权限')],true));
 assert.deepEqual(shown({docs:[doc('',false,'不能开放编辑权限')]}),untitled(title,[...top,plain('没有开放：https://example.feishu.cn/：不能开放编辑权限')],true));
 assert.deepEqual(shown({docs:[]}),untitled(title,[...top,plain('没有找到可以开放权限的文档')],true));
 assert.deepEqual(shown({docs:[],docsError:'open-lark 没有响应'}),untitled(title,[...top,plain('文档权限没有开放：open-lark 没有响应')],true));
});

test('once the text of a draft went out, its pending card has no 修改 and its dropped card says what went out',()=>{
 const failed:Delivery={...attached,state:'failed',error:'正文和前 1 个附件已发出，文件 季度报告.pdf 没有发出去：open-lark 没有响应'};
 const progress={text:{messageId:'s1',at:old,owner:'主人'},attachments:{[ids[0]]:'s2'}},title='发到 GEO 小分队';
 assert.deepEqual(draftCard(failed,'pending',{render:8,now,progress}),untitled(title,[heading(title),grey('以你的身份发送'),plain('发送失败：'+failed.error),quote(textOf(attached)),files,access,
  {tag:'column_set',horizontal_spacing:'8px',columns:[callbackButton('发送','primary',{draft:'send',deliveryId:failed.id,render:8}),callbackButton('不发','default',{draft:'drop',deliveryId:failed.id,render:8})]}],true));
 assert.deepEqual((draftCard({...failed,state:'rejected'},'dropped',{render:9,now,progress}) as any).body.elements.at(-1),plain('已发出正文和 1 个附件，其余未发送'));
 assert.deepEqual((draftCard({...failed,state:'rejected'},'dropped',{render:9,now,progress:{...progress,attachments:{}}}) as any).body.elements.at(-1),plain('已发出正文，其余未发送'));
 assert.deepEqual((draftCard({...failed,state:'rejected'},'dropped',{render:9,now,progress:{attachments:{}}}) as any).body.elements.at(-1),plain('未发送'));
});

// The tags of the cards that Bridge already posts elsewhere (message-cards.ts, request-cards.ts, schedule-cards.ts), which Feishu has accepted.
const knownTags=new Set(['button','column','column_set','div','form','input','markdown','multi_select_static','plain_text','select_static']);
test('no outbound card uses a tag that the other Bridge cards do not use',()=>{
 const tags=new Set<string>();
 const visit=(value:unknown)=>{
  if(Array.isArray(value)){for(const item of value)visit(item);return;}
  if(!value||typeof value!=='object')return;
  const item=value as Record<string,unknown>;
  if(typeof item.tag==='string')tags.add(item.tag);
  for(const nested of Object.values(item))visit(nested);
 };
 const message:OwnerMessage={...privateSource,text:'原消息'};
 const sent:Delivery={...privateDraft,state:'delivered',receipt:{messageId:'s',at:now,owner:'主人'}};
 const dropped:Delivery={...privateDraft,state:'rejected'};
 const cards=[sourceCard(message,now),...(['pending','editing'] as const).flatMap(view=>[draftCard(privateDraft,view,{render:1,now}),draftCard(groupDraft,view,{render:2,now,quoted:groupSource}),draftCard({...privateDraft,state:'failed',error:'失败'},view,{render:3,now})]),draftCard(sent,'sent',{render:4,now}),draftCard(dropped,'dropped',{render:5,now}),draftCard(dropped,'withdrawn',{render:6,now}),draftCard(attached,'pending',{render:7,now}),draftCard(attachedSent({docs:[]}),'sent',{render:8,now})];
 for(const card of cards)visit(card);
 assert.deepEqual([...tags].filter(tag=>!knownTags.has(tag)),[]);
});
