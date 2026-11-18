// Tests of service-calls.ts (see package.json); run with node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceCalls} from './service-calls.ts';
import type {Machine} from './state.ts';
import type {Call} from './core.ts';
import type {ServiceAnswer} from './link.ts';

const machine=(name:string)=>({id:name,name,session:'default',enabled:true}) as Machine,cpu1=machine('cpu1'),cpu2=machine('cpu2');
const answer:ServiceAnswer={status:200,contentType:'application/json',encoding:'text',body:'{}'};
const request={service:'notes',method:'GET',path:'/a'};
type Logged=[string,string,string|undefined];
// ServiceCalls over the given offers, with a call that records what it is asked and answers with answer or throws error.
function fixture(offers:{machine:Machine,services:string[]}[],error?:object){
 const calls:unknown[][]=[],logs:Logged[]=[];
 const call=(async(...a:unknown[])=>{calls.push(a);if(error)throw Object.assign(Error('raw'),error);return answer;}) as unknown as Call;
 return {calls,logs,services:new ServiceCalls({offers:()=>offers,call,log:(kind,message,level)=>{logs.push([kind,message,level]);}})};
}

test('a call goes to the one machine that offers the service, with a timeout that fits a long poll, and resolves to its answer',async()=>{
 const f=fixture([{machine:cpu1,services:['wiki']},{machine:cpu2,services:['notes','wiki2']}]);
 assert.deepEqual(await f.services.call(cpu1,'call',request),answer);
 assert.deepEqual(f.calls,[[cpu2,'callService',request,{timeoutMs:50000}]]);
});

test('list answers the sorted names of the services that machines offer, each once',async()=>{
 const f=fixture([{machine:cpu1,services:['wiki','notes']},{machine:cpu2,services:['notes']}]);
 assert.deepEqual(await f.services.call(cpu1,'list',{}),{services:['notes','wiki']});
 assert.deepEqual(await fixture([]).services.call(cpu1,'list',{}),{services:[]});
});

test('a call to a name that no machine offers says which names there are; one that two machines offer is refused, and logged',async()=>{
 const f=fixture([{machine:cpu1,services:['notes']},{machine:cpu2,services:['notes','wiki']}]);
 await assert.rejects(f.services.call(cpu1,'call',{...request,service:'none'}),{message:'没有机器提供服务「none」；现有的服务：notes、wiki'});
 await assert.rejects(f.services.call(cpu1,'call',request),{message:'服务「notes」同时由 cpu1、cpu2 提供，配置有误，暂时不能调用：请主人让一台机器去掉它'});
 assert.deepEqual(await f.services.call(cpu1,'call',{...request,service:'wiki'}),answer);
 assert.deepEqual(f.logs,[['服务','服务「notes」同时由 cpu1、cpu2 提供，配置有误，暂时不能调用','error']]);
 await assert.rejects(fixture([]).services.call(cpu1,'call',{...request,service:'x'}),{message:'没有机器提供服务「x」；现在没有任何服务'});
 assert.equal(f.calls.length,1);
});

test('a bad request or operation is refused without any call',async()=>{
 const f=fixture([{machine:cpu2,services:['notes']}]);
 for(const r of [null,[],{},{service:3},{service:''}])await assert.rejects(f.services.call(cpu1,'call',r),{message:'请求内容无效：缺少 service'});
 await assert.rejects(f.services.call(cpu1,'drop',request),{message:'未知的操作：drop'});
 assert.equal(f.calls.length,0);
});

test('a failure of the offering machine becomes one clear line, and a message of its client that carries no secret passes',async()=>{
 const fails=(e:object)=>fixture([{machine:cpu2,services:['notes']}],e).services.call(cpu1,'call',request);
 await assert.rejects(fails({code:'client_offline'}),{message:'cpu2 的 Bridge 客户端不在线'});
 await assert.rejects(fails({code:'unknown_method'}),{message:'cpu2 的 Bridge 客户端不支持调用服务，需要升级'});
 await assert.rejects(fails({code:'service_unreachable'}),{message:'服务「notes」没有响应：请主人检查 cpu2 上的服务'});
 await assert.rejects(fails({timedOut:true}),{message:'服务「notes」没有响应：请主人检查 cpu2 上的服务'});
 await assert.rejects(fails({code:'service_unknown',message:'cpu2 的客户端没有服务「notes」'}),{message:'cpu2 的客户端没有服务「notes」'});
 await assert.rejects(fails({code:'method_not_allowed',message:'服务「notes」不允许 DELETE 请求，允许：GET、HEAD'}),{message:'服务「notes」不允许 DELETE 请求，允许：GET、HEAD'});
 await assert.rejects(fails({code:'response_too_large',message:'回答超过 20 MB'}),{message:'回答超过 20 MB'});
});
