import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {agentName,validBranch,parseBranch,randomBranch} from './naming.mjs';import {worktreePath} from './repo.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),realGit=execFileSync('sh',['-c','command -v git'],{encoding:'utf8'}).trim();
// The tests run inside Herdr sessions too: nothing they start may see the HERDR_* variables of the session, or reach its server.
const outside=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_')));
// Git without the user's or the system's configuration, for the throwaway repositories of the tests.
const gitEnv={...outside,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.com'};
const git=(cwd,...args)=>execFileSync(realGit,args,{cwd,env:gitEnv,encoding:'utf8'}).trim();
const lines=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
const randomName=/^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/;

// A throwaway repository main with one commit in root, and fake herdr, claude and git (a recording wrapper around the real git) first on PATH.
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'worktree-task-'))),bin=path.join(root,'bin'),configDir=path.join(root,'config'),main=path.join(root,'main');
 for(const d of [bin,configDir,main])fs.mkdirSync(d);
 for(const [name,file] of [['herdr','fake-herdr.mjs'],['claude','fake-claude.mjs'],['git','fake-git.mjs']])fs.writeFileSync(path.join(bin,name),`#!/bin/sh\nexec '${process.execPath}' '${path.join(here,'testing',file)}' "$@"\n`,{mode:0o755});
 git(main,'init','-q','-b','main');git(main,'commit','-q','--allow-empty','-m','init');
 const logs={herdr:path.join(root,'herdr.log'),claude:path.join(root,'claude.json'),git:path.join(root,'git.log')},scenario=path.join(root,'scenario.json');
 return {root,main,configDir,
  scenario(s){fs.writeFileSync(scenario,JSON.stringify(s));},
  config(c){fs.writeFileSync(path.join(configDir,'config.json'),typeof c==='string'?c:JSON.stringify(c));},
  // Runs the task script with args in cwd; claude is what the fake claude does, input its stdin.
  run(args,{cwd=main,input='',claude={stdout:'BRANCH=feat/add-login\n'},env={}}={}){
   const started=Date.now(),p=spawn(process.execPath,[path.join(here,'task.mjs'),...args],{cwd,stdio:['pipe','pipe','pipe'],env:{...gitEnv,PATH:`${bin}:${process.env.PATH}`,
    HERDR_BIN_PATH:path.join(bin,'herdr'),HERDR_PANE_ID:'w_1-1',HERDR_SOCKET_PATH:path.join(root,'no-server.sock'),
    FAKE_HERDR_LOG:logs.herdr,FAKE_HERDR_SCENARIO:scenario,FAKE_CONFIG_DIR:configDir,FAKE_CLAUDE_LOG:logs.claude,FAKE_CLAUDE:JSON.stringify(claude),FAKE_GIT_LOG:logs.git,FAKE_GIT_REAL:realGit,...env}});
   let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.stdin.end(input);
   return new Promise(resolve=>p.on('close',code=>resolve({code,stdout,stderr,ms:Date.now()-started})));
  },
  calls(){return lines(logs.herdr).map(c=>c.argv);},
  // The arguments of the first herdr call that starts with the words of command, such as 'worktree create'.
  call(command){return this.calls().find(a=>a.slice(0,2).join(' ')===command);},
  kinds(){return this.calls().map(a=>a.slice(0,2).join(' '));},
  claude(){return fs.existsSync(logs.claude)?JSON.parse(fs.readFileSync(logs.claude,'utf8')):undefined;},
  gitCalls(){return lines(logs.git);},
  close(){fs.rmSync(root,{recursive:true,force:true});},
 };
}
// Gives main an origin that has branch, which main has not fetched.
function originWith(f,branch){const origin=path.join(f.root,'origin.git');git(f.root,'clone','-q','--bare',f.main,origin);git(f.main,'remote','add','origin',origin);git(origin,'branch',branch,'main');}
const startArgs=(name,kind='claude',...after)=>['agent','start',name,'--kind',kind,'--pane','w_9-1','--timeout','60000',...after];

test('names the branch with haiku, without the HERDR_* variables, and opens the worktree beside the repository',async()=>{
 const f=fixture();try{
  const r=await f.run(['add','a','login','page'],{claude:{stdout:'Sure.\nBRANCH=feat/add-login\n'}});
  assert.equal(r.code,0,r.stderr);
  const c=f.claude();assert.deepEqual(c.argv,['-p','--model','haiku']);assert.deepEqual(c.herdrEnv,[]);
  assert.match(c.input,/BRANCH=type\/short-kebab-name/);assert.match(c.input,/Requirement:\nadd a login page$/);
  assert.deepEqual(f.call('worktree create'),['worktree','create','--cwd',f.main,'--branch','feat/add-login','--path',path.join(f.root,'main-worktrees','feat-add-login'),'--focus']);
  assert.deepEqual(f.call('agent start'),startArgs('feat-add-login','claude','--','--dangerously-skip-permissions'));
  assert.deepEqual(f.call('agent prompt'),['agent','prompt','feat-add-login','add a login page']);
  assert.deepEqual(f.kinds(),['plugin config-dir','worktree create','agent list','agent start','agent prompt']);
  assert.match(r.stdout,/feat\/add-login/);assert.match(r.stdout,/w_9-1/);
 }finally{f.close();}
});

test('falls back to a random worktree/ branch when naming fails, returns an invalid name or times out',async()=>{
 for(const [claude,config] of [[{exit:1},{}],[{stdout:'BRANCH=Feature/Add Login\n'},{}],[{stdout:'no branch here'},{}],[{sleepMs:20000,stdout:'BRANCH=feat/late'},{namingTimeoutMs:500}]]){
  const f=fixture();try{
   f.config(config);const r=await f.run(['任务描述'],{claude});
   assert.equal(r.code,0,r.stderr);assert.ok(r.ms<8000,`took ${r.ms} ms`);
   const create=f.call('worktree create'),branch=create[create.indexOf('--branch')+1];
   assert.match(branch,randomName,JSON.stringify(claude));assert.equal(create[create.indexOf('--path')+1],path.join(f.root,'main-worktrees',branch.replaceAll('/','-')));
   assert.match(r.stdout,/随机分支名/);
  }finally{f.close();}
 }
});

test('-b uses a local branch as it is, without naming or fetching',async()=>{
 const f=fixture();try{
  git(f.main,'branch','feat/local');
  const r=await f.run(['-b','feat/local','keep','going']);
  assert.equal(r.code,0,r.stderr);assert.equal(f.claude(),undefined);
  assert.ok(!f.gitCalls().some(a=>a.includes('fetch')));
  assert.deepEqual(f.call('worktree create'),['worktree','create','--cwd',f.main,'--branch','feat/local','--path',path.join(f.root,'main-worktrees','feat-local'),'--focus']);
  assert.deepEqual(f.call('agent prompt'),['agent','prompt','feat-local','keep going']);
 }finally{f.close();}
});

test('-b without a description continues work on the branch',async()=>{
 const f=fixture();try{
  git(f.main,'branch','fix/crash');
  const r=await f.run(['--branch=fix/crash']);
  assert.equal(r.code,0,r.stderr);assert.deepEqual(f.call('agent prompt'),['agent','prompt','fix-crash','Continue work on branch fix/crash']);
 }finally{f.close();}
});

test('-b tracks a branch that only origin has',async()=>{
 const f=fixture();try{
  originWith(f,'feat/remote');
  const r=await f.run(['-b','feat/remote','pick it up']);
  assert.equal(r.code,0,r.stderr);
  assert.equal(git(f.main,'rev-parse','--abbrev-ref','feat/remote@{upstream}'),'origin/feat/remote');
  assert.deepEqual(f.call('worktree create').slice(0,6),['worktree','create','--cwd',f.main,'--branch','feat/remote']);
  assert.match(r.stdout,/origin\/feat\/remote/);
 }finally{f.close();}
});

test('-b fails before creating anything when neither the repository nor origin has the branch',async()=>{
 const f=fixture();try{
  originWith(f,'feat/other');
  const r=await f.run(['-b','feat/missing','x']);
  assert.equal(r.code,1);assert.match(r.stderr,/feat\/missing/);assert.match(r.stderr,/没有创建任何东西/);
  assert.equal(f.call('worktree create'),undefined);
  const invalid=await f.run(['-b','bad..name','x']);assert.equal(invalid.code,1);assert.match(invalid.stderr,/bad\.\.name/);
 }finally{f.close();}
});

test('a task started in a linked worktree uses the main checkout and the HEAD of the linked worktree as base',async()=>{
 const f=fixture();try{
  const linked=path.join(f.root,'linked');git(f.main,'worktree','add','-q','-b','side',linked);
  fs.writeFileSync(path.join(linked,'a.txt'),'x');git(linked,'add','a.txt');git(linked,'commit','-q','-m','side');fs.mkdirSync(path.join(linked,'sub'));
  const r=await f.run(['from','the','side'],{cwd:path.join(linked,'sub'),claude:{stdout:'BRANCH=feat/from-side'}});
  assert.equal(r.code,0,r.stderr);
  assert.deepEqual(f.call('worktree create'),['worktree','create','--cwd',f.main,'--branch','feat/from-side','--path',path.join(f.root,'main-worktrees','feat-from-side'),'--base',git(linked,'rev-parse','HEAD'),'--focus']);
 }finally{f.close();}
});

test('refuses an existing worktree directory before creating anything',async()=>{
 const f=fixture();try{
  originWith(f,'feat/taken');const dir=path.join(f.root,'main-worktrees','feat-taken');fs.mkdirSync(dir,{recursive:true});
  const r=await f.run(['-b','feat/taken','x']);
  assert.equal(r.code,1);assert.ok(r.stderr.includes(dir),r.stderr);assert.match(r.stderr,/没有创建任何东西/);
  assert.equal(f.call('worktree create'),undefined);assert.throws(()=>git(f.main,'rev-parse','--verify','--quiet','refs/heads/feat/taken'));
 }finally{f.close();}
});

test('waits for an agent that stops at a startup dialog, without sending keys, and prompts it once it is ready',async()=>{
 const f=fixture();try{
  f.scenario({'agent start':{error:{code:'agent_not_ready',message:'agent feat-add-login is blocked during startup and is not ready for prompts'}}});
  const r=await f.run(['--notify','add login']);
  assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/w_9-1/);
  assert.deepEqual(f.call('agent wait'),['agent','wait','feat-add-login','--until','idle','--until','done','--timeout','300000']);
  assert.deepEqual(f.kinds(),['plugin config-dir','worktree create','agent list','agent start','notification show','agent wait','agent prompt']);
  assert.ok(f.call('notification show').join(' ').includes('w_9-1'));
 }finally{f.close();}
});

test('reports the pane and what exists when the agent stays at the startup dialog',async()=>{
 const f=fixture();try{
  f.config({readyTimeoutMs:2000});
  f.scenario({'agent start':{error:{code:'agent_not_ready',message:'blocked'}},'agent wait':{error:{code:'timeout',message:'timed out waiting for agent status'}}});
  const r=await f.run(['add login']);
  assert.equal(r.code,1);assert.equal(f.call('agent prompt'),undefined);
  assert.deepEqual(f.call('agent wait').slice(-1),['2000']);
  for(const s of ['w_9-1','w_9',path.join(f.root,'main-worktrees','feat-add-login'),'feat-add-login'])assert.ok(r.stderr.includes(s),`${s} in ${r.stderr}`);
 }finally{f.close();}
});

test('sends a multi-line description unchanged, from a file with additional context or from stdin',async()=>{
 const text='  第一行：保留缩进\n\n- 列表项 `code`\n\tTab 和 "引号" $HOME\n最后一行\n';
 const f=fixture();try{
  fs.writeFileSync(path.join(f.main,'task.md'),text);
  const r=await f.run(['task.md','extra','context']);
  assert.equal(r.code,0,r.stderr);assert.equal(f.call('agent prompt')[3],text.trimEnd()+'\n\nAdditional context: extra context');
  assert.ok(f.claude().input.includes(text.trimEnd()));
 }finally{f.close();}
 const g=fixture();try{
  const r=await g.run(['-'],{input:text});
  assert.equal(r.code,0,r.stderr);assert.equal(g.call('agent prompt')[3],text.trimEnd());
 }finally{g.close();}
});

test('starts Codex with its bypass flag, and either agent without bypass flags when the config turns them off',async()=>{
 const f=fixture();try{
  const r=await f.run(['--codex','x']);
  assert.equal(r.code,0,r.stderr);assert.deepEqual(f.call('agent start'),startArgs('feat-add-login','codex','--','--dangerously-bypass-approvals-and-sandbox'));
 }finally{f.close();}
 for(const flags of [[],['--codex']]){
  const g=fixture();try{
   g.config({bypassPermissions:false});const r=await g.run([...flags,'x']);
   assert.equal(r.code,0,r.stderr);assert.deepEqual(g.call('agent start'),startArgs('feat-add-login',flags.length?'codex':'claude'));
  }finally{g.close();}
 }
});

test('every failing step reports what it has already created and leaves it in place',async()=>{
 const worktree=f=>path.join(f.root,'main-worktrees','feat-add-login');
 const cases=[
  {name:'worktree create',scenario:{'worktree create':{error:{code:'worktree_create_failed',message:'fatal: invalid reference'}}},has:[],nothing:true},
  {name:'worktree opened',scenario:{'worktree create':{mkdir:true,error:{code:'worktree_open_failed',message:'created worktree but failed to open workspace'}}},has:[worktree]},
  {name:'agent list',scenario:{'agent list':{error:{code:'server_unavailable',message:'no server'}}},has:[worktree,()=>'w_9',()=>'w_9-1']},
  {name:'agent start',scenario:{'agent start':{error:{code:'agent_start_failed',message:'agent process exited before becoming interactive'}}},has:[worktree,()=>'w_9-1',()=>'agent_start_failed']},
  {name:'agent prompt',scenario:{'agent prompt':{error:{code:'agent_prompt_failed',message:'nope'}}},has:[worktree,()=>'w_9-1',()=>'feat-add-login']},
 ];
 for(const c of cases){
  const f=fixture();try{
   f.scenario(c.scenario);const r=await f.run(['--notify','add login']);
   assert.equal(r.code,1,c.name);
   for(const s of c.has)assert.ok(r.stderr.includes(s(f)),`${c.name}: ${s(f)} in ${r.stderr}`);
   assert.equal(/没有创建任何东西/.test(r.stderr),Boolean(c.nothing),`${c.name}: ${r.stderr}`);
   assert.match(f.call('notification show')[2],/失败/,c.name);
  }finally{f.close();}
 }
 // A tracking branch made for -b counts as created; one that git could not make leaves nothing.
 const f=fixture();try{
  originWith(f,'feat/remote');f.scenario({'worktree create':{error:{code:'worktree_create_failed',message:'fatal'}}});
  const r=await f.run(['-b','feat/remote','x']);
  assert.equal(r.code,1);assert.match(r.stderr,/feat\/remote/);assert.match(r.stderr,/origin\/feat\/remote/);assert.doesNotMatch(r.stderr,/没有创建任何东西/);
 }finally{f.close();}
 const g=fixture();try{
  originWith(g,'feat/remote');const r=await g.run(['-b','feat/remote','x'],{env:{FAKE_GIT_FAIL:'branch'}});
  assert.equal(r.code,1);assert.match(r.stderr,/没有创建任何东西/);assert.equal(g.call('worktree create'),undefined);
 }finally{g.close();}
});

test('the agent gets a name from the branch that no running agent has',async()=>{
 const f=fixture();try{
  f.scenario({'agent list':{result:{type:'agent_list',agents:[{name:'feat-add-login'},{name:'feat-add-login-2'},{}]}}});
  const r=await f.run(['x']);
  assert.equal(r.code,0,r.stderr);assert.equal(f.call('agent start')[2],'feat-add-login-3');assert.equal(f.call('agent prompt')[2],'feat-add-login-3');
 }finally{f.close();}
});

test('a bad config, an oversized description or a directory outside Git stops before anything is created',async()=>{
 for(const config of ['{"bypass":false}','{"agentStartTimeoutMs":1000}','{"namingTimeoutMs":"5s"}','not json']){
  const f=fixture();try{
   f.config(config);const r=await f.run(['x']);
   assert.equal(r.code,1,config);assert.match(r.stderr,/config\.json/,config);assert.deepEqual(f.kinds(),['plugin config-dir'],config);assert.equal(f.claude(),undefined);
  }finally{f.close();}
 }
 const f=fixture();try{
  const r=await f.run(['-'],{input:'长'.repeat(50000)});
  assert.equal(r.code,1);assert.match(r.stderr,/128000/);assert.equal(f.call('worktree create'),undefined);assert.equal(f.claude(),undefined);
  const outsideGit=path.join(f.root,'plain');fs.mkdirSync(outsideGit);
  const n=await f.run(['x'],{cwd:outsideGit});assert.equal(n.code,1);assert.match(n.stderr,/Git/);assert.equal(f.call('worktree create'),undefined);
 }finally{f.close();}
});

test('reads the config from HERDR_PLUGIN_CONFIG_DIR when Herdr provides it, and asks Herdr for the directory otherwise',async()=>{
 const f=fixture();try{
  const own=path.join(f.root,'own');fs.mkdirSync(own);fs.writeFileSync(path.join(own,'config.json'),'{"bypassPermissions":false}');
  const r=await f.run(['x'],{env:{HERDR_PLUGIN_CONFIG_DIR:own}});
  assert.equal(r.code,0,r.stderr);assert.equal(f.call('plugin config-dir'),undefined);assert.deepEqual(f.call('agent start'),startArgs('feat-add-login'));
 }finally{f.close();}
 const g=fixture();try{
  const r=await g.run(['x']);assert.equal(r.code,0,r.stderr);assert.deepEqual(g.call('plugin config-dir'),['plugin','config-dir','bezhai.worktree-task']);
 }finally{g.close();}
});

test('usage errors exit with status 2',async()=>{
 const f=fixture();try{
  for(const args of [[],['--unknown','x'],['-b']]){const r=await f.run(args);assert.equal(r.code,2,args.join(' '));assert.match(r.stderr,/用法/);}
  assert.deepEqual(f.calls(),[]);
 }finally{f.close();}
});

test('branch names: haiku output is validated, the fallback looks like Herdr\'s, and the path replaces / with -',()=>{
 assert.equal(parseBranch('x\nBRANCH=feat/a-b c\nBRANCH=fix/z'),'feat/a-b');assert.equal(parseBranch('nothing'),undefined);
 for(const b of ['feat/add-login','fix/a1','style/x'])assert.ok(validBranch(b),b);
 for(const b of ['feature/x','feat/','feat/Add','feat/a_b','feat/a--b','feat/-a','feat/a/b','feat/'+'a'.repeat(60),'Feat/x'])assert.ok(!validBranch(b),b);
 for(let i=0;i<20;i++)assert.match(randomBranch(),randomName);
 assert.equal(worktreePath('/src/genvi','feat/a/b'),'/src/genvi-worktrees/feat-a-b');
});

test('agent names fit Herdr: lowercase, starting with a letter, at most 32 characters, unique',()=>{
 const none=new Set();
 assert.equal(agentName('feat/add-login',none),'feat-add-login');assert.equal(agentName('Fix/Crash_On.Start',none),'fix-crash_on-start');
 assert.equal(agentName('123/中文分支',none),'task');assert.equal(agentName('9-lives',none),'lives');
 const long=agentName('feat/'+'abcdefghij'.repeat(5),none);assert.equal(long.length,32);assert.equal(long,'feat-abcdefghijabcdefghijabcdefg');
 const taken=new Set([long,long.slice(0,30)+'-2']);assert.equal(agentName('feat/'+'abcdefghij'.repeat(5),taken),long.slice(0,30)+'-3');
 // A name cut to 32 characters does not end with -.
 assert.equal(agentName('feat/abcdefghijabcdefghijabcdef-x',none),'feat-abcdefghijabcdefghijabcdef');
 for(const b of ['feat/x','a','worktree/brave-river-0a1b','FEAT/X-'])assert.match(agentName(b,none),/^[a-z][a-z0-9_-]{0,31}$/,b);
});
