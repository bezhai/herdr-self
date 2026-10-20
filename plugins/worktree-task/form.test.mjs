import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {field,insert,backspace,del,left,right,home,end,up,down,layout,width} from './text-field.mjs';
import {newForm,press,render,taskArgs,startInBackground,pruneLogs,contextDir} from './form.mjs';import {PLUGIN_ID} from './config.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const plain=s=>s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'');
const tmp=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'worktree-task-form-')));

test('the text field edits by grapheme: insert, backspace, delete, left, right, home, end, up and down',()=>{
 const f=field();insert(f,'ab中\n文👍🏽x');
 left(f);left(f);assert.equal(f.cursor,'ab中\n文'.length);
 right(f);backspace(f);assert.equal(f.text,'ab中\n文x');
 home(f);assert.equal(f.cursor,'ab中\n'.length);end(f);assert.equal(f.cursor,f.text.length);
 up(f);assert.equal(f.cursor,'ab'.length);del(f);assert.equal(f.text,'ab\n文x');
 down(f);assert.equal(f.cursor,'ab\n文x'.length);insert(f,'\n');assert.equal(f.text,'ab\n文x\n');
 home(f);backspace(f);backspace(f);assert.equal(f.text,'ab\n文');
 left(f);left(f);left(f);left(f);left(f);assert.equal(f.cursor,0);backspace(f);assert.equal(f.text,'ab\n文');
});

test('the layout wraps by display width and puts the cursor where the next character goes',()=>{
 assert.equal(width('a中👍🏽é'),6);
 assert.deepEqual(layout({text:'abcdef',cursor:6},4),{rows:['abcd','ef'],row:1,col:2});
 assert.deepEqual(layout({text:'abcdef',cursor:4},4),{rows:['abcd','ef'],row:1,col:0});
 assert.deepEqual(layout({text:'abcd',cursor:4},4),{rows:['abcd'],row:0,col:4});
 assert.deepEqual(layout({text:'ab中文',cursor:2},4),{rows:['ab中','文'],row:0,col:2});
 assert.deepEqual(layout({text:'abc中',cursor:4},4),{rows:['abc','中'],row:1,col:2});
 assert.deepEqual(layout({text:'a\n\nb',cursor:2},4),{rows:['a','','b'],row:1,col:0});
 assert.deepEqual(layout({text:'',cursor:0},4),{rows:[''],row:0,col:0});
});

test('the form collects a multi-line description, an optional branch and the agent, and submits with Ctrl-S',()=>{
 const s=newForm();
 assert.equal(press(s,'第一行\r第二行'),undefined);press(s,'\t');press(s,'feat/x');press(s,'\t');press(s,'\x1b[C');
 assert.deepEqual(press(s,'\x13'),{type:'submit',description:'第一行\n第二行',branch:'feat/x',kind:'codex'});
 const t=newForm();press(t,'task');press(t,'\x1b[Z');assert.equal(t.focus,2);press(t,' ');press(t,' ');
 press(t,'\x1b[Z');press(t,'  feat/y \r');assert.equal(t.focus,2);
 assert.deepEqual(press(t,'\r'),{type:'submit',description:'task',branch:'feat/y',kind:'claude'});
});

test('a paste goes into the focused field as it is, also when it arrives in pieces',()=>{
 const s=newForm();press(s,'\x1b[200~a\r\nb\rc\td\x1b[201~');assert.equal(s.desc.text,'a\nb\nc\td');
 press(s,'\x1b[200~\r\n第二');press(s,'段\x1b[201~!');assert.equal(s.desc.text,'a\nb\nc\td\n第二段!');
 press(s,'\t\x1b[200~feat/z\n\x1b[201~');assert.equal(press(s,'\x13').branch,'feat/z');
});

test('the form cancels with Esc or Ctrl-C and refuses to submit without a description or a branch',()=>{
 assert.deepEqual(press(newForm(),'\x1b'),{type:'cancel'});assert.deepEqual(press(newForm(),'abc\x03'),{type:'cancel'});
 const s=newForm();assert.equal(press(s,'  \r\x13'),undefined);assert.match(s.error,/任务描述/);
 assert.match(plain(render(s,{cols:60,rows:16,repo:{mainRoot:'/src/main',linked:false}})),/任务描述/);
 const b=newForm();press(b,'x\tfeat/a b');assert.equal(press(b,'\x13'),undefined);assert.match(b.error,/分支/);
 assert.deepEqual(press(newForm(),'\tfeat/only\x13'),{type:'submit',description:'',branch:'feat/only',kind:'claude'});
});

test('the form fits the popup and shows the cursor only in text fields',()=>{
 const s=newForm();press(s,'很长的任务描述'.repeat(40)+'\r'.repeat(30)+'end');
 for(const [cols,rows] of [[40,12],[80,24],[30,8]]){
  const out=render(s,{cols,rows,repo:{mainRoot:'/very/long/path/to/the/main/repository/checkout',linked:true}}),screen=plain(out).split('\r\n');
  assert.ok(screen.length<=rows,`${screen.length} lines for ${rows} rows`);
  for(const line of screen)assert.ok(width(line)<=cols,`${width(line)} > ${cols}: ${line}`);
  assert.ok(out.endsWith('\x1b[?25h'));const [,row,col]=/\x1b\[(\d+);(\d+)H\x1b\[\?25h$/.exec(out);assert.ok(row<=rows&&col<=cols,`${row};${col}`);
 }
 press(s,'\t\t');assert.doesNotMatch(render(s,{cols:80,rows:24,repo:{mainRoot:'/m',linked:false}}),/\?25h$/);
});

test('the popup hands the task to the script with the description on stdin',()=>{
 assert.deepEqual(taskArgs({kind:'claude',branch:''}),['--notify','-']);
 assert.deepEqual(taskArgs({kind:'codex',branch:'feat/x'}),['--notify','--codex','-b','feat/x','-']);
});

test('the task runs in its own process group with its output in the log, so it outlives the popup',async()=>{
 const dir=tmp();try{
  const script=path.join(dir,'echo.mjs'),log=path.join(dir,'logs','a.log');
  fs.writeFileSync(script,"import fs from 'node:fs';console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input:fs.readFileSync(0,'utf8')}));console.error('done');");
  const child=startInBackground({script,args:['--notify','-'],cwd:dir,input:'多行\n描述',logFile:log});
  assert.doesNotThrow(()=>process.kill(-child.pid,0));
  assert.equal(await new Promise(r=>child.on('exit',r)),0);
  const [out,err]=fs.readFileSync(log,'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(out),{argv:['--notify','-'],cwd:dir,input:'多行\n描述'});assert.equal(err,'done');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('the popup keeps the newest 20 task logs',()=>{
 const dir=tmp();try{
  for(let i=0;i<25;i++){const f=path.join(dir,`task-${String(i).padStart(2,'0')}.log`);fs.writeFileSync(f,'');fs.utimesSync(f,1e6+i,1e6+i);}
  fs.writeFileSync(path.join(dir,'note.txt'),'');pruneLogs(dir,20);
  assert.deepEqual(fs.readdirSync(dir).sort(),['note.txt',...Array.from({length:20},(_,i)=>`task-${String(i+5).padStart(2,'0')}.log`)]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('the popup starts in the directory of the focused pane, or of the workspace',()=>{
 assert.equal(contextDir({HERDR_PLUGIN_CONTEXT_JSON:JSON.stringify({workspace_cwd:'/w',focused_pane_cwd:'/p'})}),'/p');
 assert.equal(contextDir({HERDR_PLUGIN_CONTEXT_JSON:JSON.stringify({workspace_cwd:'/w'})}),'/w');
 assert.equal(contextDir({HERDR_PLUGIN_CONTEXT_JSON:'not json'}),undefined);assert.equal(contextDir({}),undefined);
});

test('the action opens the form popup of this plugin',async()=>{
 const dir=tmp();try{
  const herdr=path.join(dir,'herdr'),log=path.join(dir,'herdr.log'),scenario=path.join(dir,'scenario.json');
  fs.writeFileSync(herdr,`#!/bin/sh\nexec '${process.execPath}' '${path.join(here,'testing','fake-herdr.mjs')}' "$@"\n`,{mode:0o755});
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_')));
  const open=()=>new Promise(resolve=>{const p=spawn(process.execPath,[path.join(here,'open.mjs')],{env:{...env,HERDR_BIN_PATH:herdr,FAKE_HERDR_LOG:log,FAKE_HERDR_SCENARIO:scenario}});let err='';p.stderr.on('data',d=>err+=d);p.on('close',code=>resolve({code,err}));});
  assert.equal((await open()).code,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(log,'utf8')).argv,['plugin','pane','open','--plugin',PLUGIN_ID,'--entrypoint','form']);
  fs.writeFileSync(scenario,JSON.stringify({'plugin pane':{error:{code:'ui_busy',message:'a popup pane is already open'}}}));
  const busy=await open();assert.equal(busy.code,1);assert.match(busy.err,/ui_busy/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// The subset of TOML the manifest uses: [[array]] tables and key = value lines whose values are JSON strings, arrays and numbers.
function manifestOf(text){
 const m={};let table=m;
 for(const line of text.split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'))){
  const t=/^\[\[(\w+)\]\]$/.exec(line);if(t){(m[t[1]]??=[]).push(table={});continue;}
  const [,k,v]=/^(\w+)\s*=\s*(.+)$/.exec(line);table[k]=JSON.parse(v);
 }
 return m;
}
test('the manifest declares the action, the popup and the commands that exist in the plugin',()=>{
 const m=manifestOf(fs.readFileSync(path.join(here,'herdr-plugin.toml'),'utf8'));
 assert.equal(m.id,PLUGIN_ID);assert.match(m.min_herdr_version,/^\d+\.\d+\.\d+$/);assert.deepEqual(m.platforms,['linux','macos']);
 const [action]=m.actions,[pane]=m.panes;
 assert.equal(action.id,'start');assert.deepEqual(action.command,['node','open.mjs']);
 assert.equal(pane.id,'form');assert.equal(pane.placement,'popup');assert.deepEqual(pane.command,['node','form.mjs']);
 for(const id of [action.id,pane.id])assert.match(id,/^[A-Za-z0-9:_-]+$/);
 for(const c of [action.command,pane.command])assert.ok(fs.existsSync(path.join(here,c[1])),c[1]);
});
