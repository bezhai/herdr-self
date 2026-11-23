import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {invalid,local,gitRunner} from './machine-tools.ts';
import type {Git} from './machine-tools.ts';
import {resumableKinds} from './link.ts';
import type {Methods,ClientApi} from './link.ts';
// prepareLaunch (see ClientApi in link.ts): what an agent needs on this machine before Herdr starts it in a directory, and the arguments
// that make it use the model, the permission mode, the limits and the trust of the directory that its configuration names, and resume a
// session that ran in the directory when there is one to resume. The trust is
// what keeps the agent from asking whoever is on the other side of a Feishu topic to confirm a folder, which no one there could answer.
// Verified on the real CLIs on 2026-11-09. It uses only Node's built-in modules, like the client.

const kinds=['claude','codex','agy'];
// What goes after --model and in a settings file, and what a command is called: names, never an option or something a shell would split.
// A session is looked up only as a UUID, as the sessions of Claude, Codex and Antigravity are: it goes into a file name and an argument.
const modelName=/^[A-Za-z0-9][\w.:/@+[\]-]*$/,commandName=/^[A-Za-z0-9_][\w.+-]*$/,sessionId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude reads the folder trust from here. A running Claude rewrites the file whenever it likes, so this changes it in one step that
// reads it and replaces it, and writes nothing when the trust is there.
const claudeFile=(env:NodeJS.ProcessEnv)=>path.join(env.CLAUDE_CONFIG_DIR||os.homedir(),'.claude.json');
const isRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
function trust(file:string,at:(projects:Record<string,unknown>)=>string|null){
 // A link to the file is written through, as the editor of a dotfiles repository leaves it.
 let target=file;try{target=fs.realpathSync(file);}catch{}
 let text:string|null=null;try{text=fs.readFileSync(target,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 let config:unknown={};if(text!==null)try{config=JSON.parse(text);}catch{throw Error(`${file} 不是有效的 JSON，没有改动它`);}
 if(!isRecord(config)||config.projects!==undefined&&!isRecord(config.projects))throw Error(`${file} 的内容不是预期的格式，没有改动它`);
 const projects=config.projects??{},dir=at(projects);if(dir===null)return;
 const entry=isRecord(projects[dir])?projects[dir]:{};
 const next={...config,projects:{...projects,[dir]:{...entry,hasTrustDialogAccepted:true}}};
 const mode=text===null?0o600:fs.statSync(target).mode&0o777,temporary=`${target}.${process.pid}.tmp`;
 fs.writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{mode});fs.renameSync(temporary,target);
}
const trusted=(projects:Record<string,unknown>,dir:string)=>isRecord(projects[dir])&&projects[dir].hasTrustDialogAccepted===true;
// The main checkout of the repository that holds dir, which a linked worktree follows in Claude's trust; null outside Git.
async function mainCheckout(git:Git,dir:string,timeoutMs?:number){
 const common=await git(dir,['rev-parse','--path-format=absolute','--git-common-dir'],timeoutMs);if(common.code!==0)return null;
 const at=common.stdout.trim();
 if(path.basename(at)==='.git')return fs.promises.realpath(path.dirname(at));
 const top=await git(dir,['rev-parse','--show-toplevel'],timeoutMs);return top.code===0?fs.promises.realpath(top.stdout.trim()):null;
}
// Whether this machine has Claude session id as one that ran in directory real. Claude keeps a session as <config>/projects/<key>/<id>.jsonl,
// where the key is the real path of the directory it started in with every character other than a letter or a digit as -, past 200
// characters the first 200 and - and a hash of the path (claude 2.1.323, 2026-11-23). It resumes a session by id from whichever directory it
// starts in, so the file under the key of real is what tells that the session ran there; an id it has nowhere ends it at once (No
// conversation found), which Herdr's start only reports when its timeout runs out.
async function claudeHas(env:NodeJS.ProcessEnv,real:string,id:string){
 const projects=path.join(env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'projects'),key=real.replace(/[^a-zA-Z0-9]/g,'-');
 const keys=key.length<=200?[key]:(await fs.promises.readdir(projects).catch(()=>[])).filter(k=>k.startsWith(key.slice(0,200)+'-'));
 for(const k of keys)if(await fs.promises.access(path.join(projects,k,id+'.jsonl')).then(()=>true,()=>false))return true;
 return false;
}
// Whether this machine has Codex session id as one that ran in directory real. Codex keeps a session as
// <CODEX_HOME>/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl, whose first line is its meta with the real path of the directory it
// ran in as payload.cwd (codex-cli 0.169.0, 2026-11-23); `codex resume <id>` with an id it lacks ends at once (No saved session found).
async function codexHas(env:NodeJS.ProcessEnv,real:string,id:string){
 const sessions=path.join(env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions');
 for(const file of (await fs.promises.readdir(sessions,{recursive:true}).catch(()=>[])).filter(f=>f.endsWith(`-${id}.jsonl`))){
  try{if(JSON.parse(await firstLine(path.join(sessions,file))).payload?.cwd===real)return true;}catch{}
 }
 return false;
}
async function firstLine(file:string){
 const input=fs.createReadStream(file);
 try{for await(const line of readline.createInterface({input,crlfDelay:Infinity}))return line;return '';}finally{input.destroy();}
}
// Installs the hook program (command-guard.ts, which is copied whole) where Claude can run it, replacing what is there only when it differs,
// and resolves to the command that runs it for these commands. The command ends in exit 2, which blocks the tool: a hook that cannot run
// (the program gone, Node moved) would otherwise let the call through as if there were no hook.
const guardSource=fileURLToPath(new URL('./command-guard.ts',import.meta.url));
const quoted=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
async function installGuard(commands:string[]){
 const body=await fs.promises.readFile(guardSource),dir=path.join(os.homedir(),'.local','share','herdr-bridge','hooks'),file=path.join(dir,'command-guard.ts');
 if(!(await fs.promises.readFile(file).catch(()=>null))?.equals(body)){
  await fs.promises.mkdir(dir,{recursive:true});const temporary=`${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary,body);await fs.promises.rename(temporary,file);
 }
 return `${[process.execPath,file,...commands].map(quoted).join(' ')} || exit 2`;
}
export function launchMethods(env:NodeJS.ProcessEnv):Pick<Methods<ClientApi>,'prepareLaunch'>{
 const git=gitRunner(env);
 return {
  // See ClientApi in link.ts. The arguments are those after the -- of herdr agent start, without the --.
  async prepareLaunch({kind,model,permissionMode,allowedCommands,dir:given,resume,timeoutMs}){
   if(!kinds.includes(kind))throw invalid('kind');
   if(model!==undefined&&(typeof model!=='string'||!modelName.test(model)))throw invalid('model');
   if(permissionMode!==undefined&&!['default','auto','bypassPermissions'].includes(permissionMode))throw invalid('permissionMode');
   if(allowedCommands!==undefined&&(!Array.isArray(allowedCommands)||!allowedCommands.every(c=>typeof c==='string'&&commandName.test(c))))throw invalid('allowedCommands');
   const commands=allowedCommands??[];if(commands.length&&kind!=='claude')throw invalid('allowedCommands：只有 Claude 可以限制可执行的命令');
   // Herdr takes whatever session id an agent reports; one that is no UUID is a session that this machine does not have.
   if(resume!==undefined&&typeof resume!=='string')throw invalid('resume');
   const session=resume!==undefined&&resumableKinds.includes(kind)&&sessionId.test(resume)?resume:undefined;
   const dir=local(given,'dir'),real=await fs.promises.realpath(dir).catch(()=>{throw invalid(`dir 不存在：${dir}`);});
   if(kind==='codex'){
    // The dotted key form of -c does not work for a path, only a table. A path is a TOML string, which JSON.stringify writes the same way.
    // Codex asks whether to update before it takes a prompt when a new version is out (seen with 0.166.0 on 2026-11-09), which no one in
    // a Feishu topic can answer, so it does not check. `codex resume [OPTIONS] [SESSION_ID]` takes the same options (codex resume --help).
    const options=['--no-daemon','-c','sandbox_workspace_write.network_access=true','--dangerously-bypass-hook-trust','-c','check_for_update_on_startup=false',...model?['-m',model]:[],'-c',`projects={${JSON.stringify(real)}={trust_level="trusted"}}`];
    const resumed=session!==undefined&&await codexHas(env,real,session);
    return {args:resumed?['resume',...options,session]:options,resumed};
   }
   // Antigravity compares the path with $PWD, so the path as it is given, not the real one. Its default toolPermission asks before the
   // first shell command, and that prompt cannot reach Feishu (no permission hook), so always-proceed runs actions without asking while
   // deny and ask rules in the settings still apply. It never resumes (see resumableKinds in link.ts).
   if(kind==='agy')return {args:[...model?['--model',model]:[],'--settings',JSON.stringify({trustedWorkspaces:[dir],toolPermission:'always-proceed'})],resumed:false};
   const main=await mainCheckout(git,real,timeoutMs);
   // Outside Git a directory inherits the trust of an ancestor, such as the home directory; it is registered itself only when none has it.
   trust(claudeFile(env),projects=>{
    if(main!==null)return trusted(projects,main)?null:main;
    for(let d=real;;d=path.dirname(d)){if(trusted(projects,d))return null;if(d===path.dirname(d))return real;}
   });
   // No --disable-slash-commands: it takes the Skill tool and every skill with it, and the skill is what a restricted agent is started for.
   const settings={...model&&{availableModels:[model]},...commands.length&&{hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:await installGuard(commands)}]}]}}};
   // A resumed session keeps its id (--fork-session would give it another), and takes the permission mode and the rest of these arguments.
   const resumed=session!==undefined&&await claudeHas(env,real,session);
   return {args:['--permission-mode',permissionMode??'default',...model?['--model',model]:[],
    ...commands.length?['--tools','Bash,Skill,Read','--allowedTools',commands.map(c=>`Bash(${c} *)`).join(','),'--strict-mcp-config']:[],
    ...Object.keys(settings).length?['--settings',JSON.stringify(settings)]:[],...resumed?['--resume',session]:[]],resumed};
  },
 };
}
