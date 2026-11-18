import type {Methods,ClientApi,ServiceRequest,ServiceAnswer} from './link.ts';
// The local HTTP services that a machine's client offers its agents through Bridge (see ServiceCalls and bridge-call). The client config
// names each service and gives its root URL, the token that the client sends to it, the methods an agent may use and the request headers an
// agent may pass. An agent names only the service, method, path, query, body and those headers: this module builds the URL under the root and
// every other header, and the token never leaves the machine, nor appears in an error or an answer. It uses only Node's built-in modules, like
// the client.

// The name of a service: what the config names it, what the machine announces and what an agent calls.
export const serviceName=/^[a-z][a-z0-9-]{0,31}$/;
// A service of the config of a client (see readConfig): url, its root with no trailing /, on this machine; token; methods, those that an agent may
// use; headers, the lower-case names of the request headers that an agent may pass.
export type Service={url:string,token:string,methods:string[],headers:string[]};
// The most that an answer may hold, in bytes; a larger one is refused rather than cut.
export const readCap=20*1024*1024;
const httpMethods=['GET','HEAD','POST','PUT','PATCH','DELETE'];
// Headers that the client sets itself, so that an agent cannot pass them.
const reserved=['authorization','host','content-length','content-type','connection','transfer-encoding','upgrade'];
// The services of the config file, name to service, from the value of its services. The token goes only to the service on this machine, so its url
// can name no other host.
export function parseServices(file:string,value:unknown):Record<string,Service>{
 if(typeof value!=='object'||value===null||Array.isArray(value))throw Error(`配置文件 ${file} 的 services 必须是 {"<名字>": {"url": …, "token": …}}`);
 const out:Record<string,Service>={};
 for(const [name,o] of Object.entries(value)){
  if(!serviceName.test(name))throw Error(`配置文件 ${file} 的服务名「${name}」不合法，应匹配 [a-z][a-z0-9-]{0,31}`);
  const at=`配置文件 ${file} 的 services.${name}`;
  if(typeof o!=='object'||o===null||Array.isArray(o))throw Error(`${at} 必须是 {"url": …, "token": …}`);
  const {url,token,methods=['GET','HEAD'],headers=[]}=o as {url?:unknown,token?:unknown,methods?:unknown,headers?:unknown},u=typeof url==='string'?URL.parse(url):null;
  if(!u||!['http:','https:'].includes(u.protocol)||!['127.0.0.1','[::1]','localhost'].includes(u.hostname)||u.username||u.password||u.search||u.hash)
   throw Error(`${at}.url 必须是本机上服务的地址，http(s)，主机为 127.0.0.1、[::1] 或 localhost，不带查询参数和 #，例如 http://127.0.0.1:8081/v1`);
  if(typeof token!=='string'||!token)throw Error(`${at} 缺少 token`);
  if(!Array.isArray(methods)||methods.some(m=>typeof m!=='string'||!httpMethods.includes(m.toUpperCase())))throw Error(`${at}.methods 必须是 ${httpMethods.join('、')} 中的若干个`);
  if(!Array.isArray(headers)||headers.some(h=>typeof h!=='string'||!/^[a-z0-9-]+$/.test(h)||reserved.includes(h)))throw Error(`${at}.headers 必须是小写请求头名字的数组，不能含 authorization、host、content-type 等由客户端自己设置的头`);
  out[name]={url:u.origin+u.pathname.replace(/\/$/,''),token,methods:[...new Set((methods as string[]).map(m=>m.toUpperCase()))],headers:headers as string[]};
 }
 return out;
}
// An error whose code crosses the client link, with a message for the agent that carries no token.
const coded=(code:string,message:string)=>Object.assign(Error(message),{code});
const invalid=(message:string)=>coded('invalid_params',message);
// The characters that a path, a header value or a query may not have: controls, which include NUL and line breaks.
const controls=/[\u0000-\u001f\u007f]/;
// Whether a segment of a path is . or .. in any of its percent-encodings, even encoded again, or hides a / or \ the same way.
function dangerous(segment:string){
 let s=segment;
 for(let i=0;i<4;i++){
  if(s==='.'||s==='..'||/[\\/]/.test(s)||controls.test(s))return true;
  let d:string;try{d=decodeURIComponent(s);}catch{return true;}
  if(d===s)return false;s=d;
 }
 return true;
}
// The URL of path, relative to the root of service, with query; it throws invalid_params for anything that is not a path under that root: no
// leading /, a // at its start, a scheme, a backslash, a query or fragment in it, a . or .. segment (also percent-encoded), or a result that is
// not under the root's origin and path. It makes no request.
export function serviceUrl(service:Service,path:unknown,query:unknown):URL{
 if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//'))throw invalid('路径必须以 / 开头，不能以 // 开头');
 if(path.includes('\\')||/[?#]/.test(path)||controls.test(path))throw invalid('路径里不能有反斜杠、?、# 和控制字符，查询参数用 --url-query');
 if(path.includes('://')||/^\/[a-z][a-z0-9+.-]*:/i.test(path))throw invalid('路径里不能有 scheme');
 if(path.split('/').some(dangerous))throw invalid('路径里不能有 . 或 .. 段，也不能有它们的编码');
 if(query!==undefined&&(!Array.isArray(query)||query.length>100||query.some(p=>!Array.isArray(p)||p.length!==2||typeof p[0]!=='string'||typeof p[1]!=='string')))throw invalid('query 必须是最多 100 个 [名, 值] 的数组');
 const root=new URL(service.url);let url:URL;try{url=new URL(service.url+path);}catch{throw invalid('路径不合法');}
 if(url.origin!==root.origin||!url.pathname.startsWith(root.pathname.replace(/\/$/,'')+'/'))throw invalid('路径必须在服务的根路径之下');
 for(const [k,v] of (query??[]) as [string,string][])url.searchParams.append(k,v);
 return url;
}
// How long a request may take unless the call says: above the long polls of services (about 25 s), below what the control plane waits (see ServiceCalls).
const defaultMs=45000;
// Whether a body of this content type is text that the agent reads as it is.
const textual=(type:string)=>/^(text\/|application\/(json|xml|javascript|x-ndjson)\b)|\+(json|xml)\b/i.test(type);
// The bytes of a response, at most readCap; it throws response_too_large from its declared length or from what arrives, and stops reading then.
async function readBody(r:Response):Promise<Buffer>{
 const tooLarge=()=>coded('response_too_large','服务的回答超过 20 MB，不能通过 Bridge 取回');
 if(Number(r.headers.get('content-length'))>readCap){await r.body?.cancel().catch(()=>{});throw tooLarge();}
 const chunks:Uint8Array[]=[];let size=0;
 if(r.body)for await(const c of r.body){size+=c.length;if(size>readCap){await r.body.cancel().catch(()=>{});throw tooLarge();}chunks.push(c);}
 return Buffer.concat(chunks);
}
// The callService method for the services of a config. A request is checked in full before any request goes out.
export function serviceMethods(services:Record<string,Service>):Pick<Methods<ClientApi>,'callService'>{
 return {
  async callService(params){
   const {service:name,method:m,path,query,body,headers,timeoutMs=defaultMs}=params as ServiceRequest&{timeoutMs?:number};
   if(typeof name!=='string'||typeof m!=='string')throw invalid('service 和 method 必须是字符串');
   const service=Object.hasOwn(services,name)?services[name]:undefined;
   if(!service)throw coded('service_unknown',`这台机器的客户端没有服务「${name.slice(0,40)}」`);
   const method=m.toUpperCase();
   if(!httpMethods.includes(method))throw invalid('method 必须是 '+httpMethods.join('、')+' 之一');
   if(!service.methods.includes(method))throw coded('method_not_allowed',`服务「${name}」不允许 ${method} 请求，允许：${service.methods.join('、')}`);
   const url=serviceUrl(service,path,query);
   if(body!==undefined&&typeof body!=='string')throw invalid('body 必须是字符串');
   if(headers!==undefined&&(typeof headers!=='object'||headers===null||Array.isArray(headers)))throw invalid('headers 必须是 {名: 值}');
   const passed:Record<string,string>={};
   for(const [h,v] of Object.entries(headers??{})){
    if(!service.headers.includes(h))throw coded('header_not_allowed',`服务「${name}」不允许传请求头 ${h.slice(0,60)}，允许：${service.headers.join('、')||'无'}`);
    if(typeof v!=='string'||controls.test(v))throw invalid(`请求头 ${h} 的值必须是不含换行的字符串`);passed[h]=v;
   }
   if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw invalid('timeoutMs');
   const sends=['POST','PUT','PATCH'].includes(method),signal=AbortSignal.timeout(timeoutMs);
   try{
    // A redirect is an answer, not followed: the token goes to the configured origin only.
    const r=await fetch(url,{method,redirect:'manual',signal,headers:{...passed,authorization:`Bearer ${service.token}`,...sends&&{'content-type':'application/json'}},...sends&&{body:body??'{}'}});
    const bytes=await readBody(r),contentType=r.headers.get('content-type')??'';
    if(textual(contentType))try{return {status:r.status,contentType,encoding:'text',body:new TextDecoder('utf-8',{fatal:true}).decode(bytes)} satisfies ServiceAnswer;}catch{}
    return {status:r.status,contentType,encoding:'base64',body:bytes.toString('base64')};
   }catch(e){
    if(e?.code==='response_too_large')throw e;
    throw coded('service_unreachable',`服务「${name}」没有响应`);
   }
  },
 };
}
