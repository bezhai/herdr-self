// The model that Bridge asks for the small things it decides itself (the branch of a topic, the project of a task or of a group, the
// description of a project), the same for every machine: one chat completion call by the control plane to an OpenAI-compatible service.
// Text in, text out; no tools, no state.
export type AskModel=(prompt:string)=>Promise<string>;
const settings={BRIDGE_MODEL_BASE_URL:'baseUrl',BRIDGE_MODEL_API_KEY:'apiKey',BRIDGE_MODEL_NAME:'name'} as const;
// The model service that env configures (BRIDGE_MODEL_BASE_URL is the address up to /chat/completions, for example http://127.0.0.1:18080/v1),
// which gives up on a call after timeoutMs. The returned function resolves to the text of the first choice, trimmed, and rejects when
// the service is not configured, cannot be reached, refuses, is too slow or says nothing; the callers then do without. Whatever it
// rejects with is free of the key, which the service might repeat in a refusal.
// BRIDGE_MODEL_REASONING_EFFORT is the reasoning_effort sent along, minimal when unset: these answers are one line, and a model that thinks
// first takes 10 to 20 seconds for it (seed-evolving-auto on 2026-11-09: about 2 seconds with minimal, 11 with low). Set empty, nothing
// is sent, for a model that rejects the parameter.
export function modelFrom(env:NodeJS.ProcessEnv,{timeoutMs=20000}:{timeoutMs?:number}={}):AskModel{
 const [baseUrl,apiKey,name]=Object.keys(settings).map(k=>env[k]?.trim()),missing=Object.keys(settings).filter(k=>!env[k]?.trim());
 const effort=(env.BRIDGE_MODEL_REASONING_EFFORT??'minimal').trim();
 const hide=(s:string)=>apiKey?s.replaceAll(apiKey,'[已隐藏]'):s;
 return async prompt=>{
  if(missing.length)throw Error(`没有配置模型服务（缺 ${missing.join('、')}）`);
  let text:string|undefined;
  try{
   const res=await fetch(`${baseUrl!.replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},body:JSON.stringify({model:name,...effort&&{reasoning_effort:effort},messages:[{role:'user',content:prompt}]}),signal:AbortSignal.timeout(timeoutMs)});
   const body=await res.text();
   if(!res.ok)throw Error(`模型服务返回 HTTP ${res.status}：${body.trim().slice(0,300)}`);
   try{text=JSON.parse(body).choices?.[0]?.message?.content;}catch{}
  }catch(e){
   if(e.name==='TimeoutError')throw Error(`模型服务 ${timeoutMs/1000} 秒内没有返回`);
   throw Error(hide(e.message==='fetch failed'?`无法连接模型服务：${e.cause?.code??e.cause?.message??e.message}`:e.message));
  }
  if(typeof text!=='string'||!text.trim())throw Error('模型服务没有返回可用的文字');
  return text.trim();
 };
}
