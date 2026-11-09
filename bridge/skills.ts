import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {enqueue} from './core.ts';
import {skillMark} from './machine.ts';

// The skills of the platform, which the console's Skills page manages. Each is a directory named after it under skills/ in the state
// directory, with its SKILL.md and any other files. The state file holds only their index, the collection skills: the name, the description
// of the frontmatter of SKILL.md, preload, whether it is loaded by default (placed in the working directory of every topic before its agent
// starts, see place) or read on demand, and the digest of its files. The state file is written whole on almost every event and the console
// polls it every few seconds, so the files stay out of it: they are read when a skill is edited, read or placed.

// Where each machine keeps the skills that it got, one directory per skill (see placeSkills in machine.ts). No agent reads it as a global
// skill directory, unlike ~/.agents/skills, which Codex reads.
const machineStore='~/.local/share/herdr-bridge/skills';
// Where the agent of each binding kind reads project skills, under its working directory, and how a skill goes there: as a link to the store,
// which Claude and Codex follow, or as a copy, since Antigravity follows no link.
const places={claude:{dir:'.claude/skills',as:'link'},codex:{dir:'.agents/skills',as:'link'},agy:{dir:'.agents/skills',as:'copy'}};

// A name of the Agent Skills format: lowercase letters and digits with single hyphens between them, at most 64 characters, like its
// directory; its description at most 1024 characters.
const validName=n=>typeof n==='string'&&n.length<=64&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n),descriptionMax=1024;
// The most that the files of a skill hold together, in bytes, and the most that a request writing one carries: their base64 in JSON, with
// room for the rest. Skills come with scripts and references, and the 100,000 characters of other requests are too few for them.
export const skillLimit=1<<20,requestLimit=Math.ceil(skillLimit/3)*4+65536;
// The top-level fields of the YAML frontmatter that opens text, between two --- lines, or null without one. It reads YAML as far as skills
// write it there: `key: value` lines whose value is plain, single- or double-quoted, and may go on in more indented lines, or is a block (|
// or >) of those lines; a nested map is read as the value of its key and not looked into.
export function frontmatter(text){
 const m=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);if(!m)return null;
 const lines=m[1].split(/\r?\n/),fields={};
 for(let i=0;i<lines.length;i++){
  const f=/^([\w-]+):(?:[ \t]+(.*))?$/.exec(lines[i]);if(!f)continue;
  const v=(f[2]??'').trim(),more=[];while(i+1<lines.length&&/^(\s|$)/.test(lines[i+1]))more.push(lines[++i].trim());
  fields[f[1]]=/^[|>][+-]?$/.test(v)?more.join(v[0]==='|'?'\n':' ').trim():unquote([v,...more].filter(Boolean).join(' '));
 }
 return fields;
}
function unquote(v){
 if(/^".*"$/.test(v))try{return JSON.parse(v);}catch{}
 return /^'.*'$/.test(v)?v.slice(1,-1).replaceAll("''","'"):v;
}
// Skill name with files ({relative path: base64}) as {entries, description, digest}: its files as [path, content] in the order of their
// paths, the description of its SKILL.md and the digest of its files, which changes with their content. Throws on what makes it no skill:
// a name that is not one, a path that leaves its directory or takes the name of Bridge's marker on machines, content that is not base64,
// files over skillLimit together, and a SKILL.md without a frontmatter that names the skill as its directory and describes it.
function checked(name,files){
 if(!validName(name))throw Error(`skill 名称无效：${name}，只能用小写字母、数字和单个连字符，最多 64 个字符`);
 if(!files||typeof files!=='object'||Array.isArray(files)||!Object.values(files).every(b=>typeof b==='string'))throw Error('skill 的文件无效');
 const entries=Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([p,b])=>{
  if(path.isAbsolute(p)||p.split('/').some(s=>!s||s==='.'||s==='..')||p===skillMark)throw Error('文件路径无效：'+p);
  if(b.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(b))throw Error('文件内容不是 base64：'+p);
  return [p,Buffer.from(b,'base64')];
 });
 const size=entries.reduce((n,[,c])=>n+c.length,0);if(size>skillLimit)throw Error(`skill 的文件合计 ${size} 字节，超过上限 ${skillLimit} 字节`);
 const skill=entries.find(([p])=>p==='SKILL.md');if(!skill)throw Error('skill 缺少 SKILL.md');
 const f=frontmatter(skill[1].toString('utf8'));
 if(!f)throw Error('SKILL.md 开头没有 frontmatter：以 --- 开始和结束、写着 name 和 description 的几行');
 if(f.name!==name)throw Error(`SKILL.md 的 frontmatter 里 name ${f.name?'是 '+f.name:'是空的'}，必须和 skill 名称 ${name} 一致`);
 if(!f.description||f.description.length>descriptionMax)throw Error(`SKILL.md 的 frontmatter 缺少 description，或者超过 ${descriptionMax} 个字符`);
 return {entries,description:f.description,digest:crypto.createHash('sha256').update(JSON.stringify(entries.map(([p,c])=>[p,c.toString('base64')]))).digest('hex')};
}
export class Skills{
 // call(m,method,params,{timeoutMs}) sends a request to the client of machine m (see Clients.call).
 constructor(store,call){this.store=store;this.call=call;this.dir=path.join(store.dir,'skills');this.queues=new Map();}
 // The index, in the order of the names.
 list(){return this.store.data.skills;}
 // The entry of skill name; throws when there is none.
 entry(name){const s=this.store.data.skills.find(x=>x.name===name);if(!s)throw Error('skill 不存在：'+name);return s;}
 // Skill name with its files, {relative path: base64}.
 read(name){
  const s=this.entry(name),dir=path.join(this.dir,name);
  const files=fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>path.relative(dir,path.join(e.parentPath,e.name))).sort();
  return {...s,files:Object.fromEntries(files.map(p=>[p,fs.readFileSync(path.join(dir,p),'base64')]))};
 }
 // The SKILL.md of skill name as text.
 text(name){return fs.readFileSync(path.join(this.dir,this.entry(name).name,'SKILL.md'),'utf8');}
 // Imports skill name with files ({relative path: base64}) as a whole: a new skill, or in place of all the files of the one of that name,
 // whose flag stays. Returns its entry.
 put(name,files){const s=this.write(name,files);this.store.log('skill','导入了 skill '+name);return s;}
 // Writes text as the SKILL.md of skill name: of a new skill, the only file, when create; else of the skill of that name, whose other files
 // stay. Returns its entry.
 save(name,text,{create=false}={}){
  if(create&&this.store.data.skills.some(x=>x.name===name))throw Error('skill 已存在：'+name);
  const s=this.write(name,{...!create&&this.read(name).files,'SKILL.md':Buffer.from(String(text??'')).toString('base64')});
  this.store.log('skill',create?'新建了 skill '+name:`修改了 skill ${name} 的 SKILL.md`);return s;
 }
 // The files go into a directory beside the skill's, which then takes its place; the entry follows. Synchronous, like the state file, so
 // that two writes of a skill never interleave.
 write(name,files){
  const {entries,description,digest}=checked(name,files),target=path.join(this.dir,name);
  fs.mkdirSync(this.dir,{recursive:true,mode:0o700});const fresh=fs.mkdtempSync(path.join(this.dir,'.'+name+'-'));
  try{
   for(const [p,c] of entries){fs.mkdirSync(path.dirname(path.join(fresh,p)),{recursive:true});fs.writeFileSync(path.join(fresh,p),c);}
   fs.rmSync(target,{recursive:true,force:true});fs.renameSync(fresh,target);
  }catch(e){fs.rmSync(fresh,{recursive:true,force:true});throw e;}
  const old=this.store.data.skills.find(x=>x.name===name),s={name,description,preload:old?.preload??false,digest};
  this.store.data.skills=[...this.store.data.skills.filter(x=>x!==old),s].sort((a,b)=>a.name<b.name?-1:1);this.store.save();return s;
 }
 remove(name){
  this.entry(name);fs.rmSync(path.join(this.dir,name),{recursive:true,force:true});
  this.store.data.skills=this.store.data.skills.filter(x=>x.name!==name);this.store.save();this.store.log('skill','删除了 skill '+name);
 }
 // Sets whether skill name is loaded by default (see place).
 flag(name,preload){
  const s=this.entry(name);s.preload=Boolean(preload);this.store.save();
  this.store.log('skill',`skill ${name} 已设为${s.preload?'默认加载':'按需读取'}，之后新开的话题生效`);return s;
 }
 // The entries of the skills whose name, description or SKILL.md hold every word of query, in any case: those with them in the name or
 // the description first, each part in the order of the names.
 search(query){
  const words=typeof query==='string'?query.toLowerCase().split(/\s+/).filter(Boolean):[];if(!words.length)throw Error('缺少要搜索的词');
  const has=text=>{const t=text.toLowerCase();return words.every(w=>t.includes(w));},about=s=>s.name+'\n'+s.description;
  const named=this.list().filter(s=>has(about(s)));
  return [...named,...this.list().filter(s=>!named.includes(s)&&has(about(s)+'\n'+this.text(s.name)))];
 }
 // Places the skills loaded by default, as they are when the placement runs, where the agent of binding kind kind reads project skills
 // in working directory cwd on machine m, whose leading ~/ is that machine's home, and takes away those that Bridge placed there before and
 // that are no longer loaded by default: the request placeSkills to the client of m, with the skills as data. Resolves to the paths of same-name
 // skills that are not Bridge's, which the client left alone, and rejects when the placement fails. Placements on one machine run one after
 // another, since they share its store.
 place(m,cwd,kind){
  const skills=()=>this.list().filter(s=>s.preload).map(s=>{const {digest,files}=this.read(s.name);return {name:s.name,digest,files};});
  return enqueue(this.queues,m.id,()=>this.call(m,'placeSkills',{store:machineStore,skills:skills(),...places[kind],cwd}));
 }
 // Answers request op with body of bridge-skill on machine m, which comes through the client of m (see Clients): list, the index; search,
 // the entries that match body.query; read, skill body.name with the text of its SKILL.md and the paths of its other files, which the
 // client of m puts into its store first, after the placements queued there, so that the answer also has their directory there, path. The
 // socket of that client takes the commands of any agent of m, and what the platform holds goes into every later agent: nothing else is
 // answered, writes least of all, and nothing on a machine that Bridge does not use.
 async answer(m,op,body){
  if(!['list','search','read'].includes(op))throw Error('未知的操作：'+op);
  if(!body||typeof body!=='object'||Array.isArray(body))throw Error('请求内容无效');
  if(!m.enabled)throw Error(`Bridge 已断开机器 ${m.name} 的桥接`);
  if(op==='list')return {skills:this.list()};
  if(op==='search')return {skills:this.search(body.query)};
  const {name,description,preload,digest,files}=this.read(body.name),text=Buffer.from(files['SKILL.md'],'base64').toString('utf8'),others=Object.keys(files).filter(p=>p!=='SKILL.md');
  const read={name,description,preload,text,files:others};if(!others.length)return read;
  return {...read,path:await enqueue(this.queues,m.id,()=>this.call(m,'stockSkill',{store:machineStore,skill:{name,digest,files}}))};
 }
}
