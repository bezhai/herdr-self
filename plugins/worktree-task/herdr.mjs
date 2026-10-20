import {spawn} from 'node:child_process';
// Plugin commands get the running Herdr binary in HERDR_BIN_PATH; a shell outside a plugin command uses herdr on PATH.
export const herdrBin=()=>process.env.HERDR_BIN_PATH||'herdr';
// Runs cmd with args and resolves to {code,stdout,stderr,timedOut}; a non-zero exit is a result, a command that cannot start rejects.
// input, when given, is its stdin, which is closed otherwise. With timeoutMs the command runs in its own process group, which is killed
// once the time is up: claude -p starts helpers of its own, and a git fetch there cannot stop to ask for a password on the terminal.
export function run(cmd,args,{cwd,env=process.env,input,timeoutMs}={}){
 return new Promise((resolve,reject)=>{
  const p=spawn(cmd,args,{cwd,env,stdio:['pipe','pipe','pipe'],detached:Boolean(timeoutMs)});let stdout='',stderr='',timer;
  const finish=r=>{clearTimeout(timer);resolve(r);};
  if(timeoutMs)timer=setTimeout(()=>{try{process.kill(-p.pid,'SIGKILL');}catch{}p.stdout.destroy();p.stderr.destroy();finish({code:null,stdout,stderr,timedOut:true});},timeoutMs);
  p.stdout.on('data',d=>{stdout+=d;});p.stderr.on('data',d=>{stderr+=d;});
  p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>finish({code,stdout,stderr,timedOut:false}));
  p.stdin.on('error',()=>{});p.stdin.end(input);
 });
}
// A failed Herdr call: code is Herdr's error code (agent_not_ready, timeout, ...), or failed when Herdr printed no error JSON.
export class HerdrError extends Error{constructor(code,message){super(message);this.code=code;}}
// Runs herdr with args and resolves to the result of its JSON answer, or with text to its plain output. Herdr reports a failed request
// as {"id","error":{"code","message"}} on stderr and exits 1; usage and connection errors are plain text. timeoutMs only guards against
// a call that never returns: the calls that wait take a --timeout of their own and get a margin on top of it.
export async function herdr(args,{text=false,timeoutMs}={}){
 const what=`herdr ${args.slice(0,2).join(' ')}`;let r;
 try{r=await run(herdrBin(),args,{timeoutMs});}catch(e){throw new HerdrError('failed',`无法运行 ${herdrBin()}：${e.message}`);}
 if(r.timedOut)throw new HerdrError('timeout',`${what} 在 ${timeoutMs/1000} 秒内没有返回`);
 if(r.code!==0){
  const out=(r.stderr||r.stdout).trim();
  try{const {error}=JSON.parse(out.split('\n').at(-1));if(error?.code)throw new HerdrError(error.code,error.message);}catch(e){if(e instanceof HerdrError)throw e;}
  throw new HerdrError('failed',`${what} 失败：${out||`退出码 ${r.code}`}`);
 }
 if(text)return r.stdout.trim();
 try{return JSON.parse(r.stdout).result;}catch{throw new HerdrError('failed',`${what} 没有返回 JSON：${r.stdout.trim().slice(0,200)}`);}
}
