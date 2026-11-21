// Client of Bridge's control plane, with its access key: the lists a new group's judgment chooses from (GET /api/state) and
// the one call that starts the work (POST /api/topics/open, see bridge/README.md). butler asks Bridge for nothing else.

// The error code with which Bridge refuses to open a topic because its bot cannot post in the chat yet: the bot was just
// added to the group, and Feishu takes a moment to let it speak. Every other refusal (invalid input, unknown project or agent
// config) is final.
export const BOT_CANNOT_POST='bot_cannot_post';

export class BridgeError extends Error{
 constructor(status,code,message){super(`Bridge 返回 ${status}${code?`（${code}）`:''}：${message}`);this.status=status;this.code=code;}
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export class Bridge{
 // retryMs: how long to wait before asking again when the bot cannot post yet, retryForMs: how long to keep asking.
 constructor({url,key,timeoutMs=30000,retryMs=3000,retryForMs=60_000,fetch=globalThis.fetch}){
  Object.assign(this,{base:url.replace(/\/$/,''),key,timeoutMs,retryMs,retryForMs,fetch});
 }
 async #request(method,path,body){
  let res;
  try{
   res=await this.fetch(`${this.base}${path}`,{method,headers:{authorization:`Bearer ${this.key}`,...(body?{'content-type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(this.timeoutMs)});
  }catch(e){throw Error(`连不上 Bridge（${this.base}）：${e.name==='TimeoutError'?`${this.timeoutMs/1000} 秒没有响应`:e.cause?.code??e.message}`);}
  const text=await res.text();let data;try{data=text?JSON.parse(text):undefined;}catch{data=undefined;}
  if(!res.ok){
   const e=data?.error,message=typeof e==='string'?e:e?.message??data?.message??text.slice(0,200);
   throw new BridgeError(res.status,data?.code??(typeof e==='object'?e?.code:undefined),message);
  }
  return data;
 }
 // Bridge's state as the console reads it: projects, agentConfigs, machines, bindings, apps.
 state(){return this.#request('GET','/api/state');}
 // Opens a topic in a chat with a first prompt (fields: chatId, prompt, title, rootText, projectId, agentConfigId, appId, key; see
 // bridge/README.md); resolves with {topicId, bindingId, rootMessageId, created}. While the bot cannot post in the chat
 // yet it asks again every retryMs, for retryForMs; the idempotency key makes asking again safe.
 async openTopic(input){
  const until=Date.now()+this.retryForMs;
  for(;;){
   try{return await this.#request('POST','/api/topics/open',input);}
   catch(e){if(e.code!==BOT_CANNOT_POST||Date.now()+this.retryMs>until)throw e;}
   await sleep(this.retryMs);
  }
 }
}
