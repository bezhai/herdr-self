// A stand-in for @larksuite/channel's LarkChannel, as the bot uses it: createLarkChannel(options) returns it, the bot
// registers its handlers with on(), connects, sends and disconnects. The test makes Feishu deliver messages (receive)
// and connection events (emit), and makes connecting fail.
export const OWNER='ou_owner0000000000000000000000001';
let seq=0;

export function fakeChannel({failConnects=0}={}){
 const f={options:undefined,handlers:{},sent:[],connects:0,disconnects:0,failConnects,state:'idle'};
 const channel={
  on(name,handler){f.handlers[name]=handler;return ()=>{if(f.handlers[name]===handler)delete f.handlers[name];};},
  async connect(){f.connects+=1;if(f.connects<=f.failConnects){f.state='error';throw Error('WebSocket connect failed: getaddrinfo ENOTFOUND open.feishu.cn');}f.state='open';},
  async disconnect(){f.disconnects+=1;f.state='closed';},
  rawWsClient:{close(){f.state='closed';}},
  getConnectionStatus(){return {state:f.state};},
  async send(to,input,opts={}){f.sent.push({to,input,opts});return {messageId:`om_out${f.sent.length}`};},
 };
 // A message as the SDK normalizes it: by default a direct message from the owner.
 f.message=(o={})=>({messageId:`om_in${++seq}`,chatId:'oc_dm_owner',chatType:'p2p',senderId:OWNER,content:'在吗',rawContentType:'text',resources:[],mentions:[],
  mentionAll:false,mentionedBot:false,createTime:Date.now(),...o});
 f.receive=async o=>{const m=f.message(o);await f.handlers.message?.(m);return m;};
 f.emit=(name,...args)=>f.handlers[name]?.(...args);
 f.factory=options=>{f.options=options;return channel;};
 return f;
}
// The text a sent message shows: a text message's text, or the text of every element of a card.
export function shown(input){
 if(input.text!==undefined)return input.text;
 const parts=input.card.header?[input.card.header.title.content]:[];
 for(const e of input.card.body.elements)parts.push(e.tag==='div'?e.text.content:e.tag==='markdown'?e.content:'');
 return parts.join('\n');
}
