// What a message is to butler, decided from the message alone and a few facts the caller looks up. Pure functions.

// In the order a record lists them.
export const CATEGORIES=['mention','dm','reply','thread','watched'];

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

// ctx: me, collectedSince (ms; nothing older is collected), chatKind (direct|group|topic), and when they apply:
// watchSince (the chat is watched since then), participatedSince (I took part in this message's thread since then),
// parentIsMine (the message it replies to is one of mine, known from butler's own store).
export function categoriesOf(v,ctx){
 const t=Date.parse(v.createdAt);
 if(!(t>=ctx.collectedSince))return [];
 const out=[];
 if(!v.isMine&&mentionsMe(v,ctx.me))out.push('mention');
 if(ctx.chatKind==='direct')out.push('dm');
 if(!v.isMine&&(v.replyTo?.senderId===ctx.me||ctx.parentIsMine))out.push('reply');
 if(ctx.participatedSince!==undefined&&t>=ctx.participatedSince&&threadRootOf(v))out.push('thread');
 if(ctx.watchSince!==undefined&&t>=ctx.watchSince)out.push('watched');
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

// The stored form of a message view.
export function recordOf(v,chatKind){
 return {id:v.id,feedId:v.feedId,chatKind,senderId:v.senderId??null,senderName:v.senderName??null,senderType:v.senderType??null,
  createdAt:Date.parse(v.createdAt),position:v.position??null,threadRole:v.threadMessageType??'none',rootId:threadRootOf(v)??null,parentId:v.parentId??null,
  replyToSenderId:v.replyTo?.senderId??null,text:plainText(v),parts:JSON.stringify(v.parts??[]),unreadable:isUnreadable(v),isMine:Boolean(v.isMine),
  mentionsAll:Boolean(v.isAtAll),isRecalled:Boolean(v.isRecalled),isEdited:Boolean(v.isEdited),isEphemeral:Boolean(v.isEphemeral)};
}
