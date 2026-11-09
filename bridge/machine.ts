import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {Methods,ClientApi,Ran,SkillFiles} from './link.ts';
// What the client of a machine (see client.ts) does there for the control plane: a fixed set of methods, each of which runs a program of
// its own choosing, if any, never one that the control plane names. The control plane decides when and why (see operations in core.ts);
// a method only does its part and returns the raw result, such as {code, stdout, stderr} of a command whatever its exit status, which the
// control plane reads. It uses only Node's built-in modules, like the client.

// The directories under working directories that Bridge owns: those of the attachments of topics (see Topics.attach). The client stores
// attachments and removes directories only there.
export const attachmentFolder='.herdr-bridge';
const invalid=(what:string)=>Object.assign(Error('参数无效：'+what),{code:'invalid_params'});
const refused=(what:string)=>Object.assign(Error(what),{code:'refused'});
const string=(v:unknown,what:string)=>{if(typeof v!=='string'||!v)throw invalid(what);return v;};
// A path of this machine as the control plane names it: absolute, or under the home directory with ~/.
function local(v:unknown,what:string){
 const p=string(v,what);if(p.startsWith('~/'))return os.homedir()+p.slice(1);
 if(!path.isAbsolute(p))throw invalid(`${what} 必须是绝对路径或 ~/ 开头：${p}`);return p;
}
// A relative path below a directory, which never leaves it.
function inside(v:unknown,what:string){const p=string(v,what);if(path.isAbsolute(p)||p.split('/').some(s=>!s||s==='.'||s==='..'))throw invalid(`${what}：${p}`);return p;}
const name=(v:unknown,what:string)=>{const s=inside(v,what);if(s.includes('/'))throw invalid(`${what}：${s}`);return s;};
// Runs program with args and resolves to {code, stdout, stderr} whatever its exit status; stderr keeps its last 2000 characters. Rejects when
// it cannot start, prints too much, or does not finish within timeoutMs: it then gets SIGKILL with every process it started, which share its
// process group, and the error has the code timed_out. input, when given, is its stdin, which is closed otherwise.
function run(program:string,args:string[],{env,cwd,input,timeoutMs=12000}:{env:NodeJS.ProcessEnv,cwd?:string,input?:string,timeoutMs?:number}){
 return new Promise<Ran>((resolve,reject)=>{
  const p=spawn(program,args,{env,cwd,detached:true,stdio:['pipe','pipe','pipe']});let out='',err='';
  // Only once the process has started, which gave it a pid.
  const kill=()=>{try{process.kill(-p.pid!,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{kill();reject(Object.assign(Error(`${path.basename(program)} 在 ${timeoutMs/1000} 秒内没有结束，已终止`),{code:'timed_out'}));},timeoutMs);
  p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');
  p.stdout.on('data',d=>{out+=d;if(out.length>4e6){kill();reject(Error(`${path.basename(program)} 的输出过大`));}});p.stderr.on('data',d=>{err=(err+d).slice(-2000);});
  p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);resolve({code,stdout:out,stderr:err});});
  p.stdin.on('error',()=>{});p.stdin.end(input);
 });
}
// env without the HERDR_* variables, which would make Herdr and the hooks of agents report to the pane of whoever started the client, and
// without what a shell sets for itself, such as PWD, which would be wrong for a command that runs elsewhere.
export const stripped=(env:NodeJS.ProcessEnv)=>Object.fromEntries(Object.entries(env).filter(([k])=>!k.startsWith('HERDR_')&&!['PWD','OLDPWD','SHLVL','_'].includes(k)));
// The environment of the user's shell ($SHELL, else that of the passwd entry) as a login shell without a terminal: what its startup files set
// up, such as the PATH where the user installed claude or herdr, which the PATH of a user service lacks. zsh reads ~/.zshenv also without
// a login, which is all that sshd gave Bridge's commands before the clients, but bash reads no file at all then; as a login shell zsh adds
// ~/.zprofile and bash reads ~/.profile. The shell runs node with a fixed argv, and node prints its environment after a NUL, so that
// whatever the startup files print is skipped. Without the variables that stripped drops. Rejects when the shell fails or takes longer than
// timeoutMs.
export async function loginEnvironment(env=process.env,timeoutMs=10000){
 const shell=env.SHELL||os.userInfo().shell||'/bin/sh';
 const r=await run(shell,['-l','-c','exec "$@"','sh',process.execPath,'-e','process.stdout.write("\\0"+JSON.stringify(process.env))'],{env,timeoutMs});
 const at=r.stdout.lastIndexOf('\0');if(r.code!==0||at<0)throw Error(`${shell} 退出码 ${r.code}：${r.stderr.trim().slice(-300)}`);
 return stripped(JSON.parse(r.stdout.slice(at+1)));
}
// Directory dir when it is a .herdr-bridge directory also once its links are resolved, as its real path; rejects otherwise, and with the
// error of realpath when it does not exist.
async function owned(dir:string){const real=await fs.promises.realpath(dir);if(path.basename(real)!==attachmentFolder)throw refused(`${dir} 不是 ${attachmentFolder} 目录`);return real;}
// Directories of a root of storeFile are removed once they have not changed for this long.
const staleMinutes=7*24*60;
// Removes the directories of root other than keep that have not changed for staleMinutes, with what they hold.
async function sweep(root:string,keep:string){
 const before=Date.now()-staleMinutes*60000;
 for(const e of await fs.promises.readdir(root,{withFileTypes:true}))if(e.isDirectory()&&e.name!==keep){
  const p=path.join(root,e.name);if((await fs.promises.stat(p)).mtimeMs<before)await fs.promises.rm(p,{recursive:true,force:true});
 }
}
// The file that marks a skill directory as Bridge's on a machine (see placeSkills); no file of a skill takes this name (see skills.ts).
export const skillMark='.herdr-bridge-skill';
const read=(p:string)=>fs.promises.readFile(p,'utf8').catch(e=>{if(e.code==='ENOENT'||e.code==='ENOTDIR'||e.code==='EISDIR')return null;throw e;});
const lstat=(p:string)=>fs.promises.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
// The skills of a request, [{name, digest, files}] with files as {relative path: base64}, once checked.
function skillsOf(v:unknown):SkillFiles[]{
 if(!Array.isArray(v))throw invalid('skills');
 for(const s of v){
  name(s?.name,'skills');string(s.digest,'digest');if(!s.files||typeof s.files!=='object')throw invalid('files');
  for(const [p,b] of Object.entries(s.files)){inside(p,'files');if(typeof b!=='string')throw invalid('files');}
 }
 return v;
}
// Puts skill {name, digest, files} into kept, the store of this machine, as the directory <kept>/<name> with Bridge's marker, which holds the
// digest, unless that directory has the digest already. The files go into a directory beside it first, which then takes its place, so that
// the links to it never show half a skill. Resolves to its path.
async function stock(kept:string,{name:n,digest,files}:SkillFiles){
 const target=path.join(kept,n);if((await read(path.join(target,skillMark)))?.trim()===digest)return target;
 await fs.promises.mkdir(kept,{recursive:true});const fresh=await fs.promises.mkdtemp(path.join(kept,'.'+n+'-'));
 try{
  for(const [p,b] of Object.entries(files)){await fs.promises.mkdir(path.dirname(path.join(fresh,p)),{recursive:true});await fs.promises.writeFile(path.join(fresh,p),Buffer.from(b,'base64'));}
  await fs.promises.writeFile(path.join(fresh,skillMark),digest+'\n');await fs.promises.rm(target,{recursive:true,force:true});await fs.promises.rename(fresh,target);
 }catch(e){await fs.promises.rm(fresh,{recursive:true,force:true});throw e;}
 return target;
}
// The methods of a client whose Herdr is the program at herdr (a leading ~/ is the home directory) and whose commands run with env (see
// loginEnvironment). Every request carries timeoutMs, the most that a command it runs may take (see run).
export function methods({herdr,env}:{herdr:string,env:NodeJS.ProcessEnv}):Omit<Methods<ClientApi>,'ping'>{
 const program=herdr.replace(/^~\//,os.homedir()+'/');
 // git in directory cwd: it never prompts for credentials, and it speaks English, whose messages the control plane recognizes.
 const git=(cwd:string,args:string[],timeoutMs?:number)=>run('git',['-C',cwd,...args],{env:{...env,GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'},timeoutMs});
 return {
  // The Herdr CLI in session session with args, each a string passed as it is or {path} for a path of this machine (Herdr itself does not
  // expand ~ in --cwd).
  herdr({session,args,timeoutMs}){
   if(!Array.isArray(args))throw invalid('args');
   const argv=args.map(a=>typeof a==='string'?a:local(a?.path,'路径参数'));
   return run(program,['--session',string(session,'session'),...argv],{env,timeoutMs});
  },
  // Creates directory path and its missing parents; one that exists is fine.
  async mkdir({path:dir}){await fs.promises.mkdir(local(dir,'path'),{recursive:true});return {};},
  // Writes body (base64) as <root>/<dir>/<name> and resolves to the absolute path of the file. root is a .herdr-bridge directory: it gets a
  // .gitignore of * unless it has one, and its directories other than dir that have not changed for 7 days are removed along the way.
  // Directories are created 0700 and the file 0600.
  async storeFile({root,dir,name:file,body}){
   const folder=name(dir,'dir'),base=path.resolve(local(root,'root')),target=path.join(base,folder,name(file,'name'));
   if(typeof body!=='string')throw invalid('body');
   if(path.basename(base)!==attachmentFolder)throw refused(`附件只能写在 ${attachmentFolder} 目录下：${root}`);
   await fs.promises.mkdir(base,{recursive:true,mode:0o700});const real=await owned(base);
   await fs.promises.mkdir(path.join(real,folder),{recursive:true,mode:0o700});
   await fs.promises.writeFile(path.join(real,'.gitignore'),'*\n',{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   await sweep(real,folder).catch(()=>{});
   await fs.promises.writeFile(target,Buffer.from(body,'base64'),{mode:0o600});return target;
  },
  // Removes directory path, a directory of a topic directly under a .herdr-bridge directory, with what it holds; one that is gone already
  // is fine. Anything else is refused, also once links are resolved.
  async removeDirectory({path:dir}){
   const p=path.resolve(local(dir,'path')),denied=()=>refused(`只能删除 ${attachmentFolder} 目录下的话题目录：${dir}`);
   if(path.basename(path.dirname(p))!==attachmentFolder)throw denied();
   let parent;try{parent=await owned(path.dirname(p));}catch(e){if(e.code==='ENOENT')return {};throw e.code==='refused'?denied():e;}
   const target=path.join(parent,path.basename(p)),s=await lstat(target);if(!s)return {};if(!s.isDirectory())throw denied();
   await fs.promises.rm(target,{recursive:true,force:true});return {};
  },
  git:({cwd,args,timeoutMs})=>{if(!Array.isArray(args)||!args.every(a=>typeof a==='string'))throw invalid('args');return git(local(cwd,'cwd'),args,timeoutMs);},
  // Whether path exists, following links.
  exists:({path:p})=>fs.promises.stat(local(p,'path')).then(()=>true,()=>false),
  // Asks the cheap model (Claude haiku, through claude) in directory cwd, with prompt on stdin. What it is asked for, such as a branch name, is
  // the control plane's business.
  askCheapModel:({cwd,prompt,timeoutMs})=>run('claude',['-p','--model','haiku'],{env,cwd:local(cwd,'cwd'),input:string(prompt,'prompt'),timeoutMs}),
  // Places skills ([{name, digest, files}], files as {relative path: base64}) where an agent reads project skills, directory dir under
  // working directory cwd, and takes away the skills that Bridge placed there before and that skills no longer has. The store, a directory
  // of this machine that no agent reads as a global skill directory, holds each skill as the control plane has it (see stock). A skill of
  // the working directory is Bridge's when it is a link to the store or a directory with Bridge's marker, which holds the digest of the
  // skill it was copied from; so are the links and copies of the one skill that earlier versions of Bridge carried, which had the store
  // in the same place, and marked their copies the same way. As link, a skill becomes a link to the store, which Claude and Codex follow;
  // as copy, a copy, since Antigravity follows no link: a copy is written again when the digest changed, and a link of Bridge's that a
  // copy has to replace is replaced. Anything else of a name of skills is someone else's: it stays as it is and its path is in what this
  // resolves to. In a Git repository each skill placed goes into the info/exclude of the repository that holds where it actually is, which
  // a link in the path such as .claude/skills -> ../.agents/skills can change, as its path from the top level of that repository; linked
  // worktrees share that file, so a skill taken away keeps its line, which another worktree may need. Without skills, a working directory
  // without dir does not get one. Rejects on the first step that fails.
  async placeSkills({store,skills,dir:under,as,cwd,timeoutMs}){
   const kept=local(store,'store'),dir=path.join(local(cwd,'cwd'),inside(under,'dir')),names=skillsOf(skills).map(s=>s.name);if(!['link','copy'].includes(as))throw invalid('as');
   for(const s of skills)await stock(kept,s);
   if(!names.length&&!await lstat(dir))return [];
   // The marker comes first and gets the digest last: a copy that fails half way is Bridge's, and is written again next time.
   const copy=async(p:string,{name:n,digest}:SkillFiles)=>{
    await fs.promises.rm(p,{recursive:true,force:true});await fs.promises.mkdir(p);await fs.promises.writeFile(path.join(p,skillMark),'');
    await fs.promises.cp(path.join(kept,n),p,{recursive:true,filter:f=>f!==path.join(kept,n,skillMark)});await fs.promises.writeFile(path.join(p,skillMark),digest+'\n');
   };
   await fs.promises.mkdir(dir,{recursive:true});const real=await fs.promises.realpath(dir);
   // Outside a repository, or without git, there is nothing to exclude.
   const ask=(args:string[])=>git(real,args,timeoutMs).then(r=>r.code===0?r.stdout.trim():null,()=>null),root=names.length?await ask(['rev-parse','--show-toplevel']):null,at=root&&await ask(['rev-parse','--git-path','info/exclude']);
   const exclude=at&&(real+'/').startsWith(root+'/')?path.resolve(real,at):null;
   const theirs=[];
   for(const s of skills){
    const n=s.name,p=path.join(dir,n),l=await lstat(p);
    if(l?.isSymbolicLink()){if(await fs.promises.readlink(p)!==path.join(kept,n)){theirs.push(p);continue;}if(as==='copy'){await fs.promises.rm(p);await copy(p,s);}}
    else if(l){const m=await read(path.join(p,skillMark));if(m==null){theirs.push(p);continue;}if(m.trim()!==s.digest)await copy(p,s);}
    else if(as==='link')await fs.promises.symlink(path.join(kept,n),p);
    else await copy(p,s);
    if(!exclude)continue;
    const line=real.slice(root!.length)+'/'+n,text=await read(exclude)??'';
    if(text.split('\n').includes(line))continue;
    await fs.promises.mkdir(path.dirname(exclude),{recursive:true});await fs.promises.appendFile(exclude,(text&&!text.endsWith('\n')?'\n':'')+line+'\n');
   }
   for(const e of await fs.promises.readdir(dir,{withFileTypes:true}))if(!names.includes(e.name)){
    const p=path.join(dir,e.name);
    if(e.isSymbolicLink()?await fs.promises.readlink(p)===path.join(kept,e.name):e.isDirectory()&&await read(path.join(p,skillMark))!=null)await fs.promises.rm(p,{recursive:true,force:true});
   }
   return theirs;
  },
  // Puts skill {name, digest, files}, which an agent of this machine reads through bridge-skill, into the store (see stock) and resolves to
  // its directory there, where its other files are for the agent to open.
  stockSkill:({store,skill})=>stock(local(store,'store'),skillsOf([skill])[0]),
 };
}
