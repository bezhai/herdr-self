import {isRecord} from './core.ts';
import type {Call} from './core.ts';
import type {Machine} from './state.ts';
import type {ServiceRequest,ServiceAnswer} from './link.ts';
// What bridge-call asks of the control plane, by operation: call makes a request of a service of a machine, list names the services there are.
export type ServiceOps={call:{request:ServiceRequest,answer:ServiceAnswer},list:{request:{},answer:{services:string[]}}};
// The machines whose client is in, enabled, with the names of the services that each announced in its hello.
type Offers=()=>{machine:Machine,services:string[]}[];
// How long the control plane lets the offering client take for one request: above the client's own limit (see services.ts), below what bridge-call waits.
const forwardMs=50000;
const ops=['call','list'];
// The reason a call failed, as the one line that bridge-call prints. A message of the client's own is for the agent and carries no token.
function reason(m:Machine,service:string,e:any){
 if(e?.code==='client_offline')return `${m.name} 的 Bridge 客户端不在线`;
 if(e?.code==='unknown_method')return `${m.name} 的 Bridge 客户端不支持调用服务，需要升级`;
 if(e?.code==='service_unreachable'||e?.timedOut)return `服务「${service}」没有响应：请主人检查 ${m.name} 上的服务`;
 return String(e?.message||'未知错误').split('\n')[0].slice(0,300);
}
// The control plane's side of bridge-call: it routes a request to the connected, enabled machine that offers the service named in it, passes it on
// to that machine's client without looking into it, and resolves to the answer. A name that two machines offer is a config error: it is logged
// and its calls are refused until one machine drops it. Which machine asks does not matter: any agent may call a service, and what a service
// allows is bounded by the config of the machine that offers it.
export class ServiceCalls{
 declare deps:{offers:Offers,call:Call,log:(kind:string,message:string,level?:'info'|'error')=>void};
 // offers is read at each call; call reaches a machine's client (see Clients.call); log writes to the console's log.
 constructor(deps:ServiceCalls['deps']){this.deps=deps;}
 async call(_from:Machine,op:string,request:unknown):Promise<ServiceOps['call']['answer']|ServiceOps['list']['answer']>{
  if(!ops.includes(op))throw Error('未知的操作：'+op);
  const offers=this.deps.offers();
  if(op==='list')return {services:[...new Set(offers.flatMap(o=>o.services))].sort()};
  if(!isRecord(request)||typeof request.service!=='string'||!request.service)throw Error('请求内容无效：缺少 service');
  const service=request.service,by=offers.filter(o=>o.services.includes(service)).map(o=>o.machine);
  if(!by.length){const names=[...new Set(offers.flatMap(o=>o.services))].sort();throw Error(`没有机器提供服务「${service.slice(0,40)}」；${names.length?'现有的服务：'+names.join('、'):'现在没有任何服务'}`);}
  if(by.length>1){
   const message=`服务「${service}」同时由 ${by.map(m=>m.name).join('、')} 提供，配置有误，暂时不能调用`;
   this.deps.log('服务',message,'error');throw Error(message+'：请主人让一台机器去掉它');
  }
  try{return await this.deps.call(by[0],'callService',request as ServiceRequest,{timeoutMs:forwardMs});}catch(e){throw Error(reason(by[0],service,e));}
 }
}
