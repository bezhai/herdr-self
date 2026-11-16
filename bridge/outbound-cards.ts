import {plain,submitForm} from './request-cards.ts';
import {untitled} from './message-cards.ts';
import type {ButtonValue} from './request-cards.ts';
import type {Mention,OwnerChat} from './state.ts';
import type {OwnerMessage} from './link.ts';
import type {Delivery} from './task-types.ts';
// Feishu cards (JSON 2.0) of the owner's channel in the thread of a topic (see Messages), which the bot posts without a header like the other
// status cards of Bridge (see message-cards.ts): the card of a message that the agent brought in, and the card of a message that it drafted
// to send as the owner. They name people and chats by their names only, never 他 or 她. A time shows as HH:mm on the day of now, else as
// M月D日 HH:mm, in the time zone of the process. Message bodies from Feishu or the agent are shown as plain text, never as markdown; a draft
// title uses the card's markdown only for bold, with its chat name escaped. bridge-message imports this module too (see sourceLine), so it loads
// only Node's built-in modules and the modules above.

// A plain-text block with a documented JSON 2.0 text style, used here for grey notes.
const styled=(content:string,style:object)=>({tag:'div',text:{tag:'plain_text',content,...style}});
// Secondary text is small and grey.
const grey=(content:string)=>styled(content,{text_size:'notation',text_color:'grey'});
// Markdown punctuation in a chat name stays literal inside the fixed bold markers of a title.
const escapeMarkdown=(content:string)=>content.replace(/[\\`*_{}\[\]()#+\-.!|<>~]/g,'\\$&');
// A draft's destination is a bold title line, not the card's header.
const heading=(content:string)=>({tag:'markdown',content:`**${escapeMarkdown(content)}**`});
// A draft body keeps its exact text in a grey block, a column_set of one column, because JSON 2.0 has no quote container.
const quote=(content:string)=>({tag:'column_set',background_style:'grey',columns:[{tag:'column',width:'weighted',weight:1,elements:[plain(content)]}]});
// A button that reports its action and this drawing's render number.
const click=(content:string,type:string,value:ButtonValue)=>({tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value}]});
// An action in the row under a pending draft.
const column=(content:string,type:string,value:ButtonValue)=>({tag:'column',width:'auto',elements:[click(content,type,value)]});
// Where a message that the owner sends goes: a chat, and the message it replies to when it quotes one (the id open-lark gave it).
export type Address=OwnerChat&{replyTo?:string};
// What a message that the owner sends says: its text, which holds @<name> for each of the mentions.
export type Body={text:string,mentions:Mention[]};
// The local wall time of at, with its month and day when now falls on another local day.
function time(at:number,now:number){
 const date=new Date(at),current=new Date(now),clock=String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0');
 const same=date.getFullYear()===current.getFullYear()&&date.getMonth()===current.getMonth()&&date.getDate()===current.getDate();
 return same?clock:`${date.getMonth()+1}月${date.getDate()}日 ${clock}`;
}
// Where source s came from, in one line: <sender> · <the chat's name, or 私聊 for a direct chat> · <time>, such as 孙栎倩 · 私聊 · 12:45 or
// 陈帆 · GEO 小分队 · 10:49. The source card shows it, and bridge-message prints it.
export function sourceLine(s:Pick<OwnerMessage,'sender'|'chatName'|'chatType'|'at'>,now:number):string{return `${s.sender.name} · ${s.chatType==='p2p'?'私聊':s.chatName} · ${time(s.at,now)}`;}
// The card of message m that an agent brought into its topic: sourceLine in grey, what m says, and 查看原消息 linking to m.link when there is one.
export function sourceCard(m:OwnerMessage,now:number):object{
 const line=sourceLine(m,now);
 return untitled(line,[grey(line),plain(m.text),...m.link?[{tag:'button',text:{tag:'plain_text',content:'查看原消息'},type:'default',behaviors:[{type:'open_url',default_url:m.link}]}]:[]],m.link?{update_multi:true}:undefined);
}
// How the card of a draft shows it: as its delivery's state has it (pending while awaiting or failed, sent, dropped), or editing while the owner
// changes its text.
export type DraftView='pending'|'sent'|'dropped'|'editing';
// The card of delivery d, a message for the owner's channel, as view, where quoted is the message that a reply quotes. pending: where it goes and
// as whom, the text, 发送, 修改 and 不发, and 发送失败：<failure> above the text when the last attempt failed (failure, else the delivery's error).
// editing: a form whose input, named text, holds the text, with 发送, which submits it, and 取消. sent and dropped keep the text but have no
// buttons. Every button carries {draft:<its action>,deliveryId:d.id,render}: every drawing of a card that can be clicked needs its own render
// number (see pending in request-cards.ts).
export function draftCard(d:Delivery,view:DraftView,{render,now,quoted,failure=d.error??undefined}:{render:number,now:number,quoted?:OwnerMessage,failure?:string}):object{
 const to=(d.target as {to:Address}).to,{text}=d.body as Body,deliveryId=d.id;
 const title=to.chatType==='p2p'?`回复 ${to.chatName}`:`发到 ${to.chatName}`;
 const destination=to.chatType==='p2p'?`发到你和 ${to.chatName} 的私聊，以你的身份发送`:'以你的身份发送';
 const about=destination+(quoted?`，引用 ${quoted.sender.name} ${time(quoted.at,now)} 的消息`:'');
 const send:ButtonValue={draft:'send',deliveryId,render};
 if(view==='editing'){
  const form=submitForm('draft',[{tag:'input',name:'text',input_type:'multiline_text',width:'fill',default_value:text}],'发送',send);
  form.elements.push(click('取消','default',{draft:'cancel',deliveryId,render}));
  return untitled(title,[heading(title),grey(about),form],{update_multi:true});
 }
 const elements:object[]=[heading(title),grey(about),...view==='pending'&&failure?[plain('发送失败：'+failure)]:[],quote(text)];
 if(view==='pending')elements.push({tag:'column_set',horizontal_spacing:'8px',columns:[column('发送','primary',send),column('修改','default',{draft:'edit',deliveryId,render}),column('不发','default',{draft:'drop',deliveryId,render})]});
 if(view==='sent')elements.push(plain(`已发送给 ${to.chatName} · ${time((d.receipt as {at:number}).at,now)}`));
 if(view==='dropped')elements.push(plain('未发送'));
 return untitled(title,elements,{update_multi:true});
}
