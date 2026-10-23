// The model, reached through herdr: every ask starts a fresh claude without tools in a workspace of its own, in the
// herdr session reserved for butler on the model machine (a saved herdr machine, so the model's gateway token stays
// there), takes its one final reply and closes the workspace. Nothing carries over from one ask to the next.
import {execFile} from 'node:child_process';

// No built-in tools (an empty --tools list), no MCP servers (--strict-mcp-config without --mcp-config), no skills or
// slash commands: whatever the messages say, the model can only answer. --no-session-persistence would be welcome
// too, but claude accepts it only with --print, and herdr drives the interactive claude.
export const CLAUDE_ARGS=['--tools','','--strict-mcp-config','--disable-slash-commands'];
// herdr agent prompt takes the prompt only as a command-line argument of the local herdr CLI (no stdin or file), and
// Linux caps a single argument at 128 KiB.
const MAX_ARG_BYTES=120_000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// What herdr said went wrong: its JSON error on stderr, or the text there.
function herdrError(stderr,error){
 const text=String(stderr??'').trim();
 try{const e=JSON.parse(text.split('\n').at(-1)).error;if(e?.message)return `${e.message}（${e.code}）`;}catch{}
 return text.split('\n').slice(-3).join(' ')||error.message;
}

export class HerdrModel{
 // machine: the saved herdr machine (label); cwd: an existing absolute directory there (herdr falls back to home for
 // anything else, silently); command: the herdr executable and any leading arguments; label: of the workspaces.
 constructor({machine,cwd,command=['herdr'],label='butler-model',startTimeoutMs=90_000,replyTimeoutMs=900_000,replyGraceMs=15_000,replyPollMs=1000,log=()=>{}}){
  Object.assign(this,{machine,cwd,command,label,startTimeoutMs,replyTimeoutMs,replyGraceMs,replyPollMs,log});
 }
 #herdr(args,timeoutMs=60_000){
  const [bin,...lead]=this.command,what=`herdr ${args.slice(0,2).join(' ')}`;
  return new Promise((resolve,reject)=>execFile(bin,[...lead,'--machine',this.machine,...args],{timeout:timeoutMs,maxBuffer:16<<20,encoding:'utf8'},(error,stdout,stderr)=>{
   if(error)return reject(Error(`${what}：${herdrError(stderr,error)}`));
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
   await this.#herdr(['agent','start',name,'--kind','claude','--pane',pane,'--timeout',String(this.startTimeoutMs),'--',...CLAUDE_ARGS,'--system-prompt',system],this.startTimeoutMs+60_000);
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
