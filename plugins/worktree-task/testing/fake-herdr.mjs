// A stand-in for herdr in the tests. Records every call in FAKE_HERDR_LOG as one JSON line and answers from the JSON scenario in
// FAKE_HERDR_SCENARIO, keyed by the first two arguments ("worktree create"). An entry is {error} to fail like herdr does (the error
// JSON on stderr, exit 1), {result} to answer with that result, and may add mkdir to create the --path directory first, as a git
// worktree add that went through would. A call without an entry gets the answer real herdr gives on success.
import fs from 'node:fs';
const argv=process.argv.slice(2),key=argv.slice(0,2).join(' ');
fs.appendFileSync(process.env.FAKE_HERDR_LOG,JSON.stringify({argv,cwd:process.cwd()})+'\n');
const scenario=process.env.FAKE_HERDR_SCENARIO&&fs.existsSync(process.env.FAKE_HERDR_SCENARIO)?JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_SCENARIO,'utf8')):{};
const step=scenario[key]||{},option=name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1];};
const answer=result=>{process.stdout.write(JSON.stringify({id:'cli',result})+'\n');process.exit(0);};
if(step.mkdir)fs.mkdirSync(option('--path'),{recursive:true});
if(step.error){process.stderr.write(JSON.stringify({id:'cli',error:step.error})+'\n');process.exit(1);}
if(step.result)answer(step.result);
switch(key){
 case 'plugin config-dir':process.stdout.write(process.env.FAKE_CONFIG_DIR+'\n');process.exit(0);
 case 'worktree create':answer({type:'worktree_created',workspace:{workspace_id:'w_9'},tab:{tab_id:'w_9:1'},root_pane:{pane_id:'w_9-1'},worktree:{path:option('--path'),branch:option('--branch')}});
 case 'agent list':answer({type:'agent_list',agents:[]});
 case 'agent start':answer({type:'agent_info',agent:{name:argv[2],pane_id:option('--pane'),agent_status:'idle',interactive_ready:true}});
 case 'agent wait':answer({type:'agent_info',agent:{name:argv[2],agent_status:'idle'}});
 default:answer({type:'ok'});
}
