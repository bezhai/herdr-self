import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {invalid,refused,string,local,inside,name,run,gitRunner} from './machine-tools.ts';
import {workspaceMethods} from './workspace.ts';
import {launchMethods} from './launch.ts';
import {openLarkMethods} from './open-lark.ts';
import type {Methods,ClientApi,SkillFiles,SkillDigest} from './link.ts';
import type {OpenLark} from './open-lark.ts';
// What the client of a machine (see client.ts) does there for the control plane: a fixed set of methods, each of which runs a program of
// its own choosing, if any, never one that the control plane names. The control plane decides when and why (see operations in core.ts);
// a method only does its part and returns the raw result, such as {code, stdout, stderr} of a command whatever its exit status, which the
// control plane reads. It uses only Node's built-in modules, like the client.

// The directories under working directories that Bridge owns: those of the attachments of topics (see Topics.attach). The client stores
// attachments and removes directories only there.
export const attachmentFolder='.herdr-bridge';
// env without the HERDR_* variables, which would make Herdr and the hooks of agents report to the pane of whoever started the client, and
// without what a shell sets for itself, such as PWD, which would be wrong for a command that runs elsewhere.
export const stripped=(env:NodeJS.ProcessEnv)=>Object.fromEntries(Object.entries(env).filter(([k])=>!k.startsWith('HERDR_')&&!['PWD','OLDPWD','SHLVL','_'].includes(k)));
// The environment of the user's shell ($SHELL, else that of the passwd entry) as a login shell without a terminal: what its startup files set
// up, such as the PATH where the user installed git or herdr, which the PATH of a user service lacks. zsh reads ~/.zshenv also without
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
// The directories that a machine builds for a skill and Bridge does not hold: the runtime environments, which depend on the machine's
// system and architecture. The import leaves them out (see skill-command.ts), and stock keeps those of the skill it replaces (see carry).
export const environments=['.venv','node_modules'];
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
// Moves the environments in directory old (see environments), found at any depth, to the same paths in fresh, the new version of the
// skill, except those whose path the new version has itself. The agent that ran the skill built them on this machine; losing them would
// mean installing again after each edit of a word. One that cannot be moved is lost and the update goes on: it is built again when needed.
async function carry(old:string,fresh:string,rel=''):Promise<void>{
 const entries=await fs.promises.readdir(path.join(old,rel),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 for(const e of entries.filter(x=>x.isDirectory())){
  const p=path.join(rel,e.name);if(!environments.includes(e.name)){await carry(old,fresh,p);continue;}
  if(await lstat(path.join(fresh,p)))continue;
  await fs.promises.mkdir(path.dirname(path.join(fresh,p)),{recursive:true}).then(()=>fs.promises.rename(path.join(old,p),path.join(fresh,p))).catch(()=>{});
 }
}
// The skills {name, digest} of a request to compare, and the names of one to prune with, once checked.
function digestsOf(v:unknown):SkillDigest[]{
 if(!Array.isArray(v))throw invalid('skills');
 for(const s of v){name(s?.name,'skills');string(s.digest,'digest');}
 return v;
}
function namesOf(v:unknown):string[]{if(!Array.isArray(v))throw invalid('names');for(const n of v)name(n,'names');return v;}
// Puts skill {name, digest, files} into kept, the store of this machine, as the directory <kept>/<name> with Bridge's marker, which holds the
// digest, unless that directory has the digest already. The files go into a directory beside it first, which then takes its place, so that
// the links to it never show half a skill; the environments of the old version move into the new one first (see carry). Resolves to its path.
async function stock(kept:string,{name:n,digest,files}:SkillFiles){
 const target=path.join(kept,n);if((await read(path.join(target,skillMark)))?.trim()===digest)return target;
 await fs.promises.mkdir(kept,{recursive:true});const fresh=await fs.promises.mkdtemp(path.join(kept,'.'+n+'-'));
 try{
  for(const [p,b] of Object.entries(files)){await fs.promises.mkdir(path.dirname(path.join(fresh,p)),{recursive:true});await fs.promises.writeFile(path.join(fresh,p),Buffer.from(b,'base64'));}
  await fs.promises.writeFile(path.join(fresh,skillMark),digest+'\n');await carry(target,fresh);await fs.promises.rm(target,{recursive:true,force:true});await fs.promises.rename(fresh,target);
 }catch(e){await fs.promises.rm(fresh,{recursive:true,force:true});throw e;}
 return target;
}
// The methods of a client whose Herdr is the program at herdr (a leading ~/ is the home directory), whose commands run with env (see
// loginEnvironment), and which reaches open-lark at openLark, on the machine that runs it (see open-lark.ts). Every request carries
// timeoutMs, the most that a command it runs may take (see run).
export function methods({herdr,env,openLark}:{herdr:string,env:NodeJS.ProcessEnv,openLark?:OpenLark}):Omit<Methods<ClientApi>,'ping'>{
 const program=herdr.replace(/^~\//,os.homedir()+'/');
 const git=gitRunner(env);
 return {
  // The Herdr CLI in session session with args, each a string passed as it is or {path} for a path of this machine (Herdr itself does not
  // expand ~ in --cwd).
  herdr({session,args,timeoutMs}){
   if(!Array.isArray(args))throw invalid('args');
   const argv=args.map(a=>typeof a==='string'?a:local(a?.path,'路径参数'));
   return run(program,['--session',string(session,'session'),...argv],{env,timeoutMs});
  },
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
  // The origin URL as the repository configures it when path is the root of a Git repository or of a linked worktree, which is the top level
  // of its checkout once links are resolved; null for anything else: a directory inside a repository, a directory that only holds clones,
  // a missing one, a repository without origin.
  async inspectDirectory({path:dir,timeoutMs}){
   const real=await fs.promises.realpath(local(dir,'path')).catch(()=>null);if(!real)return {origin:null};
   const top=await git(real,['rev-parse','--show-toplevel'],timeoutMs);
   if(top.code!==0||await fs.promises.realpath(top.stdout.trim()).catch(()=>null)!==real)return {origin:null};
   const origin=await git(real,['config','--get','remote.origin.url'],timeoutMs);
   return {origin:origin.code===0&&origin.stdout.trim()||null};
  },
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
  // The names of skills that the store lacks or holds with another digest than the one listed (the marker of a skill holds its digest).
  async compareSkills({store,skills}){
   const kept=local(store,'store'),stale=[];
   for(const {name:n,digest} of digestsOf(skills))if((await read(path.join(kept,n,skillMark)))?.trim()!==digest)stale.push(n);
   return {stale};
  },
  // Takes away the skills of the store that carry Bridge's marker and are not in names, and resolves to their names. A directory without
  // the marker, a file or a link is someone else's or an earlier version's, and stays.
  async pruneSkills({store,names}){
   const kept=local(store,'store'),wanted=namesOf(names),removed:string[]=[];
   const entries=await fs.promises.readdir(kept,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
   for(const e of entries)if(e.isDirectory()&&!wanted.includes(e.name)&&await read(path.join(kept,e.name,skillMark))!=null){await fs.promises.rm(path.join(kept,e.name),{recursive:true,force:true});removed.push(e.name);}
   return {removed};
  },
  ...workspaceMethods(git),
  ...launchMethods(env),
  ...openLarkMethods(openLark),
 };
}
