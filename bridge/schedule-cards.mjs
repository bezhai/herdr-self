import {card,plain,by} from './request-cards.mjs';
// Feishu cards (JSON 2.0) that ask a person to confirm a schedule that the agent of a topic submitted, or a change to one (see
// AgentSchedules), and what they show once clicked or expired, without buttons. A card shows a view of the schedule: {kind add|update,
// scheduleId (the short id, once there is one), phrase, cron, timeZone, next (wall times of the next runs, when they are shown), task,
// taskChanged, mode, here (whether mode into goes into this topic), topicTitle, binding (what it says of the binding), before (for a
// changed time, the time it had: {phrase, cron, timeZone})}. The task is the agent's text, shown as plain text, never as markdown.
const headings={
 add:{pending:'确认定时任务',confirmed:'定时任务已生效',cancelled:'定时任务已取消',expired:'定时任务的确认已过期',failed:'定时任务没有生效'},
 update:{pending:'确认修改定时任务',confirmed:'定时任务已修改',cancelled:'修改已取消',expired:'修改的确认已过期',failed:'修改没有生效'},
};
const templates={pending:'blue',confirmed:'green',cancelled:'grey',expired:'grey',failed:'red'};
const heading=(v,result)=>headings[v.kind][result]+(v.scheduleId?' · '+v.scheduleId:'');
const time=x=>`${x.phrase}（${x.timeZone}，cron：${x.cron}）`;
function mode(v){
 if(v.mode==='new')return '每次开新话题。每次运行时机器人在群里发一条消息，在它下面开一个新话题，交给一个新的 Agent';
 return v.here?'发进这个话题。每次运行把任务发给这个话题里的 Agent，它记得之前的对话':`发进话题「${v.topicTitle??'已删除的话题'}」。每次运行把任务发给那个话题里的 Agent`;
}
// What every card says of schedule v: when, in words with the expression and the time zone, and the time it had; the next runs, when
// given; the task; the mode; and the binding.
const about=v=>[
 plain('时间：'+time(v)+(v.before?'\n原来的时间：'+time(v.before):'')),
 ...v.next?[plain(v.next.length?`接下来 ${v.next.length} 次运行：\n${v.next.join('\n')}`:'之后不会再运行')]:[],
 plain(`任务${v.taskChanged?'（已修改）':''}：\n${v.task}`),
 plain('模式：'+mode(v)),
 plain('绑定：'+v.binding),
];
const button=(content,type,value)=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value}]}]});
// The card that asks to confirm schedule v of proposal id, valid until expires (a wall time). Its buttons carry the proposal's id, which
// is new for every card: the channel drops a click that repeats the card, person and button value of an earlier one.
export function pendingCard(v,id,expires){
 return card(heading(v,'pending'),templates.pending,[
  plain(v.kind==='add'?'这个话题里的 Agent 提交了一个定时任务，核对无误后点「确认」才会生效。':`这个话题里的 Agent 提交了对定时任务 ${v.scheduleId} 的修改，核对无误后点「确认」才会生效。`),
  ...about(v),plain(`到 ${expires} 前有效，过期没有确认就不会生效`),
  {tag:'column_set',horizontal_spacing:'8px',columns:[button('确认','primary',{schedule:'confirm',proposal:id}),button('取消','default',{schedule:'cancel',proposal:id})]},
 ]);
}
// The card once settled: result confirmed or cancelled by the person openId, expired, or failed for reason.
export function settledCard(v,{result,openId,reason}){
 const end={confirmed:()=>by('已确认',openId),cancelled:()=>by('已取消',openId),expired:()=>plain('过期前没有确认，没有生效'),failed:()=>plain('没有生效：'+reason)}[result]();
 return card(heading(v,result),templates[result],[...about(v),end]);
}
