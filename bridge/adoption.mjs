import {card,plain,by} from './request-cards.mjs';
// What Feishu shows when a topic adopts an agent that already runs in a Herdr pane (see Topics.offer and Topics.adopt): the picker card,
// the picker once an agent was adopted, and the intro of the adopted topic. An agent is an entry of `herdr agent list`; text from Herdr and
// the agent is shown as plain text, never as markdown.
// Agent states as the console labels them.
const statuses={idle:'空闲',working:'运行中',blocked:'等待确认',done:'已完成',unknown:'未知'};
const clip=(s,n)=>[...s].length>n?[...s].slice(0,n-1).join('')+'…':s;
// A path under a home directory starts with ~. Display only: the machine's home is not known, so the usual home locations count, also
// below a mount point such as /data00/home/<user>.
export const home=path=>path.replace(/^(?:.*?\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/,'~');
// What an agent is called: its Herdr name, else its title, else its pane.
export const label=x=>clip(x.name||x.title||x.pane_id,40);
const kind=x=>x.display_agent||x.agent;
const summary=x=>[kind(x),label(x),...x.cwd?[home(x.cwd)]:[],statuses[x.agent_status]||x.agent_status].join(' · ');
const heading=content=>({tag:'div',text:{tag:'plain_text',content,text_size:'heading'}});
const note=content=>({tag:'div',text:{tag:'plain_text',content,text_size:'notation',text_color:'grey'}});
const firstLine=text=>clip(text.split('\n').map(l=>l.trim()).find(Boolean)||'',60);
// What a 接管 button sends back: the agent of machine m as the picker saw it. stillChosen tells whether agent x of a newer list in the same
// pane is still that agent: the same kind, and the same name and session where the picker saw them.
const choiceOf=(m,x)=>({machine:m.id,pane:x.pane_id,kind:x.agent,...x.name&&{name:x.name},...x.agent_session&&{session:x.agent_session.value}});
export const stillChosen=(v,x)=>x.agent===v.kind&&(v.name==null||x.name===v.name)&&(v.session==null||x.agent_session?.value===v.session);
function choice(m,{agent:x,latest},render){
 const line=latest&&firstLine(latest.text);
 return {tag:'column_set',horizontal_spacing:'8px',columns:[{tag:'column',width:'weighted',weight:1,elements:[plain(summary(x)),...line?[note('最近回复：'+line)]:[]]},
  {tag:'column',width:'auto',vertical_align:'center',elements:[{tag:'button',text:{tag:'plain_text',content:'接管'},type:'primary',behaviors:[{type:'callback',value:{adopt:choiceOf(m,x),render}}]}]}]};
}
// The picker: per machine, the agents that no topic holds with a 接管 button each, or why there are none. groups is
// [{machine, failed, agents:[{agent, latest}]}] in machine order, where latest is the agent's latest reply or null. notice, when given,
// first says why a selection failed. Every drawing needs its own render number (see pending in request-cards.mjs).
export function picker(groups,render,notice){
 return card('接管 Agent','blue',[...notice?[plain(notice)]:[],
  ...groups.flatMap(({machine,failed,agents},i)=>[...i?[{tag:'hr'}]:[],heading(machine.name),
   ...failed?[plain('连接失败')]:agents.length?agents.map(a=>choice(machine,a,render)):[plain('没有可以接管的 Agent')]]),
  ...groups.length?[]:[plain('没有已连接的机器')]]);
}
// The picker once the person openId adopted agent x of machine: no buttons are left.
export const adoptedPicker=(machine,x,openId)=>card('接管 Agent','green',[plain(`${machine.name} · ${summary(x)}`),by('已接管',openId)]);
// The first message of a topic that adopted agent x of machine. latest tells whether the agent's latest reply follows it.
export function intro(machine,x,latest){
 return [`已接管 ${machine.name} 上的 ${kind(x)} · ${label(x)}`,`工作目录：${x.cwd?home(x.cwd):'未知'}`,
  '话题里的消息会发给这个 Agent，它的回复会转到这里。发送 /结束接管 结束接管，Agent 会继续在终端的 pane 里运行。',
  // Herdr keeps the replies of the session an agent reports; a Codex attached to its background app-server reports none in this pane.
  ...x.agent_session?[]:['这个 Agent 没有向 Herdr 上报会话（例如连着后台 app-server 的 Codex），它的回复可能无法转回飞书。'],
  ...latest?['最近一条回复：']:[]].join('\n');
}
