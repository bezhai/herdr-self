// The model, reached through herdr: every ask starts a fresh claude without tools in a workspace of its own, in the
// herdr session reserved for butler on the model machine (a saved herdr machine, so the model's gateway token stays
// there), takes its one final reply and closes the workspace. Nothing carries over from one ask to the next.
import {execFile} from 'node:child_process';

// No built-in tools (an empty --tools list), no MCP servers (--strict-mcp-config without --mcp-config), no skills or
// slash commands: whatever the messages say, the model can only answer. --no-session-persistence would be welcome
// too, but claude accepts it only with --print, and herdr drives the interactive claude.
export const CLAUDE_ARGS=['--tools','','--strict-mcp-config','--disable-slash-commands'];
// The model claude is asked for, when one is named; otherwise claude's default. --model alone is not enough: on cpu1,
// ~/.claude/settings.json allows only another model (availableModels), and claude then warns that the model is
// restricted by the organization's settings and keeps asking for the allowed one. --settings adds a settings source
// whose availableModels lists only this model, and that is enough: with it claude 2.1.318 on cpu1 asked for the named
// model (the session transcript and the usage it reported show no other model).
const modelArgs=name=>name?['--model',name,'--settings',JSON.stringify({availableModels:[name]})]:[];
// The levels claude's --effort takes. The effort is asked for only when one is configured; otherwise claude uses its
// default (high), as the owner wants for ark/seed-evolving on cpu1. Low was once fixed here for deepseek behind
// cpu1's gateway: at high it reasoned for thousands of tokens and a batch of 40 messages ran past the reply timeout,
// while low gave the same matters in about half the tokens. That gateway rejects medium for deepseek.
export const EFFORTS=['low','medium','high','xhigh','max'];
const effortArgs=effort=>effort?['--effort',effort]:[];
// herdr agent prompt takes the prompt only as a command-line argument of the local herdr CLI (no stdin or file), and
// Linux caps a single argument at 128 KiB.
const MAX_ARG_BYTES=120_000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// A failed herdr call as the subcommand, its target, the exit status and the end of stderr. Never its arguments:
// Node's own message for a failed command repeats the whole command line, the prompt and its message texts included,
// and this text goes to the store's errors, to status and to the journal.
function failure(args,error,stderr){
 const target=args[2]&&!args[2].startsWith('-')?`（${args[2]}）`:'';
 const status=typeof error.code==='number'?`退出码 ${error.code}`:error.signal?`被信号 ${error.signal} 终止${error.killed?'（超时）':''}`:`无法运行（${error.code??'未知错误'}）`;
 const lines=String(stderr??'').trim().split('\n').map(l=>l.trim()).filter(Boolean);let tail;
 try{const e=JSON.parse(lines.at(-1)).error;if(e?.message)tail=`${e.message}（${e.code}）`;}catch{}
 tail??=lines.slice(-3).join(' ');
 if(tail.length>300)tail=`…${tail.slice(-300)}`;
 return `herdr ${args.slice(0,2).join(' ')}${target} 失败，${status}${tail?`：${tail}`:''}`;
}

export class HerdrModel{
 // machine: the saved herdr machine (label); cwd: an existing absolute directory there (herdr falls back to home for
 // anything else, silently); name: the model claude is asked for, undefined for claude's default; effort: one of
 // EFFORTS, undefined for claude's default; command: the herdr executable and any leading arguments; label: of the
 // workspaces.
 constructor({machine,cwd,name,effort,command=['herdr'],label='butler-model',startTimeoutMs=90_000,replyTimeoutMs=900_000,replyGraceMs=15_000,replyPollMs=1000,log=()=>{}}){
  Object.assign(this,{machine,cwd,name,effort,command,label,startTimeoutMs,replyTimeoutMs,replyGraceMs,replyPollMs,log});
 }
 #herdr(args,timeoutMs=60_000){
  const [bin,...lead]=this.command,what=`herdr ${args.slice(0,2).join(' ')}`;
  return new Promise((resolve,reject)=>execFile(bin,[...lead,'--machine',this.machine,...args],{timeout:timeoutMs,maxBuffer:16<<20,encoding:'utf8'},(error,stdout,stderr)=>{
   if(error)return reject(Error(failure(args,error,stderr)));
   try{resolve(JSON.parse(stdout));}catch{reject(Error(`${what} 的输出不是 JSON：${String(stdout).slice(0,200)}`));}
  }));
 }

 async ask({system,prompt}){
  const size=Math.max(Buffer.byteLength(prompt),Buffer.byteLength(system));
  if(size>MAX_ARG_BYTES)throw Error(`提示太长（${size} 字节），超过一个命令行参数的上限`);
  const created=await this.#herdr(['workspace','create',...(this.cwd?['--cwd',this.cwd]:[]),'--label',this.label,'--no-focus']);
  const workspace=created.result.workspace.workspace_id,pane=created.result.root_pane.pane_id;
  try{
   const name=`butler-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
   await this.#herdr(['agent','start',name,'--kind','claude','--pane',pane,'--timeout',String(this.startTimeoutMs),'--',...CLAUDE_ARGS,...modelArgs(this.name),...effortArgs(this.effort),'--system-prompt',system],this.startTimeoutMs+60_000);
   const prompted=await this.#herdr(['agent','prompt',name,prompt,'--wait','--timeout',String(this.replyTimeoutMs)],this.replyTimeoutMs+60_000);
   if(prompted.result?.agent?.agent_status==='blocked')throw Error('模型停在了等待确认的界面（blocked）');
   return await this.#reply(name);
  }finally{
   await this.#herdr(['workspace','close',workspace]).catch(e=>this.log(`关闭模型机器上的工作区 ${workspace} 失败：${e.message}`));
  }
 }
 // claude's Stop hook reports the final reply on its own, so it can land just after the agent settles.
 async #reply(name){
  const end=Date.now()+this.replyGraceMs;
  for(;;){
   const last=((await this.#herdr(['agent','replies',name])).result?.replies??[]).reduce((a,r)=>!a||r.seq>a.seq?r:a,undefined);
   // The model did answer, just too much: answered tells the processor so (it may hold that against the batch).
   if(last?.truncated)throw Object.assign(Error('模型的回复超过 64 KiB，herdr 只留下了截断的一段'),{answered:true});
   if(last)return last.text;
   if(Date.now()>=end)throw Error('模型结束了这一轮，但没有回复');
   await sleep(this.replyPollMs);
  }
 }
 // Closes the workspaces of runs that did not get to close their own (the processor was killed mid-run).
 async cleanup(){
  const left=((await this.#herdr(['workspace','list'])).result?.workspaces??[]).filter(w=>w.label===this.label);
  for(const w of left)await this.#herdr(['workspace','close',w.workspace_id]);
  return left.length;
 }
}
