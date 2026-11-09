import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {methods} from './machine.ts';
import type {WorkspaceProject} from './link.ts';
// The workspace methods of the client (see workspace.ts) against real Git: bare repositories in a temporary directory stand for the origins,
// which ssh://git@example.com/team/<name>.git reaches through an insteadOf of a Git config of the test. The client reads the home directory
// from the environment of the process, so the tests set HOME once, before any of them runs.
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-workspace-'))),home=path.join(root,'home'),origins=path.join(root,'origins'),scratch=path.join(root,'scratch');
for(const d of [home,origins,scratch])fs.mkdirSync(d);
process.env.HOME=home;
const config=path.join(root,'gitconfig');
fs.writeFileSync(config,`[user]\n name = t\n email = t@example.com\n[init]\n defaultBranch = main\n[protocol "file"]\n allow = always\n[url "${origins}/"]\n insteadOf = ssh://git@example.com/team/\n`);
const env={...process.env,LC_ALL:'C',GIT_CONFIG_GLOBAL:config,GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,env,encoding:'utf8'}).trim();
const client=methods({herdr:'unused',env});
const data=path.join(home,'.local/share/herdr-bridge');
// The URL of a repository of the origins, and what the origin holds: a bare repository with one commit on main that has README.md.
const url=(name:string)=>`ssh://git@example.com/team/${name}.git`;
function origin(name:string,files:Record<string,string>={'README.md':`# ${name}\n`}){
 const bare=path.join(origins,name+'.git'),work=path.join(scratch,name);
 fs.mkdirSync(path.dirname(bare),{recursive:true});fs.mkdirSync(path.dirname(work),{recursive:true});git(origins,'init','-q','--bare',bare);git(scratch,'clone','-q',bare,work);
 for(const [f,body] of Object.entries(files))fs.writeFileSync(path.join(work,f),body);
 git(work,'add','.');git(work,'commit','-q','-m','first');git(work,'push','-q','origin','main');
 return work;
}
// A commit on main of origin, made through the scratch clone of the repository.
function advance(name:string,file:string){const work=path.join(scratch,name);fs.writeFileSync(path.join(work,file),file);git(work,'add','.');git(work,'commit','-q','-m',file);git(work,'push','-q','origin','main');return git(work,'rev-parse','HEAD');}
const project=(id:string,repos:string[],workMode:WorkspaceProject['workMode'],adoptedDir?:string):WorkspaceProject=>({id,repos:repos.map(url),workMode,...adoptedDir&&{adoptedDir}});
const branchOf=(dir:string)=>git(dir,'rev-parse','--abbrev-ref','HEAD'),head=(dir:string)=>git(dir,'rev-parse','HEAD');
const prepare=async(p:WorkspaceProject,topicId:string,branch?:string)=>client.prepareWorkspace({project:p,topicId,...branch&&{branch},timeoutMs:60000});
const remove=async(p:WorkspaceProject,topicId:string,branch?:string)=>client.removeWorkspace({project:p,topicId,...branch&&{branch},timeoutMs:60000});
const describe=async(c:typeof client,repos:string[])=>c.describeRepos({repos,timeoutMs:60000});
const clones=()=>fs.existsSync(path.join(data,'repos'))?fs.readdirSync(path.join(data,'repos')).sort():[];
const branches=(repo:string)=>git(path.join(data,'repos',repo),'branch','--format=%(refname:short)').split('\n').filter(Boolean).sort();

test('an isolated project with one repository gets the worktree of its topic as the directory, on the branch it is given, made from the default branch of origin as fetched just now; the clone is made once per repository and shared by the topics',async()=>{
 origin('app');const p=project('p1',['app'],'isolated');
 const first=advance('app','one.txt'),{dir}=await prepare(p,'t1','topic/fix-a');
 assert.equal(dir,path.join(data,'topics/t1/app'));assert.equal(branchOf(dir),'topic/fix-a');assert.equal(head(dir),first);assert.ok(fs.existsSync(path.join(dir,'one.txt')));
 // Another commit lands on origin before the second topic: its worktree starts there, from the same clone, and does not track main.
 const second=advance('app','two.txt'),other=await prepare(p,'t2','topic/fix-b');
 assert.equal(head(other.dir),second);assert.deepEqual(clones(),['example.com__team__app']);
 assert.equal(git(other.dir,'config','--default','','--get','branch.topic/fix-b.merge'),'');
 // Calling again for a topic that has its worktree leaves it as it is, work not committed included.
 fs.writeFileSync(path.join(dir,'draft.txt'),'wip');assert.deepEqual(await prepare(p,'t1','topic/fix-a'),{dir});assert.equal(fs.readFileSync(path.join(dir,'draft.txt'),'utf8'),'wip');
});
test('an isolated project with several repositories gets a directory for the topic with one worktree per repository, named after it, all on the branch',async()=>{
 origin('web');origin('api');const p=project('p2',['web','api'],'isolated');
 const {dir}=await prepare(p,'t3','topic/both');
 assert.equal(dir,path.join(data,'topics/t3'));assert.deepEqual(fs.readdirSync(dir).sort(),['api','web']);
 for(const n of ['web','api'])assert.equal(branchOf(path.join(dir,n)),'topic/both',n);
 // Two repositories of one name keep apart.
 origin('app2');origin('sub/app2');
 const twin=await prepare({id:'p2b',repos:[url('app2'),url('sub/app2')],workMode:'isolated'},'t3b','topic/twin');
 assert.deepEqual(fs.readdirSync(twin.dir).sort(),['app2','app2-2']);
});
test('a worktree that was removed comes back from its branch: a local one with its commits, or one that only origin has; a new branch is created only when neither has it',async()=>{
 origin('doc');const p=project('p3',['doc'],'isolated');
 const {dir}=await prepare(p,'t4','topic/keep');fs.writeFileSync(path.join(dir,'note.txt'),'n');git(dir,'add','.');git(dir,'commit','-q','-m','note');const made=head(dir);
 fs.rmSync(path.join(data,'topics/t4'),{recursive:true});
 const again=await prepare(p,'t4','topic/keep');assert.equal(again.dir,dir);assert.equal(head(dir),made);assert.equal(fs.readFileSync(path.join(dir,'note.txt'),'utf8'),'n');
 // Pushed, and gone locally with its worktree: restored from origin, tracking it.
 git(dir,'push','-q','origin','topic/keep');fs.rmSync(path.join(data,'topics/t4'),{recursive:true});git(path.join(data,'repos/example.com__team__doc'),'worktree','prune');
 git(path.join(data,'repos/example.com__team__doc'),'branch','-D','topic/keep');
 const third=await prepare(p,'t4','topic/keep');assert.equal(head(third.dir),made);assert.equal(git(third.dir,'rev-parse','--abbrev-ref','topic/keep@{upstream}'),'origin/topic/keep');
});
test('removing a workspace deletes the directory of the topic and the branch of a repository where the branch has no commit of its own, keeps it where it has one, and says whether any branch was kept; removing what is gone succeeds',async()=>{
 origin('left');origin('right');const p=project('p4',['left','right'],'isolated');
 const {dir}=await prepare(p,'t5','topic/split');
 fs.writeFileSync(path.join(dir,'right/work.txt'),'w');git(path.join(dir,'right'),'add','.');git(path.join(dir,'right'),'commit','-q','-m','work');
 // Work that is not committed goes with the directory.
 fs.writeFileSync(path.join(dir,'left/draft.txt'),'d');
 assert.deepEqual(await remove(p,'t5','topic/split'),{branchKept:true});
 assert.equal(fs.existsSync(dir),false);assert.deepEqual(branches('example.com__team__left'),['main']);assert.deepEqual(branches('example.com__team__right'),['main','topic/split']);
 assert.equal(git(path.join(data,'repos/example.com__team__left'),'worktree','list').split('\n').length,1);
 assert.deepEqual(await remove(p,'t5','topic/split'),{branchKept:true});
 // Without a commit of its own in any repository, nothing is kept; a workspace that never existed is removed already.
 await prepare(p,'t6','topic/empty');assert.deepEqual(await remove(p,'t6','topic/empty'),{branchKept:false});assert.deepEqual(await remove(p,'t7','topic/never'),{branchKept:false});
});
test('a shared project works in a directory of its own with its repositories cloned into it, the checkout itself when it has one repository; what is not in Git stays, the checkouts are fetched and never changed, and removing a topic leaves the directory',async()=>{
 origin('shop');origin('cart');
 const one=project('s1',['shop'],'shared'),{dir}=await prepare(one,'t8');
 assert.equal(dir,path.join(data,'projects/s1/shop'));assert.equal(branchOf(dir),'main');assert.equal(fs.existsSync(path.join(dir,'.git')),true);
 // Untracked files stay, a commit on origin is fetched but not merged, and another topic of the project gets the same directory.
 fs.writeFileSync(path.join(dir,'data.csv'),'x');const before=head(dir),landed=advance('shop','later.txt');
 assert.deepEqual(await prepare(one,'t9'),{dir});assert.equal(head(dir),before);assert.equal(git(dir,'rev-parse','origin/main'),landed);assert.equal(fs.readFileSync(path.join(dir,'data.csv'),'utf8'),'x');
 assert.equal(clones().includes('example.com__team__shop'),false);
 assert.deepEqual(await remove(one,'t8'),{branchKept:false});assert.equal(fs.existsSync(path.join(dir,'data.csv')),true);
 const two=project('s2',['shop','cart'],'shared'),both=await prepare(two,'t10');
 assert.equal(both.dir,path.join(data,'projects/s2'));assert.deepEqual(fs.readdirSync(both.dir).sort(),['cart','shop']);
 // A shared project does not make a worktree, whatever the branch.
 const withBranch=await prepare(two,'t11','topic/ignored');assert.deepEqual(withBranch,both);assert.equal(git(path.join(both.dir,'cart'),'worktree','list').split('\n').length,1);
 // A directory in the place of a checkout that is none is not cloned into.
 fs.mkdirSync(path.join(data,'projects/s3/shop'),{recursive:true});fs.writeFileSync(path.join(data,'projects/s3/shop/mine.txt'),'');
 await assert.rejects(prepare(project('s3',['shop'],'shared'),'t12'),/不是 Git 仓库/);assert.equal(fs.existsSync(path.join(data,'projects/s3/shop/mine.txt')),true);
});
test('what goes wrong in preparing a workspace is told in words of the console, which shows it: without a path of the machine or the word worktree, apart from what Git itself says',async()=>{
 origin('occupied-repo');const p=project('e1',['occupied-repo'],'isolated'),message=(run:Promise<unknown>)=>run.then(()=>{throw Error('prepared');},(e:Error)=>e.message);
 fs.mkdirSync(path.join(data,'topics/e1/occupied-repo'),{recursive:true});fs.writeFileSync(path.join(data,'topics/e1/occupied-repo/mine.txt'),'');
 const inUse=await message(prepare(p,'e1','topic/a'));assert.equal(inUse,'话题的目录已存在，里面有别的内容');
 await prepare(p,'e2','topic/b');const taken=await message(prepare(p,'e3','topic/b'));assert.match(taken,/^为分支 topic\/b 创建话题目录失败：/);assert.doesNotMatch(taken.split('：')[0],/worktree/);
 fs.mkdirSync(path.join(data,'projects/e4/occupied-repo'),{recursive:true});fs.writeFileSync(path.join(data,'projects/e4/occupied-repo/mine.txt'),'');
 const notGit=await message(prepare(project('e4',['occupied-repo'],'shared'),'e5'));assert.equal(notGit,'项目的目录里已有 occupied-repo，不是 Git 仓库，没有往里面 clone');
});
test('a project that adopted a directory works in it as it is: checkouts there are fetched only, missing repositories are cloned into it, and removing a topic leaves it',async()=>{
 const work=origin('mall');origin('pay');
 const adopted=path.join(home,'old/mall-parent');fs.mkdirSync(adopted,{recursive:true});git(adopted,'clone','-q',url('mall'),'mall');
 fs.writeFileSync(path.join(adopted,'mall/README.md'),'edited locally');const before=head(path.join(adopted,'mall')),landed=advance('mall','x.txt');void work;
 const p=project('a1',['mall','pay'],'shared',adopted),{dir}=await prepare(p,'t13','topic/ignored');
 assert.equal(dir,adopted);assert.equal(head(path.join(adopted,'mall')),before);assert.equal(fs.readFileSync(path.join(adopted,'mall/README.md'),'utf8'),'edited locally');
 assert.equal(git(path.join(adopted,'mall'),'rev-parse','origin/main'),landed);assert.equal(branchOf(path.join(adopted,'pay')),'main');
 assert.deepEqual(await remove(p,'t13','topic/ignored'),{branchKept:false});assert.equal(fs.existsSync(path.join(adopted,'pay')),true);
 // Without repositories it is the directory and nothing else, also an isolated project's: the directory is the project's, not the topic's.
 const plain=path.join(home,'old/notes');fs.mkdirSync(plain,{recursive:true});fs.writeFileSync(path.join(plain,'CLAUDE.md'),'');
 assert.deepEqual(await prepare(project('a2',[],'shared',plain),'t14'),{dir:plain});assert.deepEqual(fs.readdirSync(plain),['CLAUDE.md']);
 assert.deepEqual(await prepare(project('a3',[],'isolated',plain),'t15'),{dir:plain});assert.deepEqual(await remove(project('a3',[],'isolated',plain),'t15'),{branchKept:false});assert.equal(fs.existsSync(plain),true);
});
test('a project without repositories gets an empty directory: its own for each topic when isolated, one fixed directory when shared',async()=>{
 const iso=project('n1',[],'isolated'),a=await prepare(iso,'t16'),b=await prepare(iso,'t17');
 assert.equal(a.dir,path.join(data,'topics/t16'));assert.notEqual(a.dir,b.dir);assert.deepEqual(fs.readdirSync(a.dir),[]);
 fs.writeFileSync(path.join(a.dir,'f'),'');assert.deepEqual(await prepare(iso,'t16'),a);assert.deepEqual(await remove(iso,'t16'),{branchKept:false});assert.equal(fs.existsSync(a.dir),false);assert.equal(fs.existsSync(b.dir),true);
 const shared=project('n2',[],'shared'),c=await prepare(shared,'t18'),d=await prepare(shared,'t19');
 assert.equal(c.dir,path.join(data,'projects/n2'));assert.deepEqual(d,c);fs.writeFileSync(path.join(c.dir,'keep'),'');await remove(shared,'t18');assert.equal(fs.existsSync(path.join(c.dir,'keep')),true);
});
test('topics that start at once in a repository that is not cloned yet share the one clone, and a failing clone or a repository without commits says why',async()=>{
 origin('busy');const p=project('c1',['busy'],'isolated');
 const made=await Promise.all(['a','b','c'].map(n=>prepare(p,'t2'+n,'topic/'+n)));
 assert.deepEqual(made.map(m=>branchOf(m.dir)),['topic/a','topic/b','topic/c']);assert.equal(clones().filter(c=>c.endsWith('busy')).length,1);
 await assert.rejects(prepare(project('c2',['missing'],'isolated'),'t3a','topic/x'),/missing/);
 git(origins,'init','-q','--bare','empty.git');await assert.rejects(prepare(project('c3',['empty'],'isolated'),'t3b','topic/x'),/默认分支/);
});
test('the params are checked: a topic id that is not a name, a branch that Git would take as an option or that is no branch name, an isolated project with repositories and no branch, a repository that is an option',async()=>{
 origin('safe');const p=project('v1',['safe'],'isolated');
 for(const topicId of ['../x','a/b','','.'])await assert.rejects(prepare(p,topicId,'topic/x'),(e:{code?:string})=>e.code==='invalid_params',topicId);
 for(const branch of ['-x','--detach','a b','topic/..','topic/x.lock',''])await assert.rejects(prepare(p,'tv',branch||undefined),(e:{code?:string})=>e.code==='invalid_params',branch);
 await assert.rejects(prepare({id:'v2',repos:['--upload-pack=x'],workMode:'isolated'},'tv','topic/x'),(e:{code?:string})=>e.code==='invalid_params');
 await assert.rejects(prepare({id:'../v',repos:[],workMode:'shared'},'tv'),(e:{code?:string})=>e.code==='invalid_params');
 await assert.rejects(prepare({id:'v3',repos:[],workMode:'both' as 'shared'},'tv'),(e:{code?:string})=>e.code==='invalid_params');
 assert.equal(fs.existsSync(path.join(data,'topics/tv')),false);
});
test('describing repositories reads the README of each repository, cloning a repository that is not cloned yet and leaving out one without a README, cut to what a prompt may hold; it fails when no repository has a README',async()=>{
 origin('notes',{'README.md':'# notes\nA tool that keeps meeting notes.\n'});origin('bare',{'LICENSE':'x'});origin('long',{'readme.rst':'x'.repeat(5000)});
 assert.deepEqual(await describe(client,[url('notes'),url('bare')]),{readmes:[{name:'notes',text:'# notes\nA tool that keeps meeting notes.\n'}]});
 assert.ok(clones().includes('example.com__team__bare'));
 const [long]=(await describe(client,[url('long')])).readmes;assert.deepEqual([long.name,long.text.length],['long',4000]);
 await assert.rejects(describe(client,[url('bare')]),/README/);
 await assert.rejects(describe(client,[]),(e:{code?:string})=>e.code==='invalid_params');
});
