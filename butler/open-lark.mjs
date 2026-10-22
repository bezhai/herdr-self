// Client of open-lark's legacy Agent API (/agent/v1) with the read-only token. butler only reads: every request goes
// through readOnly(), so the one POST it may send is the @me history search, and never the pins route, whose GET marks
// pinned messages read in Lark.

// What butler calls, as GET /agent/v1 lists routes. open-lark makes no stability promise for this API, so startup
// checks they are all there.
export const REQUIRED_ROUTES=['GET /agent/v1/events','GET /agent/v1/me','GET /agent/v1/sync/status','GET /agent/v1/conversations',
 'GET /agent/v1/conversations/:feedId','GET /agent/v1/conversations/:feedId/messages','GET /agent/v1/messages/:messageId',
 'GET /agent/v1/messages/:messageId/thread','GET /agent/v1/threads/feed','POST /agent/v1/search/mention-history'];
const READ_POSTS=new Set(['/search/mention-history']);

// Throws unless method + path (relative to /agent/v1) is a read butler may make.
export function readOnly(method,path){
 if(/(^|\/)pins(\/|$|\?)/.test(path))throw Error(`butler 只读：不调用 ${path}（会清除飞书里置顶消息的未读标记）`);
 if(method==='GET'||(method==='POST'&&READ_POSTS.has(path)))return;
 throw Error(`butler 只读：拒绝 ${method} ${path}`);
}

export class OpenLarkError extends Error{
 constructor(status,code,message){super(`open-lark 返回 ${status}${code?`（${code}）`:''}：${message}`);this.status=status;this.code=code;}
}

// open-lark's own definition of a healthy link to Lark (skill reference platform.md).
export const isHealthy=s=>s?.state==='live'&&s?.mode==='frontier';

export class OpenLark{
 // gapMs: pause between requests. Reads of messages, threads and the @me history can make open-lark call Lark, and
 // requests are sent one at a time.
 constructor({url,token,gapMs=100,timeoutMs=30000,fetch=globalThis.fetch}){
  this.base=url.replace(/\/$/,'');this.token=token;this.gapMs=gapMs;this.timeoutMs=timeoutMs;this.fetch=fetch;this.queue=Promise.resolve();
 }
 get eventsUrl(){const u=new URL(`${this.base}/agent/v1/events`);u.protocol=u.protocol==='https:'?'wss:':'ws:';return u.toString();}
 #request(method,path,{query,body}={}){
  readOnly(method,path);
  const run=async()=>{
   const url=new URL(`${this.base}/agent/v1${path}`);
   for(const [k,v] of Object.entries(query??{}))if(v!==undefined&&v!==null)url.searchParams.set(k,String(v));
   let res;
   try{
    res=await this.fetch(url,{method,headers:{authorization:`Bearer ${this.token}`,...(body?{'content-type':'application/json'}:{})},
     body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(this.timeoutMs)});
   }catch(e){throw Error(`连不上 open-lark（${this.base}）：${e.name==='TimeoutError'?`${this.timeoutMs / 1000} 秒没有响应`:e.cause?.code??e.message}`);}
   const text=await res.text();let data;try{data=text?JSON.parse(text):undefined;}catch{data=undefined;}
   if(!res.ok){const e=data?.error;throw new OpenLarkError(res.status,typeof e==='object'?e.code:data?.code,(typeof e==='object'?e.message:data?.message)??text.slice(0,200));}
   return data;
  };
  const result=this.queue.then(run);
  this.queue=result.catch(()=>{}).then(()=>this.gapMs&&new Promise(r=>setTimeout(r,this.gapMs)));
  return result;
 }
 async routes(){return (await this.#request('GET',''))?.routes??[];}
 me(){return this.#request('GET','/me');}
 syncStatus(){return this.#request('GET','/sync/status');}
 conversations({scope,limit=100,cursor}){return this.#request('GET','/conversations',{query:{scope,limit,cursor}});}
 conversation(feedId){return this.#request('GET',`/conversations/${encodeURIComponent(feedId)}`);}
 // One of afterPosition, beforePosition, aroundPosition or tail.
 messages(feedId,{afterPosition,beforePosition,aroundPosition,tail,limit=100}){
  return this.#request('GET',`/conversations/${encodeURIComponent(feedId)}/messages`,{query:{afterPosition,beforePosition,aroundPosition,tail:tail?1:undefined,limit}});
 }
 async message(id){return (await this.#request('GET',`/messages/${encodeURIComponent(id)}`)).item;}
 thread(rootId,{beforePosition,limit=100}={}){return this.#request('GET',`/messages/${encodeURIComponent(rootId)}/thread`,{query:{beforePosition,limit}});}
 threadFeed({cursor,limit=50}={}){return this.#request('GET','/threads/feed',{query:{cursor,limit}});}
 // Unix seconds; a paged request must repeat the window it started with (the cursor does not encode it).
 mentionHistory({startTime,endTime,cursor,limit=50}){return this.#request('POST','/search/mention-history',{body:{startTime,endTime,limit,...(cursor?{cursor}:{})}});}
}
