// A stand-in for the herdr CLI, run as its own process: node fake-herdr.mjs <dir> [--machine X] <command...>.
// It answers the commands butler uses with the JSON shapes of herdr 0.9.1, keeps its state (workspaces, agents and
// their replies) in <dir>/state.json and logs every invocation to <dir>/calls.jsonl. What the "model" replies and
// what fails comes from <dir>/script.json, written by the test:
//   {unreachable, fail:{"agent start":{code,stderr,signal}}, replies:[{text,truncated,lateMs} | {none:true} | {timeout:true} | {blocked:true}]}
import fs from 'node:fs';
import path from 'node:path';

const [dir,...argv]=process.argv.slice(2);
const file=name=>path.join(dir,name);
const read=(name,fallback)=>{try{return JSON.parse(fs.readFileSync(file(name),'utf8'));}catch{return fallback;}};
const state=read('state.json',{next:1,seq:0,workspaces:{},agents:{}}),script=read('script.json',{});
fs.appendFileSync(file('calls.jsonl'),`${JSON.stringify(argv)}\n`);
const save=()=>fs.writeFileSync(file('state.json'),JSON.stringify(state));
const ok=(id,result)=>{save();process.stdout.write(`${JSON.stringify({id,result})}\n`);process.exit(0);};
const fail=(id,code,message,exit=1)=>{save();process.stderr.write(`${JSON.stringify({error:{code,message},id})}\n`);process.exit(exit);};

let args=argv;
if(args[0]==='--machine')args=args.slice(2);
if(script.unreachable){process.stderr.write("error: machine 'cpu1-butler': ssh: connect to host cpu1 port 22: Connection refused\n");process.exit(1);}
const command=args.slice(0,2).join(' '),opt=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const scripted=script.fail?.[command];
if(scripted){process.stderr.write(scripted.stderr??'');if(scripted.signal)process.kill(process.pid,scripted.signal);else process.exit(scripted.code??1);}
const agentOf=name=>state.agents[name];

switch(command){
 case 'workspace list':ok('cli:workspace:list',{type:'workspace_list',workspaces:Object.entries(state.workspaces).map(([id,w])=>({workspace_id:id,label:w.label,pane_count:1,tab_count:1}))});
 case 'workspace create':{
  const id=`w${state.next++}`,pane=`${id}:p1`;state.workspaces[id]={label:opt('--label')??'',cwd:opt('--cwd'),pane};
  ok('cli:workspace:create',{type:'workspace_created',workspace:{workspace_id:id,label:opt('--label')},tab:{tab_id:`${id}:t1`},root_pane:{pane_id:pane,cwd:opt('--cwd'),workspace_id:id}});
 }
 case 'workspace close':{
  const id=args[2];if(!state.workspaces[id])fail('cli:workspace:close','workspace_not_found',`workspace ${id} not found`);
  delete state.workspaces[id];for(const [name,a] of Object.entries(state.agents))if(a.pane.startsWith(`${id}:`))delete state.agents[name];
  ok('cli:workspace:close',{type:'ok'});
 }
 case 'agent start':{
  const name=args[2],pane=opt('--pane'),extra=args.slice(args.indexOf('--')+1);
  if(!Object.values(state.workspaces).some(w=>w.pane===pane))fail('cli:agent:start','pane_not_found',`pane ${pane} not found`);
  state.agents[name]={pane,kind:opt('--kind'),args:extra,prompts:[],replies:[]};
  ok('cli:agent:start',{type:'agent_started',agent:{name,pane_id:pane,agent:'claude',agent_status:'idle'},argv:['claude',...extra]});
 }
 case 'agent prompt':{
  const a=agentOf(args[2]);if(!a)fail('cli:agent:prompt','agent_not_found',`agent target ${args[2]} not found`);
  a.prompts.push(args[3]);const reply=(script.replies??[])[state.seq++]??{text:'{"new":[],"updates":[]}'};
  if(reply.timeout)fail('cli:agent:prompt','timeout','timed out waiting for agent status');
  if(!reply.none)a.replies.push({seq:state.seq,text:reply.text,truncated:Boolean(reply.truncated),at:Date.now()+(reply.lateMs??0)});
  ok('cli:agent:prompt',{type:'agent_prompted',agent:{name:args[2],pane_id:a.pane,agent_status:reply.blocked?'blocked':'done'}});
 }
 case 'agent replies':{
  const a=agentOf(args[2]);if(!a)fail('cli:agent:replies','agent_not_found',`agent target ${args[2]} not found`);
  ok('cli:agent:replies',{type:'agent_replies',agent:{name:args[2]},replies:a.replies.filter(r=>r.at<=Date.now()).map(({at,...r})=>r)});
 }
 default:fail('cli',`unknown`,`unknown command: ${args.join(' ')}`,2);
}
