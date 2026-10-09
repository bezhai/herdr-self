import {card,plain,clip,by,option,select,submitForm} from './request-cards.mjs';
import {slash} from './commands.mjs';
// What Feishu shows when a topic adopts an agent that already runs in a Herdr pane (see Topics.offer and Topics.adopt): the picker card,
// the picker once an agent was adopted, and the intro of the adopted topic. An agent is an entry of the agents of `herdr api snapshot`,
// which are those of `herdr agent list`; text from Herdr and the agent is shown as plain text, never as markdown.
// Agent states as the console labels them.
const statuses={idle:'空闲',working:'运行中',blocked:'等待确认',done:'已完成',unknown:'未知'};
// The kinds that bindings start, named as in the console; other agents go by what Herdr calls them.
const kinds={claude:'Claude',codex:'Codex',agy:'Antigravity'};
// A path under a home directory starts with ~. Display only: the machine's home is not known, so the usual home locations count, also
// below a mount point such as /data00/home/<user>.
export const home=path=>path.replace(/^(?:.*?\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/,'~');
const kind=x=>kinds[x.agent]||x.display_agent||x.agent;
// What a person calls agent x of the session snapshot s: the label of its pane, else the label they gave its tab, else the label of its
// workspace, else its pane. Herdr labels a tab without a name by its position, which names nothing. Agents of s that would share a name
// are told apart by their panes; s may hold only some of the session's agents, such as those a picker offers.
export function nameOf(s,x){
 const base=y=>{
  const tab=s.tabs.find(t=>t.tab_id===y.tab_id)?.label;
  return clip(s.panes.find(p=>p.pane_id===y.pane_id)?.label||(tab&&!/^\d+$/.test(tab)?tab:'')||s.workspaces.find(w=>w.workspace_id===y.workspace_id)?.label||y.pane_id,40);
 };
 const name=base(x);return s.agents.some(y=>y.pane_id!==x.pane_id&&base(y)===name)?`${name} (${x.pane_id})`:name;
}
// Agent x of machine m, called name, as the picker offers it and the adopted picker shows it.
const summary=(m,x,name)=>[m.name,name,kind(x),statuses[x.agent_status]||x.agent_status].join(' · ');
// What an option of the picker carries: the agent of machine m as the picker saw it. stillChosen tells whether agent x of a newer list in
// the same pane is still that agent: the same kind, and the same Herdr name and session where the picker saw them.
const choiceOf=(m,x)=>({machine:m.id,pane:x.pane_id,kind:x.agent,...x.name&&{name:x.name},...x.agent_session&&{session:x.agent_session.value}});
export const stillChosen=(v,x)=>x.agent===v.kind&&(v.name==null||x.name===v.name)&&(v.session==null||x.agent_session?.value===v.session);
// The choice that a submission of the picker carries in form (see choiceOf), or null when it chose none.
export function chosen(form){
 try{const v=JSON.parse(form?.agent);return typeof v?.machine==='string'&&typeof v.pane==='string'&&typeof v.kind==='string'?v:null;}
 catch{return null;}
}
// The picker: a dropdown with an option per agent that no topic holds, over all machines, and a 接管 button that submits the chosen one;
// then the machines whose list failed. groups is [{machine, failed, agents:[{agent, name}]}] in machine order. notice, when given, first
// says why a selection failed. Every drawing needs its own render number (see pending in request-cards.mjs): the channel drops a submission
// that repeats the card, person and button value of an earlier one, whatever it chose.
export function picker(groups,render,notice){
 const options=groups.flatMap(({machine,agents})=>agents.map(({agent,name})=>option(summary(machine,agent,name),JSON.stringify(choiceOf(machine,agent)))));
 const choices=!groups.length?[plain('没有已连接的机器')]:options.length?[submitForm('picker',[select('agent','选择要接管的 Agent',options)],'接管',{adopt:true,render})]:[plain('没有可以接管的 Agent')];
 return card('接管 Agent','blue',[...notice?[plain(notice)]:[],...choices,...groups.filter(g=>g.failed).map(g=>plain(g.machine.name+' · 连接失败'))]);
}
// The picker once the person openId adopted agent x of machine, called name: nothing is left to choose.
export const adoptedPicker=(machine,x,name,openId)=>card('接管 Agent','green',[plain(summary(machine,x,name)),by('已接管',openId)]);
// The first message of a topic that adopted agent x of machine, called name. latest tells whether the agent's latest reply follows it.
export function intro(machine,x,name,latest){
 return [`已接管 ${machine.name} 上的 ${kind(x)} · ${name}`,`工作目录：${x.cwd?home(x.cwd):'未知'}`,
  `话题里的消息会发给这个 Agent，它的回复会转到这里。发送 ${slash.release} 结束接管，Agent 会继续在终端的 pane 里运行。`,
  // Herdr keeps the replies of the session an agent reports; a Codex attached to its background app-server reports none in this pane.
  ...x.agent_session?[]:['这个 Agent 没有向 Herdr 上报会话（例如连着后台 app-server 的 Codex），它的回复可能无法转回飞书。'],
  ...latest?['最近一条回复：']:[]].join('\n');
}
