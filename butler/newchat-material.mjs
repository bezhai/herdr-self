// What the model is shown of a group butler has not seen before, when it judges whether it is a requirement group (see
// newchat.mjs): everything that can be read about the group, gathered here and never weighed. open-lark gives the group's
// entry, settings (labels, who owns it, the announcement), chat tabs, bots with when they joined, and its first messages;
// the Meego work items behind any Meego link in those are read with bytedcli, read-only. What cannot be read is left out
// and named in `unavailable`, or, for a Meego link, shown with its error: a judgment is better made on what there is than
// not made, except without a work item (newchat.mjs then waits for the next round). Links carry login tokens in their
// query (Meego's wiki links do), and the model must never see or copy one, so every text is scrubbed.
import {execFile} from 'node:child_process';

// How many of the first messages are read, how long each text may be, and how many Meego work items are read at most.
export const FIRST_MESSAGES=20,MESSAGE_CHARS=500,MAX_WORK_ITEMS=3;
const stamp=ms=>new Date(ms).toLocaleString('sv-SE').slice(0,16);

// A query parameter that names a token (disposable_login_token, access_token, …) goes from the links in a text, the rest of
// the link stays.
export const scrub=text=>typeof text==='string'?text.replace(/([?&])[\w-]*token[\w-]*=[^&\s"')]*(&?)/gi,(m,sep,amp)=>amp?sep:''):text;
const scrubAll=v=>JSON.parse(JSON.stringify(v),(k,x)=>typeof x==='string'?scrub(x):x);
const cut=(s,n)=>[...String(s??'')].length>n?`${[...String(s)].slice(0,n).join('')}…`:String(s??'');

// The Meego work item links in these texts, each work item once, in the order they appear (the same item is linked with
// different hosts and queries). A work item link is a Meego host's address with /detail/<number> in its path.
const LINK=/https?:\/\/meego\.[^\s/]+\/[^\s，。）)>"']*?\/detail\/\d+[^\s，。）)>"']*/g;
export function meegoLinks(texts){
 const seen=new Set(),out=[];
 for(const text of texts)for(const link of String(text??'').match(LINK)??[]){
  const key=/\/[^/]*\/detail\/\d+/.exec(new URL(link).pathname)?.[0]??link;
  if(!seen.has(key)){seen.add(key);out.push(link);}
 }
 return out;
}

// A work item as the model reads it: people are their names, without email addresses and ids.
function slim(v){
 if(Array.isArray(v))return v.map(slim);
 if(v&&typeof v==='object'){
  if(typeof v.email==='string')return v.name??'';
  return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,slim(x)]));
 }
 return v;
}

// The reader of a Meego work item by its link: bytedcli, whose answer wraps the tool's text, which is the work item as JSON.
// A failure never carries the command line (the link may hold a token).
export function bytedcliMeego(command='bytedcli',{timeoutMs=60_000}={}){
 return url=>new Promise((resolve,reject)=>execFile(command,['meego','workitem','get','--url',url,'--json'],{timeout:timeoutMs,maxBuffer:16<<20,encoding:'utf8'},(error,stdout,stderr)=>{
  if(error){
   const tail=String(stderr||'').trim().split('\n').slice(-2).join(' ').slice(0,200);
   return reject(Error(`${command} meego workitem get 失败（${error.killed?'超时':error.code??error.signal??'无法运行'}）${tail?`：${scrub(tail)}`:''}`));
  }
  try{
   const answer=JSON.parse(stdout);
   if(answer.status!=='success')throw Error(answer.error?.message??answer.status);
   resolve(JSON.parse(answer.data.result.content[0].text));
  }catch(e){reject(Error(`${command} meego workitem get 的输出看不懂：${scrub(String(e.message)).slice(0,200)}`));}
 }));
}

// The material of a group (feedId, open-lark's id for it). lark: the read-only client; meego(url) → the work item (see
// bytedcliMeego). Rejects only when the group itself cannot be read.
export async function gatherMaterial({lark,feedId,meego,messages=FIRST_MESSAGES,maxWorkItems=MAX_WORK_ITEMS}){
 const conversation=await lark.conversation(feedId),unavailable=[];
 const soft=async(what,read)=>{try{return await read();}catch{unavailable.push(what);return undefined;}};
 const settings=await soft('settings',()=>lark.settings(feedId)),tabs=await soft('chatTabs',()=>lark.chatTabs(feedId));
 const bots=await soft('bots',()=>lark.bots(feedId)),page=await soft('messages',()=>lark.messages(feedId,{afterPosition:0,limit:messages}));
 const first=(page?.items??[]).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)).slice(0,messages);
 const material={feedId,name:conversation.name,openChatId:conversation.openChatId,description:conversation.description??settings?.description??'',
  memberCount:conversation.memberCount,labels:settings?.labels??[],isOwner:settings?.isOwner,isAdmin:settings?.isAdmin,
  announcement:settings?.announcementDoc?.docUrl,
  firstMessageAt:first.length?stamp(Date.parse(first[0].createdAt)):undefined,
  tabs:(tabs?.tabs??[]).map(x=>({name:x.name,kind:x.kind,url:x.url})),
  bots:(bots?.items??[]).map(b=>({name:b.displayName,joinedAt:b.joinedAtMs?stamp(b.joinedAtMs):undefined})),
  messages:first.map(m=>({time:stamp(Date.parse(m.createdAt)),sender:m.senderName,senderType:m.senderType,...m.isSystem&&{system:true},text:cut(m.textPreview,MESSAGE_CHARS)})),
  unavailable};
 const links=meegoLinks([material.description,...material.tabs.map(x=>x.url),...material.messages.map(m=>m.text)]).slice(0,maxWorkItems);
 material.meego=[];
 for(const url of links){
  try{material.meego.push({url,workItem:slim(await meego(url))});}
  catch(e){material.meego.push({url,error:String(e?.message??e)});}
 }
 return scrubAll(material);
}

// The material in a few lines for a person: what was read, not the texts.
export function describeMaterial(m){
 const work=m.meego.map(x=>x.error?`  ${x.url}：读不出（${x.error}）`:`  ${x.workItem?.work_item_attribute?.work_item_name??x.url}（${x.workItem?.work_item_attribute?.work_item_status?.name??'状态未知'}）`);
 return [`群：${m.name}（${m.memberCount} 人，${m.openChatId??'没有 openChatId'}）`,`描述：${m.description||'（没有）'}`,
  `标签：${m.labels.join('、')||'（没有）'}　第一条消息：${m.firstMessageAt??'（读不出）'}`,
  `聊天标签页 ${m.tabs.length} 个，机器人 ${m.bots.length} 个（${m.bots.map(b=>b.name).join('、')}），读到最早的 ${m.messages.length} 条消息`,
  `Meego 工作项 ${m.meego.length} 个${work.length?`：\n${work.join('\n')}`:''}`,...m.unavailable.length?[`没读到：${m.unavailable.join('、')}`]:[]].join('\n');
}
