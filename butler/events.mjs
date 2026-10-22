// open-lark's event socket (GET /agent/v1/events). It has no cursor and no replay and drops on every open-lark restart,
// so it only wakes butler up; whatever it misses, reconciliation finds. The token goes in a header: the API does not
// take it from the query string, and Node's WebSocket accepts headers as an extension of the standard constructor.
export class EventStream{
 // connectTimeoutMs: an attempt that neither opens nor closes by then is given up. Node 22's WebSocket stays CONNECTING
 // for good when the connection drops mid-handshake, and a server can accept the connection and never answer.
 constructor({url,token,onEvent,onOpen,onClose,minDelayMs=1000,maxDelayMs=30000,connectTimeoutMs=30000}){
  Object.assign(this,{url,token,onEvent,onOpen,onClose,minDelayMs,maxDelayMs,connectTimeoutMs});this.delay=minDelayMs;this.stopped=true;
 }
 start(){this.stopped=false;this.#connect();}
 stop(){this.stopped=true;clearTimeout(this.timer);const s=this.socket;this.socket=undefined;s?.close();}
 #connect(){
  const ws=new WebSocket(this.url,{headers:{authorization:`Bearer ${this.token}`}});this.socket=ws;let opened=false;
  const ended=()=>{
   if(this.socket!==ws)return;this.socket=undefined;clearTimeout(giveUp);this.onClose?.({opened});
   if(this.stopped)return;
   this.timer=setTimeout(()=>{if(!this.stopped)this.#connect();},this.delay);this.delay=Math.min(this.delay*2,this.maxDelayMs);
  };
  const giveUp=setTimeout(()=>{if(opened)return;ended();try{ws.close();}catch{}},this.connectTimeoutMs);
  ws.addEventListener('open',()=>{if(this.socket!==ws)return;opened=true;clearTimeout(giveUp);this.delay=this.minDelayMs;this.onOpen?.();});
  ws.addEventListener('message',e=>{if(this.socket!==ws)return;let event;try{event=JSON.parse(String(e.data));}catch{return;}this.onEvent(event);});
  ws.addEventListener('error',()=>{});
  ws.addEventListener('close',ended);
 }
}
