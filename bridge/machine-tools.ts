import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {Ran} from './link.ts';
// What the methods of a client (see machine.ts, workspace.ts and launch.ts) share: the checks of their params and the running of a
// program. Node's built-in modules only, like the client.

export const invalid=(what:string)=>Object.assign(Error('参数无效：'+what),{code:'invalid_params'});
export const refused=(what:string)=>Object.assign(Error(what),{code:'refused'});
export const string=(v:unknown,what:string)=>{if(typeof v!=='string'||!v)throw invalid(what);return v;};
// A path of this machine as the control plane names it: absolute, or under the home directory with ~/.
export function local(v:unknown,what:string){
 const p=string(v,what);if(p.startsWith('~/'))return os.homedir()+p.slice(1);
 if(!path.isAbsolute(p))throw invalid(`${what} 必须是绝对路径或 ~/ 开头：${p}`);return p;
}
// A relative path below a directory, which never leaves it.
export function inside(v:unknown,what:string){const p=string(v,what);if(path.isAbsolute(p)||p.split('/').some(s=>!s||s==='.'||s==='..'))throw invalid(`${what}：${p}`);return p;}
export const name=(v:unknown,what:string)=>{const s=inside(v,what);if(s.includes('/'))throw invalid(`${what}：${s}`);return s;};
// Runs program with args and resolves to {code, stdout, stderr} whatever its exit status; stderr keeps its last 2000 characters. Rejects when
// it cannot start, prints too much, or does not finish within timeoutMs: it then gets SIGKILL with every process it started, which share its
// process group, and the error has the code timed_out. input, when given, is its stdin, which is closed otherwise.
export function run(program:string,args:string[],{env,cwd,input,timeoutMs=12000}:{env:NodeJS.ProcessEnv,cwd?:string,input?:string,timeoutMs?:number}){
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
// Runs the git program in directory cwd with env: it never prompts for credentials, and it speaks English, whose messages the control plane recognizes.
export const gitRunner=(env:NodeJS.ProcessEnv)=>(cwd:string,args:string[],timeoutMs?:number)=>run('git',['-C',cwd,...args],{env:{...env,GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'},timeoutMs});
export type Git=ReturnType<typeof gitRunner>;
