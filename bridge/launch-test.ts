import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
import {methods} from './machine.ts';
import {denial} from './command-guard.ts';
import type {Kind,PermissionMode} from './state.ts';
// The launch preparation of the client (see launch.ts) and the hook that restricts the commands of Claude (see command-guard.ts). The client
// reads the home directory from the environment of the process, so the tests set HOME once, before any of them runs.
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-launch-'))),home=path.join(root,'home');
fs.mkdirSync(home);process.env.HOME=home;
const env={...process.env,LC_ALL:'C',GIT_CONFIG_GLOBAL:path.join(root,'gitconfig'),GIT_CONFIG_SYSTEM:'/dev/null'};
fs.writeFileSync(env.GIT_CONFIG_GLOBAL,'[user]\n name = t\n email = t@example.com\n[init]\n defaultBranch = main\n');
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,env,encoding:'utf8'}).trim();
const client=methods({herdr:'unused',env});
type Launch={kind:Kind,model?:string,permissionMode?:PermissionMode,allowedCommands?:string[],dir:string};
const launch=async(p:Launch,c=client)=>(await c.prepareLaunch({...p,timeoutMs:20000})).args;
const claudeJson=path.join(home,'.claude.json'),readJson=(f=claudeJson)=>JSON.parse(fs.readFileSync(f,'utf8'));
const dir=(name:string)=>{const d=path.join(root,name);fs.mkdirSync(d,{recursive:true});return d;};
// A repository with one commit and a linked worktree of it, both in a directory of this test.
function repo(name:string){const main=dir(name+'/main');git(main,'init','-q');git(main,'commit','-q','--allow-empty','-m','x');const tree=path.join(root,name,'tree');git(main,'worktree','add','-q','-b','topic',tree);return {main,tree};}
const guard=path.join(home,'.local/share/herdr-bridge/hooks/command-guard.ts');

test('the hook lets through exactly the commands that are an allowed command with arguments that have no shell metacharacter, and says why for the others',()=>{
 for(const c of ['butler --help','butler messages --since 1d','butler','butler  search "a b" --limit 5','butler a-b_c/d.e=f','butler\tx'])assert.equal(denial(c,['butler']),null,c);
 for(const c of ['rm -rf /','butler x; rm y','butler $(id)','butler `id`','butler x | sh','butler x && y','butler x & y','butler >f','butler <f','butler (x)','butler x\\\ny','echo butler','butlerx','butler-x --help',' butler','butler\nrm -rf /','butler x\nrm y','butler\r\nrm','','/usr/bin/butler x','sudo butler x'])
  assert.equal(typeof denial(c,['butler']),'string',JSON.stringify(c));
 assert.equal(denial(5,['butler']) !== null,true);assert.equal(denial(undefined,['butler']) !== null,true);
 // Several allowed commands, a command with a dot in its name that is not a pattern, and none allowed.
 assert.equal(denial('lark.cli x',['butler','lark.cli']),null);assert.equal(typeof denial('larkXcli x',['lark.cli']),'string');assert.equal(typeof denial('butler x',[]),'string');
});
test('the hook program answers a PreToolUse event of Bash with the decision on stdout, and says nothing for another tool',()=>{
 const run=(input:object|string,...allowed:string[])=>spawnSync(process.execPath,[path.join(import.meta.dirname,'command-guard.ts'),...allowed],{input:typeof input==='string'?input:JSON.stringify(input),encoding:'utf8'});
 const decide=(command:string)=>{const r=run({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command}},'butler');assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).hookSpecificOutput;};
 for(const c of ['butler --help','butler messages --since 1d'])assert.deepEqual(Object.assign({},decide(c),{permissionDecisionReason:''}),{hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:''},c);
 for(const c of ['rm -rf /','butler x; rm y','butler $(id)','echo butler','butlerx']){const d=decide(c);assert.equal(d.permissionDecision,'deny',c);assert.match(d.permissionDecisionReason,/butler/,c);}
 const other=run({hook_event_name:'PreToolUse',tool_name:'Read',tool_input:{file_path:'/etc/passwd'}},'butler');assert.equal(other.status,0);assert.equal(other.stdout,'');
 // An event that is not JSON blocks the tool by the exit status, which Claude reads as a refusal.
 const bad=run('not json','butler');assert.equal(bad.status,2);assert.notEqual(bad.stderr,'');
});
test('Claude gets its permission mode, which defaults, and its model with the setting that makes the model available; nothing else without a restriction',async()=>{
 const d=dir('plain');
 assert.deepEqual(await launch({kind:'claude',dir:d}),['--permission-mode','default']);
 assert.deepEqual(await launch({kind:'claude',permissionMode:'auto',dir:d}),['--permission-mode','auto']);
 assert.deepEqual(await launch({kind:'claude',permissionMode:'auto',model:'Seed-2.0',dir:d}),['--permission-mode','auto','--model','Seed-2.0','--settings','{"availableModels":["Seed-2.0"]}']);
});
test('Claude with commands to run is limited to Bash, Skill and Read, allowed only those commands, without MCP servers, and a hook installed on the machine denies every other command; settings are one JSON',async()=>{
 const d=dir('restricted'),args=await launch({kind:'claude',permissionMode:'default',model:'sonnet',allowedCommands:['butler'],dir:d});
 const at=(flag:string)=>args[args.indexOf(flag)+1];
 assert.deepEqual(args.slice(0,4),['--permission-mode','default','--model','sonnet']);assert.equal(at('--tools'),'Bash,Skill,Read');assert.equal(at('--allowedTools'),'Bash(butler *)');
 // --disable-slash-commands would take the Skill tool and every skill away (checked with claude 2.1.311: tools Bash,Read and no skills), and with them the skill the restricted agent is started for.
 assert.ok(args.includes('--strict-mcp-config'));assert.ok(!args.includes('--disable-slash-commands'));assert.equal(args.filter(a=>a==='--settings').length,1);
 const settings=JSON.parse(at('--settings'));assert.deepEqual(settings.availableModels,['sonnet']);
 const [entry]=settings.hooks.PreToolUse;assert.equal(entry.matcher,'Bash');assert.equal(entry.hooks.length,1);assert.equal(entry.hooks[0].type,'command');
 // The program of the hook is installed and is the one in the source; running its command as Claude does decides.
 assert.equal(fs.readFileSync(guard,'utf8'),fs.readFileSync(path.join(import.meta.dirname,'command-guard.ts'),'utf8'));
 const decide=(command:string,hook=entry.hooks[0].command)=>{const r=spawnSync('sh',['-c',hook],{input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command}}),encoding:'utf8'});return {status:r.status,decision:r.stdout&&JSON.parse(r.stdout).hookSpecificOutput.permissionDecision};};
 assert.deepEqual(decide('butler --help'),{status:0,decision:'allow'});assert.deepEqual(decide('butler x; rm y'),{status:0,decision:'deny'});assert.deepEqual(decide('ls'),{status:0,decision:'deny'});
 // A hook that cannot run blocks the tool: the installed program is gone.
 fs.rmSync(guard);assert.equal(decide('butler --help').status,2);
 // The next launch installs it again, once, and several commands are several patterns and several arguments of the hook.
 const two=await launch({kind:'claude',allowedCommands:['butler','lark-cli'],dir:d});assert.equal(two[two.indexOf('--allowedTools')+1],'Bash(butler *),Bash(lark-cli *)');
 const hook=JSON.parse(two[two.indexOf('--settings')+1]).hooks.PreToolUse[0].hooks[0].command;
 assert.deepEqual(decide('lark-cli docs',hook),{status:0,decision:'allow'});assert.deepEqual(decide('butler x',hook),{status:0,decision:'allow'});assert.deepEqual(decide('rm x',hook),{status:0,decision:'deny'});
 assert.deepEqual(await launch({kind:'claude',allowedCommands:[],dir:d}),['--permission-mode','default']);
});
test('Codex runs in its pane with the network its sandbox needs and trusts the real path of the directory, with the model when there is one; Antigravity trusts the path as it is given',async()=>{
 const real=dir('real'),link=path.join(root,'link');fs.symlinkSync(real,link);fs.rmSync(claudeJson,{force:true});
 const base=['--no-daemon','-c','sandbox_workspace_write.network_access=true','--dangerously-bypass-hook-trust'];
 assert.deepEqual(await launch({kind:'codex',dir:link}),[...base,'-c',`projects={${JSON.stringify(real)}={trust_level="trusted"}}`]);
 assert.deepEqual(await launch({kind:'codex',model:'gpt-5.5',dir:real}),[...base,'-m','gpt-5.5','-c',`projects={${JSON.stringify(real)}={trust_level="trusted"}}`]);
 assert.deepEqual(await launch({kind:'agy',dir:link}),['--settings',JSON.stringify({trustedWorkspaces:[link]})]);
 assert.deepEqual(await launch({kind:'agy',model:'gemini-3',dir:real}),['--model','gemini-3','--settings',JSON.stringify({trustedWorkspaces:[real]})]);
 // The path is a TOML string: a quote or a backslash in it stays in it.
 const odd=dir('odd "dir"\\x');assert.equal((await launch({kind:'codex',dir:odd})).at(-1),`projects={${JSON.stringify(odd)}={trust_level="trusted"}}`);
 // Neither touches the trust file of Claude.
 assert.equal(fs.existsSync(claudeJson),false);
});
test('Claude\'s trust is that of the main checkout of the directory: registered in ~/.claude.json before the start, with every other key kept, and the same for a worktree as for its main checkout',async()=>{
 const {main,tree}=repo('trusted');
 fs.writeFileSync(claudeJson,JSON.stringify({numStartups:3,projects:{'/other':{hasTrustDialogAccepted:false,allowedTools:['x']},[main]:{lastCost:1}},oauthAccount:{id:'keep'}}),{mode:0o600});
 await launch({kind:'claude',dir:tree});
 assert.deepEqual(readJson(),{numStartups:3,projects:{'/other':{hasTrustDialogAccepted:false,allowedTools:['x']},[main]:{lastCost:1,hasTrustDialogAccepted:true}},oauthAccount:{id:'keep'}});
 assert.equal(fs.statSync(claudeJson).mode&0o777,0o600);assert.deepEqual(fs.readdirSync(home).filter(f=>f.includes('.claude.json')),['.claude.json']);
 // Trusted already: the file is not written again, which another Claude process may be doing.
 const before=fs.statSync(claudeJson).ino;await launch({kind:'claude',dir:main});await launch({kind:'claude',dir:path.join(tree)});assert.equal(fs.statSync(claudeJson).ino,before);
 // A directory in a repository starts under the trust of the repository; a link to the directory is its real path.
 fs.mkdirSync(path.join(tree,'src'));fs.symlinkSync(main,path.join(root,'trusted/alias'));await launch({kind:'claude',dir:path.join(root,'trusted/alias')});await launch({kind:'claude',dir:path.join(tree,'src')});
 assert.deepEqual(Object.keys(readJson().projects).sort(),['/other',main].sort());
});
test('a directory outside Git inherits the trust of an ancestor, and is registered itself only when no ancestor is trusted; a file that does not exist is made, one that cannot be read is left alone, and a link to the file stays a link',async()=>{
 const d=dir('nogit/deep/er');fs.rmSync(claudeJson,{force:true});
 await launch({kind:'claude',dir:d});assert.deepEqual(readJson(),{projects:{[d]:{hasTrustDialogAccepted:true}}});
 // Home is trusted: a directory below it is not registered.
 const under=path.join(home,'work/area');fs.mkdirSync(under,{recursive:true});
 fs.writeFileSync(claudeJson,JSON.stringify({projects:{[fs.realpathSync(home)]:{hasTrustDialogAccepted:true}}}));await launch({kind:'claude',dir:under});assert.deepEqual(Object.keys(readJson().projects),[fs.realpathSync(home)]);
 // A trust that is false, or an entry that is none, does not count.
 fs.writeFileSync(claudeJson,JSON.stringify({projects:{[fs.realpathSync(home)]:{hasTrustDialogAccepted:false},[path.join(home,'work')]:5}}));await launch({kind:'claude',dir:under});
 assert.equal(readJson().projects[under].hasTrustDialogAccepted,true);
 fs.writeFileSync(claudeJson,'{not json');await assert.rejects(launch({kind:'claude',dir:under}),/\.claude\.json/);assert.equal(fs.readFileSync(claudeJson,'utf8'),'{not json');
 fs.writeFileSync(claudeJson,'[]');await assert.rejects(launch({kind:'claude',dir:under}),/\.claude\.json/);
 // A link to the file is written through.
 const store=path.join(root,'dotfiles-claude.json');fs.writeFileSync(store,'{}');fs.rmSync(claudeJson);fs.symlinkSync(store,claudeJson);
 await launch({kind:'claude',dir:d});assert.equal(fs.lstatSync(claudeJson).isSymbolicLink(),true);assert.equal(readJson(store).projects[d].hasTrustDialogAccepted,true);
 // Where the configuration directory of Claude is set, the file is in it.
 const config=dir('claude-config'),elsewhere=methods({herdr:'unused',env:{...env,CLAUDE_CONFIG_DIR:config}});await launch({kind:'claude',dir:d},elsewhere);assert.equal(readJson(path.join(config,'.claude.json')).projects[d].hasTrustDialogAccepted,true);
 await assert.rejects(launch({kind:'claude',dir:path.join(root,'missing')}),(e:{code?:string})=>e.code==='invalid_params'||/ENOENT|不存在/.test(String(e)));
});
test('the params are checked: the kind, a model or a command that could be taken for an option or a shell word, commands for an agent that cannot be limited, a relative directory',async()=>{
 const d=dir('checked');
 const bad:[Partial<Launch>,string][]=[[{kind:'bash' as Kind},'kind'],[{model:'-x'},'model'],[{model:'a b'},'model'],[{model:''},'model'],[{permissionMode:'yolo' as PermissionMode},'permissionMode'],[{allowedCommands:['but ler']},'command'],
  [{allowedCommands:['butler;x']},'command'],[{allowedCommands:['-x']},'command'],[{allowedCommands:['']},'command'],[{allowedCommands:'butler' as unknown as string[]},'commands'],[{kind:'codex',allowedCommands:['butler']},'codex'],[{kind:'agy',allowedCommands:['butler']},'agy'],[{dir:'relative/dir'},'dir']];
 for(const [p,what] of bad)await assert.rejects(launch({kind:'claude',dir:d,...p} as Launch),(e:{code?:string})=>e.code==='invalid_params',what+' '+JSON.stringify(p));
});
