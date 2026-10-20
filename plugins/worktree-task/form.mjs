// The popup of the plugin: a terminal form for the task (a multi-line description, an optional existing branch, the agent), which then
// runs the task script. Herdr opens it from the start action with the context of the focused pane.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {field,insert,backspace,del,left,right,home,end,up,down,layout,width,clip} from './text-field.mjs';import {repoOf} from '../../bridge/worktree-branch.mjs';import {git} from './repo.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
// focus 0 is the description, 1 the branch, 2 the agent. paste collects a bracketed paste until it ends.
export const newForm=()=>({desc:field(),branch:field(),kind:'claude',focus:0,paste:null,error:''});
// One key or escape sequence each; a bracketed paste arrives between \x1b[200~ and \x1b[201~.
const keyPattern=/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO.|\x1b[\s\S]|[\s\S]/gu,pasteStart='\x1b[200~',pasteEnd='\x1b[201~';
const moves={'\x1b[D':left,'\x1b[C':right,'\x1b[A':up,'\x1b[B':down,'\x1b[H':home,'\x1b[1~':home,'\x1bOH':home,'\x01':home,'\x1b[F':end,'\x1b[4~':end,'\x1bOF':end,'\x05':end,'\x1b[3~':del};
function submit(s){
 const description=s.desc.text,branch=s.branch.text.trim();
 if(!description.trim()&&!branch){s.error='请填写任务描述，或者填一个已有分支';return;}
 if(/\s/.test(branch)){s.error='分支名不能包含空白字符';return;}
 return {type:'submit',description,branch,kind:s.kind};
}
// Applies the input data to the form and returns {type:'submit',description,branch,kind} or {type:'cancel'} once the form is done.
// Tab and Shift-Tab move between the fields, Ctrl-S submits, Esc and Ctrl-C cancel; Enter is a newline in the description, moves on
// from the branch and submits on the agent, where the arrows and Space switch between Claude and Codex.
export function press(s,data){
 for(const k of data.match(keyPattern)??[]){
  if(s.paste!==null){
   if(k!==pasteEnd){s.paste+=k;continue;}
   const text=s.paste.replace(/\r\n?/g,'\n');s.paste=null;
   if(s.focus<2)insert(s.focus?s.branch:s.desc,s.focus?text.replace(/\n/g,' '):text);continue;
  }
  if(k===pasteStart){s.paste='';continue;}
  if(k==='\x03'||k==='\x1b')return {type:'cancel'};
  if(k==='\x13'||(k==='\r'&&s.focus===2)){const done=submit(s);if(done)return done;continue;}
  s.error='';
  if(k==='\t'){s.focus=(s.focus+1)%3;continue;}
  if(k==='\x1b[Z'){s.focus=(s.focus+2)%3;continue;}
  if(s.focus===2){if(['\x1b[D','\x1b[C',' '].includes(k))s.kind=s.kind==='claude'?'codex':'claude';continue;}
  const f=s.focus?s.branch:s.desc;
  if(k==='\r'||k==='\n'){if(s.focus)s.focus=2;else insert(f,'\n');}
  else if(k==='\x7f'||k==='\b')backspace(f);
  else if(moves[k])moves[k](f);
  else if(k==='\x15'){f.text='';f.cursor=0;}
  else if(!/^[\x00-\x1f\x7f\x1b]/.test(k))insert(f,k);
 }
}
// The screen of the form in a terminal of cols × rows. Fields stay on screen in a small popup: the description shrinks to one row, and the
// help line, the header and the linked-worktree note go in that order. The cursor shows in the focused text field only.
export function render(s,{cols,rows,repo}){
 const spare=rows-4,footer=spare>=1,header=spare>=2,linked=repo.linked&&spare>=3,descRows=Math.max(1,rows-3-footer-header-linked);
 const label=(i,text)=>`${s.focus===i?'\x1b[1m> ':'  '}${text}\x1b[0m`,lines=[];let cursor;
 if(header)lines.push(clip(`开始任务 · ${repo.mainRoot}`,cols));
 if(linked)lines.push(clip('  从 linked worktree 发起：新分支基于它的 HEAD',cols));
 lines.push(label(0,clip('任务描述（Enter 换行）',cols-2)));
 const d=layout(s.desc,cols-3),top=Math.max(0,d.row-descRows+1);
 for(let i=0;i<descRows;i++)lines.push('  '+(d.rows[top+i]??''));
 if(s.focus===0)cursor=[lines.length-descRows+d.row-top+1,3+d.col];
 const prefix=clip('已有分支：',cols-2),room=Math.max(1,cols-2-width(prefix)-1),b=layout(s.branch,room);
 lines.push(label(1,prefix)+(s.branch.text?b.rows[b.row]:`\x1b[2m${clip('留空则由 haiku 起名',room)}\x1b[0m`));
 if(s.focus===1)cursor=[lines.length,3+width(prefix)+b.col];
 lines.push(label(2,'Agent：')+['claude','codex'].map(k=>k===s.kind?`\x1b[7m ${k} \x1b[0m`:` ${k} `).join(' '));
 if(footer)lines.push(s.error?`\x1b[31m${clip(s.error,cols)}\x1b[0m`:clip('Tab 切换 · Ctrl-S 开始 · Esc 取消',cols));
 return '\x1b[?25l\x1b[H'+lines.map(l=>l+'\x1b[K').join('\r\n')+'\x1b[J'+(cursor?`\x1b[${cursor[0]};${cursor[1]}H\x1b[?25h`:'');
}
// The description goes to the task script on stdin (-): as an argument, a description that happens to name a file would be read as
// that file.
export const taskArgs=({kind,branch})=>['--notify',...(kind==='codex'?['--codex']:[]),...(branch?['-b',branch]:[]),'-'];
// Runs the task script in a process group of its own with its output in logFile: the popup takes all input while it is open, so the
// person has to close it to handle a startup dialog of the agent, and the task keeps going. --notify reports to Herdr after that.
export function startInBackground({script,args,cwd,input,logFile}){
 fs.mkdirSync(path.dirname(logFile),{recursive:true});const fd=fs.openSync(logFile,'a');
 try{const child=spawn(process.execPath,[script,...args],{cwd,detached:true,stdio:['pipe',fd,fd]});child.stdin.on('error',()=>{});child.stdin.end(input);return child;}
 finally{fs.closeSync(fd);}
}
export function pruneLogs(dir,keep){
 const logs=fs.readdirSync(dir).filter(n=>/^task-.*\.log$/.test(n)).map(n=>({n,t:fs.statSync(path.join(dir,n)).mtimeMs})).sort((a,b)=>b.t-a.t);
 for(const {n} of logs.slice(keep))fs.rmSync(path.join(dir,n),{force:true});
}
// The directory of the task: the focused pane's, or else the workspace's. A popup is no pane, so Herdr passes the pane under it.
export function contextDir(env){try{const c=JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON);return c.focused_pane_cwd||c.workspace_cwd||undefined;}catch{return undefined;}}
async function main(){
 const {stdin:input,stdout:output}=process,write=t=>output.write(t),key=()=>new Promise(r=>input.once('data',r));
 if(!input.isTTY){console.error('这个弹窗需要在终端里运行');process.exit(1);}
 input.setRawMode(true);input.setEncoding('utf8');write('\x1b[?2004h');
 const stop=async(message,code)=>{write(`\x1b[?25h\x1b[2J\x1b[H${message.replace(/\n/g,'\r\n')}\r\n\r\n按任意键关闭`);await key();process.exit(code);};
 const dir=contextDir(process.env);if(!dir)return stop('Herdr 没有给出聚焦 pane 或 workspace 的目录，无法确定在哪个仓库开任务',1);
 let repo;try{repo=await repoOf(git,dir);}catch(e){return stop(e.message,1);}
 const s=newForm(),draw=()=>write(render(s,{cols:output.columns,rows:output.rows,repo}));
 output.on('resize',draw);draw();
 const done=await new Promise(resolve=>{const on=d=>{const a=press(s,d);if(a){input.off('data',on);resolve(a);}else draw();};input.on('data',on);});
 output.off('resize',draw);if(done.type==='cancel')process.exit(0);
 const logs=path.join(process.env.HERDR_PLUGIN_STATE_DIR||path.join(os.tmpdir(),'herdr-worktree-task'),'logs'),logFile=path.join(logs,`task-${new Date().toISOString().replace(/[:.]/g,'-')}-${process.pid}.log`);
 const child=startInBackground({script:path.join(here,'task.mjs'),args:taskArgs(done),cwd:dir,input:done.description,logFile});
 pruneLogs(logs,20);
 write(`\x1b[?25l\x1b[2J\x1b[H日志：${logFile}\r\nEsc 隐藏弹窗，任务在后台继续；Agent 停在启动对话框时，先按 Esc 关掉弹窗再去处理\r\n\r\n`);
 // The log grows while the task runs; the decoder keeps a character split between two reads whole.
 const decoder=new StringDecoder('utf8');let offset=0;
 const tail=()=>{const fd=fs.openSync(logFile,'r');try{const buf=Buffer.alloc(65536);let n;while((n=fs.readSync(fd,buf,0,buf.length,offset))>0){offset+=n;write(decoder.write(buf.subarray(0,n)).replace(/\r?\n/g,'\r\n'));}}finally{fs.closeSync(fd);}};
 const timer=setInterval(tail,150);let finished=false;
 input.on('data',d=>{if(finished)process.exit(child.exitCode??1);if(d==='\x1b'||d==='\x03'){child.unref();process.exit(0);}});
 child.on('error',e=>{clearInterval(timer);finished=true;write(`\r\n无法启动开任务脚本：${e.message}\r\n按任意键关闭`);});
 child.on('exit',code=>{clearInterval(timer);tail();if(code===0)process.exit(0);finished=true;write('\r\n按任意键关闭');});
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))await main();
