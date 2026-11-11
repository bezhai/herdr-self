// Tests of outbound-cards.ts (see package.json); run with node --test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceLine,sourceCard,draftCard} from './outbound-cards.ts';
import type {Draft,Source} from './state.ts';
import type {OwnerMessage} from './link.ts';

// Local wall times keep the same-day cases independent of the machine's time zone.
const local=(year:number,month:number,day:number,hour:number,minute:number)=>new Date(year,month-1,day,hour,minute).getTime();
const now=local(2026,11,11,15,30),today=local(2026,11,11,12,45),old=local(2026,1,2,10,49);
const privateSource:Source={chatId:'feed-private',chatName:'孙栎倩',chatType:'p2p',messageId:'message-private',sender:{id:'user-sun',name:'孙栎倩'},at:today};
const groupSource:Source={chatId:'feed-group',chatName:'GEO 小分队',chatType:'group',messageId:'message-group',sender:{id:'user-chen',name:'陈帆'},at:old};
const privateDraft:Draft={chatId:privateSource.chatId,chatName:privateSource.chatName,chatType:'p2p',id:'draft-private',mentions:[],text:'@孙栎倩 **不要加粗**\n[不要变成链接](https://invalid.example)',clientId:'client-private',state:'pending',createdAt:today};
const groupDraft:Draft={chatId:groupSource.chatId,chatName:groupSource.chatName,chatType:'group',id:'draft-group',replyTo:groupSource.messageId,mentions:[{id:'user-chen',name:'陈帆'}],text:'@陈帆 请看一下',clientId:'client-group',state:'pending',failure:'open-lark 没有响应',createdAt:today};

// Expected card building blocks, kept independent of the implementation's helpers.
const plain=(content:string,style:object={})=>({tag:'div',text:{tag:'plain_text',content,...style}});
const grey=(content:string)=>plain(content,{text_size:'notation',text_color:'grey'});
const heading=(content:string)=>plain(content,{text_size:'heading-4'});
const quote=(content:string)=>({tag:'quote_container',elements:[plain(content)]});
const untitled=(summary:string,elements:object[],updateMulti=false)=>({schema:'2.0',config:{...updateMulti&&{update_multi:true},summary:{content:summary}},body:{elements}});
const callbackButton=(content:string,type:string,value:object)=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value}]}]});
const actions=(d:Draft,render:number)=>({tag:'column_set',horizontal_spacing:'8px',columns:[
 callbackButton('发送','primary',{draft:'send',draftId:d.id,render}),
 callbackButton('修改','default',{draft:'edit',draftId:d.id,render}),
 callbackButton('不发','default',{draft:'drop',draftId:d.id,render}),
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
 ]));
 const groupMessage:OwnerMessage={...groupSource,text:'群里的原文'};
 const groupLine='陈帆 · GEO 小分队 · 1月2日 10:49';
 assert.deepEqual(sourceCard(groupMessage,now),untitled(groupLine,[grey(groupLine),plain(groupMessage.text)]));
});

test('a pending private draft has its destination, identity, quoted plain text and three callbacks with the render number',()=>{
 const title='回复 孙栎倩',about='发到你和 孙栎倩 的私聊，以你的身份发送';
 assert.deepEqual(draftCard(privateDraft,'pending',{render:7,now}),untitled(title,[
  heading(title),grey(about),quote(privateDraft.text),actions(privateDraft,7),
 ],true));
});

test('a pending group draft adds a failure above its text and describes the quoted source with a non-today time',()=>{
 const title='发到 GEO 小分队',about='以你的身份发送，引用 陈帆 1月2日 10:49 的消息';
 assert.deepEqual(draftCard(groupDraft,'pending',{render:8,now,quoted:groupSource}),untitled(title,[
  heading(title),grey(about),plain('发送失败：open-lark 没有响应'),quote(groupDraft.text),actions(groupDraft,8),
 ],true));
});

test('an editing draft is a form with a multiline text input prefilled verbatim and submit and cancel callbacks',()=>{
 const title='回复 孙栎倩',about='发到你和 孙栎倩 的私聊，以你的身份发送';
 const card=draftCard(privateDraft,'editing',{render:9,now}) as ReturnType<typeof untitled>&{body:{elements:any[]}};
 assert.equal(card.config.summary.content,title);assert.equal(card.config.update_multi,true);
 assert.deepEqual(card.body.elements.slice(0,2),[heading(title),grey(about)]);
 assert.equal(card.body.elements.length,3);
 const form=card.body.elements[2];
 assert.equal(form.tag,'form');assert.equal(form.name,'draft');assert.equal(form.elements.length,3);
 assert.deepEqual(form.elements[0],{tag:'input',name:'text',input_type:'multiline_text',width:'fill',default_value:privateDraft.text});
 assert.deepEqual(form.elements[1],{tag:'button',text:{tag:'plain_text',content:'发送'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{draft:'send',draftId:privateDraft.id,render:9}}]});
 assert.deepEqual(form.elements[2],{tag:'button',text:{tag:'plain_text',content:'取消'},type:'default',behaviors:[{type:'callback',value:{draft:'cancel',draftId:privateDraft.id,render:9}}]});
});

test('sent and dropped drafts retain their destination and text, show their outcome and have no buttons',()=>{
 const sent:Draft={...groupDraft,state:'sent',replyTo:undefined,failure:undefined,sentId:'sent-message',sentAt:old};
 const sentTitle='发到 GEO 小分队';
 assert.deepEqual(draftCard(sent,'sent',{render:10,now}),untitled(sentTitle,[
  heading(sentTitle),grey('以你的身份发送'),quote(sent.text),plain('已发送给 GEO 小分队 · 1月2日 10:49'),
 ],true));
 const dropped:Draft={...privateDraft,state:'dropped'};
 const droppedTitle='回复 孙栎倩';
 assert.deepEqual(draftCard(dropped,'dropped',{render:11,now}),untitled(droppedTitle,[
  heading(droppedTitle),grey('发到你和 孙栎倩 的私聊，以你的身份发送'),quote(dropped.text),plain('未发送'),
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
  assert.notEqual(item.tag,'markdown');assert.notEqual(item.tag,'lark_md');
  if(item.tag==='plain_text'){const content=String(item.content);assert.doesNotMatch(content,/[他她]/);texts.push(content);}
  for(const nested of Object.values(item))visit(nested);
 };
 for(const card of cards)visit(card);
 assert.ok(texts.includes(message.text));assert.ok(texts.includes(privateDraft.text));
});
