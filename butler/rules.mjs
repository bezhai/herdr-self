// What a message is to butler, decided from the message alone and a few facts the caller looks up. Pure functions.

// In the order a record lists them. Every category but stored says the message is about me (mention, dm, reply,
// thread, own), comes from a chat at the instant level since it became instant, or is one of a daily chat that the
// daily read flagged as something I may have to act on (flagged, see reading.mjs): batches take those (see
// matters.mjs). own: a message I sent, in any chat the collector reads; what I answered, and where, shows what I
// already took care of. stored: none of the others, kept only because its chat is not ignored, as context and for
// later; it never joins another category (see Store.upsertMessage and Store.flag). The collector never gives flagged.
export const CATEGORIES=['mention','dm','reply','thread','instant','flagged','own','stored'];
// A chat's level: instant (every message goes to the batches, and the daily read reads it for topics), daily (kept,
// and read every day for topics, see reading.mjs), store (kept, not looked at) or ignore (not kept). A chat without
// one goes by ungradedLevel until it is graded.
export const LEVELS=['instant','daily','store','ignore'];
// The level of a chat that has none yet, from when collection began: a direct chat is instant, so that what a bot or
// an agent sends me goes to the model as it did before levels; a group of either kind is store.
export const ungradedLevel=chatKind=>chatKind==='direct'?'instant':'store';
// What they are called when butler talks to me.
export const LEVEL_NAMES={instant:'即时',daily:'每日',store:'只存不看',ignore:'忽略'};

// The root of the thread a message belongs to. Every message carries a threadId (its own id or the root of its reply
// chain), so only threadMessageType says whether it is in a thread.
export function threadRootOf(v){
 if(v.threadMessageType==='root')return v.id;
 if(v.threadMessageType==='reply')return v.threadId||v.parentId;
 return undefined;
}

// An @ of me. Lark may set is_at_me for an @all as well, so an @all without an @ of me does not count.
export function mentionsMe(v,me){
 if(v.parts?.some(p=>p.kind==='at'&&p.refId===me))return true;
 return Boolean(v.isAtMe)&&!v.isAtAll;
}

// open-lark's sender types are user, bot and agent. One of unknown type counts as a person, so that a person's direct
// message is never only stored for want of a type.
const isPerson=v=>v.senderType!=='bot'&&v.senderType!=='agent';
// ctx: me, collectedSince (ms; nothing older is collected), chatKind (direct|group|topic), level (the chat's {level,
// since}, if it has one; see ungradedLevel otherwise), and when they apply: participatedSince (I took part in this
// message's thread since then), parentIsMine (the message it replies to is one of mine, known from butler's own store).
// What is about me is kept whatever the chat's level. In a direct chat that is what a person writes (dm), so that
// instant there marks only what a bot or an agent says, and a person's message reads dm alone as it always did.
export function categoriesOf(v,ctx){
 const t=Date.parse(v.createdAt);
 if(!(t>=ctx.collectedSince))return [];
 const out=[],level=ctx.level??{level:ungradedLevel(ctx.chatKind),since:ctx.collectedSince},dm=ctx.chatKind==='direct'&&isPerson(v);
 if(!v.isMine&&mentionsMe(v,ctx.me))out.push('mention');
 if(dm)out.push('dm');
 if(!v.isMine&&(v.replyTo?.senderId===ctx.me||ctx.parentIsMine))out.push('reply');
 if(ctx.participatedSince!==undefined&&t>=ctx.participatedSince&&threadRootOf(v))out.push('thread');
 if(level.level==='instant'&&t>=level.since&&!dm)out.push('instant');
 if(v.isMine)out.push('own');
 if(!out.length&&level.level!=='ignore')out.push('stored');
 return out;
}

// open-lark hands encrypted messages to the agent API as a placeholder text (agent-olk-read.ts PLACEHOLDER).
const ENCRYPTED=/^加密消息（.*）$/;
export function isUnreadable(v){
 if(v.isDecryptoFail||v.isSecretChatDecryptedFailed||v.decodeError)return true;
 const text=(v.parts??[]).map(p=>p.text??'').join('').trim()||(v.textPreview??'').trim();
 return ENCRYPTED.test(text);
}

export function plainText(v){
 const text=(v.parts??[]).map(p=>p.text??(p.kind==='text'?'':`[${p.kind}]`)).join('');
 return text||v.textPreview||'';
}

export function chatKindOf(v,chatMode){return chatMode??(v.chatType===1?'direct':'group');}

// open-lark's own message permalink (api.ts recalledMessageUrl): a thread message opens in its thread, a reply at the
// root's position when that is known and not negative, otherwise at its own.
export function messageLink(base,{feedId,id,position,threadRole,rootId,rootPosition}){
 const url=new URL(`/messenger/${encodeURIComponent(feedId)}`,base);
 const thread=threadRole==='root'?id:threadRole==='reply'?rootId:undefined;
 const at=threadRole==='reply'&&rootPosition!=null&&Number(rootPosition)>=0?rootPosition:position;
 url.searchParams.set('message',id);url.searchParams.set('position',String(at));
 if(thread)url.searchParams.set('thread',thread);
 return url.toString();
}

// A message's reactions as butler keeps them: one per key, with how many reacted, whether I am among them and their
// names. open-lark's identities and English names of each user are left out. undefined when the view has no reaction
// list, so that a view without one leaves the stored reactions as they are.
export function reactionsOf(list){
 if(!Array.isArray(list))return undefined;
 return list.filter(r=>r?.key).map(r=>({key:String(r.key),count:Number(r.count)||0,isMine:Boolean(r.isMine),userNames:Array.isArray(r.userNames)?r.userNames.map(String):[]}));
}

// The stored form of a message view. reactions: JSON, or null when the view has none to tell (see reactionsOf).
export function recordOf(v,chatKind){
 const reactions=reactionsOf(v.reactions);
 return {id:v.id,feedId:v.feedId,chatKind,senderId:v.senderId??null,senderName:v.senderName??null,senderType:v.senderType??null,
  createdAt:Date.parse(v.createdAt),position:v.position??null,threadRole:v.threadMessageType??'none',rootId:threadRootOf(v)??null,parentId:v.parentId??null,
  replyToSenderId:v.replyTo?.senderId??null,text:plainText(v),parts:JSON.stringify(v.parts??[]),unreadable:isUnreadable(v),isMine:Boolean(v.isMine),
  mentionsAll:Boolean(v.isAtAll),isRecalled:Boolean(v.isRecalled),isEdited:Boolean(v.isEdited),isEphemeral:Boolean(v.isEphemeral),
  reactions:reactions?JSON.stringify(reactions):null};
}
