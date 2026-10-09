import {clip} from './request-cards.mjs';
// Feishu COT messages, which show an agent's turn under the message that started it in a topic thread: its status and a step per tool call
// (see Topics.openCot). The three calls are not in the SDK: request(options) calls an OpenAPI and resolves to its data (see openApi in
// platform.mjs). A COT is {cotId, messageId}; what it shows is a list of AG-UI events, each sent with the event's JSON as content.
const path='/open-apis/im/v1/message_cot';
// A new COT in chat chatId that answers message origin in its thread.
export async function createCot(request,chatId,origin){
 const d=await request({method:'POST',url:path,params:{receive_id_type:'chat_id'},data:{receive_id:chatId,origin_message_id:origin,reply_in_thread:true}});
 if(!d?.cot_id||!d.message_id)throw Error('飞书未返回 COT');
 return {cotId:String(d.cot_id),messageId:d.message_id};
}
// Feishu takes at most 50 events per call; the batches go out in order.
export async function updateCot(request,cot,events){for(let i=0;i<events.length;i+=50)await request({method:'PUT',url:path,data:{message_id:cot.messageId,cot_id:cot.cotId,events:events.slice(i,i+50)}});}
// Ends the COT with reason done or error; timeout is Feishu's own.
export async function completeCot(request,cot,reason){await request({method:'POST',url:`${path}/complete/${encodeURIComponent(cot.cotId)}`,params:{message_id:cot.messageId,reason}});}
// Timestamps in ms that grow with every event, so that events made in the same ms keep their order.
let last=0;const stamp=()=>last=Math.max(Date.now(),last+1);
const event=(event_type,content)=>({event_type,content:JSON.stringify(content),timestamp:stamp()});
// A run is {threadId, runId}: the root message of the topic and the message that started the turn.
export const runStarted=run=>event('RUN_STARTED',run);
// status done, or interrupted by /stop.
export const runFinished=(run,status)=>event('RUN_FINISHED',{...run,status});
export const runError=message=>event('RUN_ERROR',{message});
// A line of text, which the COT shows as its status while it runs.
export const status=(messageId,text)=>[event('TEXT_MESSAGE_START',{messageId,role:'assistant'}),event('TEXT_MESSAGE_CONTENT',{messageId,delta:text}),event('TEXT_MESSAGE_END',{messageId})];
// The icon Feishu draws for a step, by what the tool name of any agent says the tool does; other tools get the default icon.
const icons=[['bash',/bash|shell|command/],['search',/grep|glob|search|find/],['read',/read|view/],['write',/edit|write|patch|replace/]];
const icon=name=>icons.find(([,pattern])=>pattern.test(name.toLowerCase()))?.[0]||'default';
// The steps of Herdr's tool call records {seq, tool_call_id, phase:'start'|'end', tool_name, title?, failed?}, in their order: a start opens
// the step of its call, labelled by its title or else its tool name, and an end closes it as done or failed. No output of a tool is shown.
export const steps=calls=>calls.flatMap(c=>c.phase==='start'?[event('TOOL_CALL_START',{toolCallId:c.tool_call_id,toolCallName:c.tool_name,title:clip(c.title||c.tool_name,200),icon:icon(c.tool_name)}),event('TOOL_CALL_END',{toolCallId:c.tool_call_id})]
 :c.phase==='end'?[event('TOOL_CALL_RESULT',{messageId:'result-'+c.tool_call_id,toolCallId:c.tool_call_id,role:'tool',content:c.failed?'失败':'完成',isError:Boolean(c.failed)})]:[]);
