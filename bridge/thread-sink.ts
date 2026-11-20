import {publicText} from './core.ts';
import {topicOfTask} from './task-topic.ts';
import {replyCards} from './message-cards.ts';
import type {Store} from './core.ts';
import type {App} from './state.ts';
import type {Platforms} from './platform.ts';
import type {Reply} from './message-cards.ts';
import type {Sink} from './task-types.ts';
// The sink that shows a task's output in the thread of the topic whose task it is: the agent's replies go there as cards (see Topics.pull).
// Its address is the task id, from which it finds the topic, and what it sends is a reply ({text, truncated?}).
export const threadSinkName='thread';
// The first line of what an error says, as the logs show it.
const brief=(e:Error)=>publicText(e.message).split('\n')[0].slice(0,200);
// The sink of the threads of the topics in store: app(id) is the app of a topic and reply(app,chatId,rootId,{card}) answers in its thread and
// resolves to the id of the card's message (see Platforms). It posts the cards of the reply (see replyCards) in order, and the first one that
// fails ends the reply: the cards after it are dropped rather than posted after a gap, and most failures (Feishu not connected) would meet
// them too. It resolves to the ids of the cards, and rejects with a message that says how many went out and why the next did not, which the
// core keeps as the delivery's error.
export function threadSink({store,app,reply}:{store:Store,app:(id:string)=>App,reply:Platforms['reply']}):Sink{
 return {async send(to,body){
  const ids:string[]=[];
  try{
   const t=topicOfTask(store.data.topics,String(to));if(!t)throw Error('没有这个任务的话题：'+String(to));
   for(const card of replyCards(body as Reply))ids.push(await reply(app(t.appId),t.chatId,t.rootId,{card}));
   return ids;
  }catch(e){throw Error(`${ids.length?`只发出了前 ${ids.length} 张卡片`:'未发出'}，${brief(e)}`);}
 }};
}
