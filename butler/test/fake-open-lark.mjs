// A stand-in for open-lark's legacy Agent API (/agent/v1) that follows the shapes and quirks of the real one
// (open-lark src/server/routes/api.ts, message-window.ts, messenger-repository.ts):
// - the read-only token reaches GET routes and a few read POSTs; anything else is 403;
// - message pages plan their window like planMessageWindow (5 positions of redundancy), thread replies of a normal
//   group have position <= 0 and are mixed into pages by time, replies of a topic group have main positions;
// - /events is a WebSocket without cursor or replay; message.upserted may come without `message`, twice, as the
//   `sync:complete` sentinel, and a thread root is sent again when its reply count changes;
// - open-lark can write messages without any event (the tests choose per message).
// Every request is logged in `requests` so tests can assert that butler only reads.
import http from 'node:http';
import crypto from 'node:crypto';

export const ME = '6900000000000000001';
const BASE = '/agent/v1';

// Route catalog as GET /agent/v1 returns it: what butler needs plus some write routes it must never call.
export const CATALOG = [
 'GET /agent/v1','GET /agent/v1/events','GET /agent/v1/me','GET /agent/v1/sync/status','GET /agent/v1/conversations','POST /agent/v1/conversations',
 'GET /agent/v1/conversations/:feedId','GET /agent/v1/conversations/:feedId/messages','POST /agent/v1/conversations/:feedId/messages',
 'GET /agent/v1/conversations/:feedId/pins','GET /agent/v1/conversations/:feedId/threads','GET /agent/v1/messages/:messageId',
 'PATCH /agent/v1/messages/:messageId','DELETE /agent/v1/messages/:messageId','GET /agent/v1/messages/:messageId/thread',
 'POST /agent/v1/messages/:messageId/replies','GET /agent/v1/threads/feed','POST /agent/v1/search/mention-history',
].map(r=>{const [method,path]=r.split(' ');return {method,path};});
const READ_POSTS=new Set(['/agent/v1/search/mention-history']);

const iso=ms=>new Date(ms).toISOString();
const clone=v=>structuredClone(v);
const clamp=(v,lo,hi)=>Math.min(Math.max(v,lo),hi);

// open-lark src/server/messages/message-window.ts planMessageWindow, for the scenes butler uses.
export function planMessageWindow({anchorPosition,count,firstPosition=-1,lastPosition,readPosition,scene}){
 const minimum=firstPosition+1,maximum=lastPosition;if(lastPosition<=firstPosition)return undefined;
 count=clamp(Math.trunc(count),1,100);const redundancy=5,anchor=Number(anchorPosition??0);let located,start,end;
 if(scene==='first-screen'){
  const hasUnread=readPosition!=null&&readPosition>=firstPosition&&readPosition<maximum;located=hasUnread?readPosition+1:maximum;
  if(hasUnread){start=located-redundancy;end=located+count+redundancy-1;}else{start=maximum-count-redundancy+1;end=maximum;}
 }else if(scene==='specified-position'){
  located=clamp(anchorPosition==null?maximum:anchor,minimum,maximum);const older=Math.floor(count/2)+redundancy;
  start=located-older;end=located+(count-Math.floor(count/2)-1)+redundancy;
 }else if(scene==='previous-page'){
  const cursor=anchorPosition==null?maximum+1:anchor;if(cursor<=minimum)return undefined;located=Math.min(cursor-1,maximum);end=located;start=end-count-redundancy+1;
 }else{
  const cursor=anchorPosition==null?firstPosition:anchor;if(cursor>=maximum)return undefined;located=Math.max(cursor+1,minimum);start=located;end=start+count+redundancy-1;
 }
 start=clamp(start,minimum,maximum);end=clamp(end,minimum,maximum);if(start>end)return undefined;return {start,end};
}

function frame(opcode,payload){
 const len=payload.length,head=len<126?Buffer.from([0x80|opcode,len]):len<65536?Buffer.alloc(4):Buffer.alloc(10);
 if(len>=126&&len<65536){head[0]=0x80|opcode;head[1]=126;head.writeUInt16BE(len,2);}
 else if(len>=65536){head[0]=0x80|opcode;head[1]=127;head.writeBigUInt64BE(BigInt(len),2);}
 return Buffer.concat([head,payload]);
}

export class FakeOpenLark{
 constructor({token='read-token',fullToken='full-token'}={}){
  this.token=token;this.fullToken=fullToken;this.me=ME;this.routes=clone(CATALOG);
  this.requests=[];this.sockets=new Set();this.down=false;this.failures=[];this.gaps=new Set();
  this.conversations=new Map();this.messages=new Map();this.byFeed=new Map();this.threadCards=new Map();
  this.syncState={state:'live',mode:'frontier'};this.searchFails=false;this.notStored=new Set();
  this.clock=Date.now();this.seq=0;
  this.server=http.createServer((req,res)=>this.#handle(req,res).catch(e=>{res.writeHead(500);res.end(JSON.stringify({statusCode:500,error:'Internal Server Error',message:String(e.message)}));}));
  this.server.on('upgrade',(req,socket)=>this.#upgrade(req,socket));
 }
 async listen(){await new Promise(r=>this.server.listen(0,'127.0.0.1',r));this.url=`http://127.0.0.1:${this.server.address().port}`;return this;}
 async close(){for(const s of this.sockets)s.destroy();for(const h of this.held??[])h.socket.destroy();this.server.closeAllConnections();await new Promise(r=>this.server.close(r));}
 // Time moves forward by at least 1 ms per message so ordering by time is total, like the real createTime.
 now(){this.clock=Math.max(Date.now(),this.clock+1);return this.clock;}
 #id(){return String(7100000000000000000n+BigInt(++this.seq));}

 chat({name,chatMode='group',memberCount=chatMode==='direct'?2:10,pinned=false,isMuted=false,feedId}){
  const id=feedId??String(6800000000000000000n+BigInt(++this.seq)),t=this.now();
  this.conversations.set(id,{feedId:id,name,chatMode,isGroup:chatMode!=='direct',memberCount,isMuted,feedType:1,rankTimeMs:t,onTopRankTimeMs:pinned?t+1e12:0,updatedAtMs:t,previewMessageId:undefined,lastPosition:0});
  // Like a real chat, it starts with a system message at position 0, long before anything else.
  const origin=this.#id();
  this.messages.set(origin,{id:origin,feedId:id,position:'0',createdAt:iso(t-365*86400e3),senderId:'0',senderName:'',senderType:'user',isMine:false,isEdited:false,isRecalled:false,
   isSystem:true,localState:'synced',messageType:1,chatType:chatMode==='direct'?1:2,parts:[],textPreview:'',reactions:[],editHistory:[],threadId:origin,threadMessageType:'none',threadReplyCount:0});
  this.byFeed.set(id,[origin]);return id;
 }
 conversationView(c){
  const preview=this.messages.get(c.previewMessageId);
  return {feedId:c.feedId,name:c.name,chatMode:c.chatMode,isGroup:c.isGroup,isMuted:c.isMuted,memberCount:c.memberCount,feedType:c.feedType,
   preview:{digest:{chatterIds:[],elements:[]},displayAt:iso(c.rankTimeMs),isMine:preview?.isMine,messageId:c.previewMessageId,reactions:[]},
   rankAt:iso(c.rankTimeMs),...(c.onTopRankTimeMs?{onTopRankAt:iso(c.onTopRankTimeMs)}:{}),updatedAtMs:c.updatedAtMs,unreadCount:0};
 }
 // Posts a message as open-lark would store it. event: 'full' (message.upserted with the message), 'bare' (without it),
 // 'none' (written to the database only, as gap repair or backfill do) or 'root-only' (a background thread sync: only
 // the root is sent again). touch: whether the conversation entry moves (rank, preview, update time). stored: false
 // when open-lark has not stored it yet (GET /messages/:id is 404, while a page around it fetches it from Lark).
 post(feedId,{text='',sender='6900000000000000099',senderName='同事',senderType='user',mine=false,atMe=false,atAll=false,isAtMe,replyTo,thread,at}={},{event='full',touch=true,stored=true}={}){
  const c=this.conversations.get(feedId),t=at??this.now(),id=this.#id();
  if(mine){sender=this.me;senderName='我';}
  let position,threadMessageType='none',threadId=id,parentId,threadPosition,root;
  if(thread){
   root=this.messages.get(thread);if(root.threadMessageType==='none'){root.threadMessageType='root';root.threadPosition='-1';}
   threadMessageType='reply';threadId=root.id;parentId=replyTo??root.id;root.threadReplyCount+=1;root.replyCount=(root.replyCount??0)+1;
   threadPosition=String(root.threadReplyCount);position=c.chatMode==='topic'?String(++c.lastPosition):'-1';
  }else{position=String(++c.lastPosition);if(replyTo){parentId=replyTo;threadId=this.messages.get(replyTo).threadId;}}
  const parent=parentId&&this.messages.get(parentId);
  const parts=[...(atAll?[{kind:'at',refId:'all',text:'@所有人'}]:[]),...(atMe?[{kind:'at',refId:this.me,text:'@我'}]:[]),...(text?[{kind:'text',text}]:[])];
  const view={id,feedId,position,createdAt:iso(t),senderId:sender,senderName,senderType,isMine:mine,isEdited:false,isRecalled:false,isSystem:false,localState:'synced',
   messageType:4,chatType:c.chatMode==='direct'?1:2,parts,textPreview:parts.map(p=>p.text).join(''),reactions:[],editHistory:[],threadId,threadMessageType,threadReplyCount:0,
   ...(threadPosition?{threadPosition}:{}),...(parentId?{parentId}:{}),
   ...(parent?{replyTo:{id:parent.id,senderId:parent.senderId,senderName:parent.senderName,parts:clone(parent.parts),textPreview:parent.textPreview,isRecalled:parent.isRecalled}}:{}),
   ...((isAtMe??atMe)?{isAtMe:true}:{}),...(atAll?{isAtAll:true}:{})};
  this.messages.set(id,view);this.byFeed.get(feedId).push(id);if(!stored)this.notStored.add(id);
  if(root&&(root.isMine||mine||this.threadCards.has(root.id)))this.threadCards.set(root.id,t);
  if(touch){c.rankTimeMs=Math.max(c.rankTimeMs,t);c.updatedAtMs=this.now();c.previewMessageId=id;}
  if(event==='full'||event==='bare')this.emit({type:'message.upserted',feedId,messageId:id,...(event==='full'?{message:clone(view)}:{})});
  if(root&&event!=='none')this.emit({type:'message.upserted',feedId,messageId:root.id,message:clone(root)});
  return clone(view);
 }
 edit(id,text,{event=true}={}){
  const v=this.messages.get(id);v.parts=[...v.parts.filter(p=>p.kind==='at'),{kind:'text',text}];v.textPreview=v.parts.map(p=>p.text).join('');v.isEdited=true;
  if(event)this.emit({type:'message.upserted',feedId:v.feedId,messageId:id,message:clone(v)});
 }
 recall(id,{event=true}={}){
  const v=this.messages.get(id);v.isRecalled=true;v.parts=[];v.textPreview='';
  if(event)this.emit({type:'message.recalled',feedId:v.feedId,messageId:id});
 }
 // open-lark's stored last position of a chat, which bounds every message page, stays at `position` until thawed. Its
 // feed refresh writes 0 for topic groups (Lark's chat entity has no last_message_position for them), and only later
 // pushes restore it.
 freezeWindow(feedId,position=0){this.conversations.get(feedId).frozenLastPosition=position;}
 thawWindow(feedId){delete this.conversations.get(feedId).frozenLastPosition;}
 setSync(state,mode,{event=true}={}){this.syncState={state,mode};if(event)this.emit({type:'sync.upstream',state,mode,since:iso(Date.now())});}
 emit(event){const data=frame(0x1,Buffer.from(JSON.stringify(event)));for(const s of this.sockets)s.write(data);}
 // open-lark going away: sockets drop at once and nothing answers until up().
 goDown(){this.down=true;for(const s of this.sockets)s.destroy();this.sockets.clear();this.server.closeAllConnections();}
 up(){this.down=false;}
 answerUpgrades(){this.hangUpgrades=false;for(const h of this.held?.splice(0)??[])h.answer();}
 // Fails requests whose path matches with status, `times` times (Infinity by default).
 fail(pattern,status=500,times=Infinity){this.failures.push({pattern,status,times});}
 // Answers requests whose path matches ms late, `times` times; the answer is what open-lark held when the request came.
 delay(pattern,ms,times=1){(this.delays??=[]).push({pattern,ms,times});}
 writes(){return this.requests.filter(r=>!(r.method==='GET'||(r.method==='POST'&&READ_POSTS.has(r.path))));}

 #auth(req){
  const h=req.headers.authorization,bearer=typeof h==='string'&&h.startsWith('Bearer ')?h.slice(7).trim():undefined;
  return bearer===this.fullToken?'full':bearer===this.token?'read':undefined;
 }
 #upgrade(req,socket){
  if(this.down)return socket.destroy();
  // hangUpgrades: the TCP connection is accepted and the upgrade never answered (released when it is turned off).
  if(this.hangUpgrades){(this.held??=[]).push({socket,answer:()=>this.#upgrade(req,socket)});return;}
  const url=new URL(req.url,'http://fake');this.requests.push({method:'GET',path:url.pathname,query:Object.fromEntries(url.searchParams),upgrade:true});
  if(url.pathname!==`${BASE}/events`||!this.#auth(req)){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
  const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  this.sockets.add(socket);let buf=Buffer.alloc(0);
  socket.on('data',d=>{buf=Buffer.concat([buf,d]);
   while(buf.length>=2){
    const op=buf[0]&0x0f,masked=buf[1]&0x80;let len=buf[1]&0x7f,off=2;
    if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4;}else if(len===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));off=10;}
    const total=off+(masked?4:0)+len;if(buf.length<total)return;buf=buf.subarray(total);
    if(op===0x8){this.sockets.delete(socket);socket.end(frame(0x8,Buffer.alloc(0)));}
   }
  });
  socket.on('close',()=>this.sockets.delete(socket));socket.on('error',()=>this.sockets.delete(socket));
 }
 async #handle(req,res){
  if(this.down){req.socket.destroy();return;}
  const url=new URL(req.url,'http://fake'),path=url.pathname,q=Object.fromEntries(url.searchParams);
  const delay=this.delays?.find(d=>d.times>0&&path.includes(d.pattern));if(delay)delay.times-=1;
  const send=(status,body)=>{const data=JSON.stringify(body),write=()=>{res.writeHead(status,{'content-type':'application/json'});res.end(data);};if(delay)setTimeout(write,delay.ms);else write();};
  const error=(status,code,message)=>send(status,{error:{code,message,recoverable:status<500,traceId:'fake'}});
  let body;if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;body=raw?JSON.parse(raw):{};}
  this.requests.push({method:req.method,path,query:q,...(body?{body}:{})});
  const auth=this.#auth(req);if(!auth)return error(401,'AGENT_AUTH_REQUIRED','Agent token is required');
  const route=this.routes.find(r=>r.method===req.method&&new RegExp('^'+r.path.replace(/:[A-Za-z]+/g,'[^/]+')+'$').test(path));
  if(auth==='read'&&req.method!=='GET'&&!(req.method==='POST'&&route&&READ_POSTS.has(route.path)))return error(403,'AGENT_READ_FORBIDDEN','The read-only agent token cannot perform this action');
  if(!route)return send(404,{statusCode:404,error:'Not Found',message:`Route ${req.method}:${path} not found`});
  const failure=this.failures.find(f=>f.times>0&&(typeof f.pattern==='string'?path.includes(f.pattern):f.pattern.test(path)));
  if(failure){failure.times-=1;return error(failure.status,'FAKE_FAILURE','injected failure');}
  const parts=path.slice(BASE.length).split('/').filter(Boolean).map(decodeURIComponent);
  const key=`${req.method} ${route.path}`;
  switch(key){
   case 'GET /agent/v1':return send(200,{role:'agent',routes:this.routes});
   case 'GET /agent/v1/me':return send(200,{userId:this.me,accountId:this.me,displayName:'我'});
   case 'GET /agent/v1/sync/status':return send(200,{...this.syncState,backlog:0,lastConnectedAt:null,lastPacketAt:null,reconnectCount:0,database:{conversations:this.conversations.size,messages:this.messages.size}});
   case 'GET /agent/v1/conversations':return send(200,this.#conversations(q));
   case 'GET /agent/v1/conversations/:feedId':{const c=this.conversations.get(parts[1]);return c?send(200,this.conversationView(c)):error(404,'CONVERSATION_NOT_FOUND','Conversation not found');}
   case 'GET /agent/v1/conversations/:feedId/messages':{const c=this.conversations.get(parts[1]);if(!c)return send(500,{statusCode:500,error:'Internal Server Error',message:'Conversation not found'});return send(200,this.#page(c,q));}
   case 'GET /agent/v1/conversations/:feedId/pins':return send(200,{items:[]});
   case 'GET /agent/v1/messages/:messageId':{const v=this.messages.get(parts[1]);return v&&!this.notStored.has(v.id)?send(200,{item:clone(v),attachments:[]}):error(404,'MESSAGE_NOT_FOUND','Message not found');}
   case 'GET /agent/v1/messages/:messageId/thread':return send(200,this.#thread(parts[1],q));
   case 'GET /agent/v1/threads/feed':return send(200,this.#threadFeed(q));
   case 'POST /agent/v1/search/mention-history':return send(200,this.#mentions(body));
   default:return send(200,{ok:true});
  }
 }
 #conversations(q){
  const limit=clamp(Number(q.limit??50),1,100),scope=q.scope??'inbox';
  const all=[...this.conversations.values()].filter(c=>scope==='p2p'?!c.isGroup:scope==='group'?c.isGroup:true);
  const key=c=>[c.onTopRankTimeMs?1:0,c.onTopRankTimeMs,c.onTopRankTimeMs?0:c.rankTimeMs,BigInt(c.feedId)];
  const cmp=(a,b)=>{const x=key(a),y=key(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]>y[i]?-1:1;return 0;};
  all.sort(cmp);let start=0;
  if(q.cursor){const cur=JSON.parse(Buffer.from(q.cursor,'base64url').toString());start=all.findIndex(c=>c.feedId===cur.feedId)+1;}
  const page=all.slice(start,start+limit),hasMore=start+limit<all.length,last=page.at(-1);
  return {hasMore,items:page.map(c=>this.conversationView(c)),...(hasMore&&last?{nextCursor:Buffer.from(JSON.stringify({feedId:last.feedId,onTopRankTimeMs:last.onTopRankTimeMs,rankTimeMs:last.rankTimeMs})).toString('base64url')}:{})};
 }
 #page(c,q){
  const anchor=q.aroundPosition??q.beforePosition??q.afterPosition;
  const scene=q.aroundPosition?'specified-position':q.beforePosition?'previous-page':q.afterPosition?'next-page':'first-screen';
  const last=c.frozenLastPosition??c.lastPosition;
  const range=planMessageWindow({anchorPosition:anchor,count:Number(q.limit??50),lastPosition:last,scene});
  if(!range)return {hasNewer:false,hasOlder:false,items:[],syncState:'complete'};
  const views=this.byFeed.get(c.feedId).map(id=>this.messages.get(id));
  const rows=views.filter(v=>Number(v.position)>=range.start&&Number(v.position)<=range.end).sort((a,b)=>Number(a.position)-Number(b.position));
  let replies=[];
  if(rows.length&&c.chatMode!=='topic'){
   const earliest=Date.parse(rows[0].createdAt),latest=Date.parse(rows.at(-1).createdAt),tail=range.end>=last;
   replies=views.filter(v=>Number(v.position)<=0&&v.threadId!==v.id&&Date.parse(v.createdAt)>=earliest&&(tail||Date.parse(v.createdAt)<=latest));
  }
  const items=[...rows,...replies].sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id)).map(clone);
  // maxPosition and minPosition only count positions above 0, as open-lark's do.
  const hasOlder=range.start>0,hasNewer=range.end<last,main=rows.map(v=>v.position).filter(p=>Number(p)>0);
  return {hasNewer,hasOlder,items,maxPosition:main.at(-1),minPosition:main[0],...(hasNewer?{nextNewerCursor:String(range.end)}:{}),...(hasOlder?{nextOlderCursor:String(range.start)}:{}),syncState:this.gaps.has(c.feedId)?'gap':'complete'};
 }
 #thread(rootId,q){
  const root=this.messages.get(rootId);if(!root)return {hasOlder:false,items:[]};
  const limit=clamp(Number(q.limit??100),1,100);
  let replies=[...this.messages.values()].filter(v=>v.threadMessageType==='reply'&&v.threadId===root.id);
  if(q.beforePosition)replies=replies.filter(v=>v.threadPosition!=null&&Number(v.threadPosition)<Number(q.beforePosition));
  replies.sort((a,b)=>Number(b.threadPosition??-1)-Number(a.threadPosition??-1)||Date.parse(b.createdAt)-Date.parse(a.createdAt));
  const hasOlder=replies.length>limit,page=replies.slice(0,limit).reverse(),cursor=page.find(v=>v.threadPosition!=null);
  return {hasOlder,items:[root,...page].map(clone),...(hasOlder&&cursor?{nextOlderCursor:cursor.threadPosition}:{})};
 }
 #threadFeed(q){
  const limit=clamp(Math.trunc(Number(q.limit))||30,1,50);
  let cards=[...this.threadCards].map(([threadId,rankTimeMs])=>({threadId,rankTimeMs})).sort((a,b)=>b.rankTimeMs-a.rankTimeMs||(BigInt(b.threadId)>BigInt(a.threadId)?1:-1));
  if(q.cursor){const [rank,id]=q.cursor.split(':');cards=cards.filter(c=>c.rankTimeMs<Number(rank)||(c.rankTimeMs===Number(rank)&&BigInt(c.threadId)<BigInt(id)));}
  const page=cards.slice(0,limit),hasMore=cards.length>limit,last=page.at(-1);
  const items=page.map(({threadId,rankTimeMs})=>{
   const root=this.messages.get(threadId),replies=[...this.messages.values()].filter(v=>v.threadMessageType==='reply'&&v.threadId===threadId);
   return {conversationName:this.conversations.get(root.feedId).name,feedId:root.feedId,...(replies.length?{lastReply:clone(replies.at(-1))}:{}),rankAt:iso(rankTimeMs),
    replyCount:root.threadReplyCount,root:clone(root),rootPosition:root.position,threadId,unreadCount:0};
  });
  return {hasMore,items,...(hasMore&&last?{nextCursor:`${last.rankTimeMs}:${last.threadId}`}:{})};
 }
 // Lark's message search with include_at_user_ids: [me]: newest first, an opaque cursor that does not encode the window.
 // Whether it also returns messages that only @all is not known, so the fake does, and butler has to filter them.
 #mentions(body){
  if(this.searchFails)return {items:[],upstream:{attempted:true,failed:true,reason:'fake'}};
  const limit=clamp(body.limit??20,1,50),from=(body.startTime??0)*1000,to=body.endTime===undefined?Infinity:body.endTime*1000+999;
  const hits=[...this.messages.values()].filter(v=>!v.isMine&&(v.parts.some(p=>p.kind==='at'&&(p.refId===this.me||p.refId==='all')))&&Date.parse(v.createdAt)>=from&&Date.parse(v.createdAt)<=to)
   .sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  const offset=body.cursor?JSON.parse(Buffer.from(body.cursor,'base64url').toString()).offset:0,page=hits.slice(offset,offset+limit);
  return {items:page.map(v=>({conversationName:this.conversations.get(v.feedId).name,feedId:v.feedId,messageId:v.id,position:Number(v.position),senderName:v.senderName,snippet:v.textPreview,source:'remote',title:v.senderName,type:'message',createTime:v.createdAt})),
   ...(offset+limit<hits.length?{nextCursor:Buffer.from(JSON.stringify({offset:offset+limit})).toString('base64url')}:{}),total:hits.length,upstream:{attempted:true,failed:false}};
 }
}

export async function startFakeOpenLark(options){return new FakeOpenLark(options).listen();}
