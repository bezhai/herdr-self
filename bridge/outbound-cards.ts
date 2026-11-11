import {plain,clip,submitForm} from './request-cards.ts';
import {untitled} from './message-cards.ts';
import type {ButtonValue} from './request-cards.ts';
import type {Draft,Source} from './state.ts';
import type {OwnerMessage} from './link.ts';
// Feishu cards (JSON 2.0) of the owner's channel in the thread of a topic (see Messages), which the bot posts without a header like the other
// status cards of Bridge (see message-cards.ts): the card of a message that the agent brought in, and the card of a message that it drafted
// to send as the owner. They name people and chats by their names only, never 他 or 她. A time shows as HH:mm on the day of now, else as
// M月D日 HH:mm, in the time zone of the process. Text from Feishu or the agent is shown as plain text, never as markdown. bridge-message
// imports this module too (see sourceLine), so it loads only Node's built-in modules and the modules above.
// Until the cards are drawn, the functions return placeholders made of their arguments other than now, so that the tests of Messages and
// bridge-message, which compare with what these functions return, run already.

// Where source s came from, in one line: <sender> · <the chat's name, or 私聊 for a direct chat> · <time>, such as 孙栎倩 · 私聊 · 12:45 or
// 陈帆 · GEO 小分队 · 10:49. The source card shows it, and bridge-message prints it.
export function sourceLine(s:Pick<Source,'sender'|'chatName'|'chatType'|'at'>,now:number):string{return 'sourceLine '+JSON.stringify([s.sender.name,s.chatName,s.chatType,s.at]);}
// The card of message m that an agent brought into its topic: sourceLine in grey, what m says, and 查看原消息 linking to m.link when there is one.
export function sourceCard(m:OwnerMessage,now:number):object{return untitled('sourceCard',[plain(JSON.stringify(m))]);}
// How the card of a draft shows it: as its state has it (pending, sent, dropped), or editing while the owner changes its text.
export type DraftView=Draft['state']|'editing';
// The card of draft d as view, where quoted is the source that a reply quotes. pending: where it goes and as whom, the text, 发送, 修改 and
// 不发, and 发送失败：<d.failure> above the text when the last attempt failed. editing: a form whose input, named text, holds the text, with
// 发送, which submits it, and 取消. sent and dropped: no buttons. Every button carries {draft:<its action>,draftId:d.id,render}: every
// drawing of a card that can be clicked needs its own render number (see pending in request-cards.ts).
export function draftCard(d:Draft,view:DraftView,{render,now,quoted}:{render:number,now:number,quoted?:Source}):object{
 return untitled('draftCard',[plain(clip(JSON.stringify({d,view,render,quoted}),20000))],{update_multi:true});
}
