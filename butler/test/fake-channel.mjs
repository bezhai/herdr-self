// A stand-in for @larksuite/channel's LarkChannel, as the bot uses it: createLarkChannel(options) returns it, the bot
// registers its handlers with on(), connects, sends, updates the cards it sent and disconnects. The test makes Feishu
// deliver messages (receive), card clicks (click, which resolves to the answer that goes back to Feishu) and connection
// events (emit), and makes connecting fail.
export const OWNER='ou_owner0000000000000000000000001';
let seq=0;

export function fakeChannel({failConnects=0}={}){
 const f={options:undefined,handlers:{},sent:[],updated:[],connects:0,disconnects:0,failConnects,state:'idle'};
 const channel={
  on(name,handler){f.handlers[name]=handler;return ()=>{if(f.handlers[name]===handler)delete f.handlers[name];};},
  async connect(){f.connects+=1;if(f.connects<=f.failConnects){f.state='error';throw Error('WebSocket connect failed: getaddrinfo ENOTFOUND open.feishu.cn');}f.state='open';},
  async disconnect(){f.disconnects+=1;f.state='closed';},
  rawWsClient:{close(){f.state='closed';}},
  getConnectionStatus(){return {state:f.state};},
  async send(to,input,opts={}){f.sent.push({to,input,opts});return {messageId:`om_out${f.sent.length}`};},
  async updateCard(messageId,card){f.updated.push({messageId,card});},
 };
 // A message as the SDK normalizes it: by default a direct message from the owner.
 f.message=(o={})=>({messageId:`om_in${++seq}`,chatId:'oc_dm_owner',chatType:'p2p',senderId:OWNER,content:'在吗',rawContentType:'text',resources:[],mentions:[],
  mentionAll:false,mentionedBot:false,createTime:Date.now(),...o});
 f.receive=async o=>{const m=f.message(o);await f.handlers.message?.(m);return m;};
 f.emit=(name,...args)=>f.handlers[name]?.(...args);
 // A click as the SDK normalizes it (CardActionEvent): by default the owner's, on a button.
 f.click=async(o={})=>f.handlers.cardAction?.({messageId:'om_out1',chatId:'oc_dm_owner',operator:{openId:OWNER},action:{tag:'button',value:{}},...o});
 f.factory=options=>{f.options=options;return channel;};
 return f;
}
// Every component of a card, nested ones and text objects too (whatever has a tag), in the order the JSON lists them.
export function* componentsOf(x){
 if(Array.isArray(x)){for(const y of x)yield* componentsOf(y);return;}
 if(!x||typeof x!=='object')return;
 if(typeof x.tag==='string')yield x;
 for(const v of Object.values(x))yield* componentsOf(v);
}
// The text a sent message shows: a text message's text, or every text of a card, its header and buttons included.
export function shown(input){
 if(input.text!==undefined)return input.text;
 return [...componentsOf(input.card)].filter(c=>c.tag==='plain_text'||c.tag==='markdown').map(c=>c.content).join('\n');
}
