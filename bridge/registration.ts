import {registerApp} from '@larksuite/channel';
import QRCode from 'qrcode';
import {normalizeApp} from './platform.ts';
import {text,uuid} from './core.ts';
import type {Store} from './core.ts';
import type {App} from './state.ts';

// Use only the bot capabilities exercised by the bridge; no user OAuth scopes.
export const registrationAddons={preset:false,scopes:{tenant:[
 'im:message:send_as_bot','im:message.p2p_msg:readonly',
 'im:message.group_at_msg:readonly','application:bot.basic_info:read',
 // Topics mark a message with a reaction until its turn ends.
 'im:message.reactions:write_only',
 // The slash command panel offers the bridge's commands (see commands.ts).
 'application:app_slash_command:read','application:app_slash_command:write',
 // Topics download the images and files of the messages they receive (see attachments.ts).
 'im:message:readonly',
 // Bindings are named after the chat in Feishu and follow the rename of a group (see Platforms.syncNames).
 'im:chat:readonly',
]},events:{items:{tenant:['im.message.receive_v1','im.chat.updated_v1']}},callbacks:{items:['card.action.trigger']}};
// A run of the registration flow (see start), with the link and its QR code while Feishu waits for the owner.
type Registration={id:string,name:string,status:'starting'|'pending'|'connecting'|'completed'|'cancelled'|'expired'|'denied'|'error'|'needs_owner'|'connection_error',
 controller:AbortController,message:string,timer?:NodeJS.Timeout,done?:Promise<void>,url?:string,qr?:string,expiresAt?:number,appId?:string};
const active=(s:Registration|null)=>['starting','pending','connecting'].includes(s?.status);
const errors:{[code:string]:string}={access_denied:'已在飞书拒绝创建，可重新发起。',expired_token:'创建链接已过期，请重新生成。',abort:'已停止等待。如已在飞书创建应用，可通过已有应用入口添加。'};

type Options={register?:typeof registerApp,qr?:(url:string)=>Promise<string>,timeoutMs?:number,connect?:(a:App)=>Promise<boolean>};
export class Registrations{
 declare store:Store;declare connect:NonNullable<Options['connect']>;declare register:typeof registerApp;declare qr:NonNullable<Options['qr']>;declare timeoutMs:number;
 declare current:Registration|null;
 constructor(store:Store,{register=registerApp,qr=url=>QRCode.toDataURL(url,{width:300,margin:3,errorCorrectionLevel:'M'}),timeoutMs=25000,connect=async()=>true}:Options={}){
  this.store=store;this.connect=connect;this.register=register;this.qr=qr;this.timeoutMs=timeoutMs;this.current=null;
 }
 // Explicit projection: credentials, device codes and SDK exceptions never reach the browser.
 status(){const r=this.current;if(!r)return null;return {id:r.id,name:r.name,status:r.status,url:r.url,qr:r.qr,expiresAt:r.expiresAt,appId:r.appId,message:r.message};}
 start(input:{name?:unknown}){
  if(active(this.current))return this.status();
  const r:Registration={id:uuid(),name:text(input.name||'Herdr 工作助手',60),status:'starting',controller:new AbortController(),message:'正在生成飞书创建链接…'};
  this.current=r;
  r.timer=setTimeout(()=>this.finish(r,'error','生成链接超时，请稍后重试。'),this.timeoutMs);r.timer.unref?.();
  r.done=this.run(r);return this.status();
 }
 finish(r:Registration,status:Registration['status'],message:string){if(!active(r))return;clearTimeout(r.timer);r.status=status;r.message=message;delete r.url;delete r.qr;r.controller.abort();}
 cancel(id:string){const r=this.current;if(r?.id!==id)throw Error('创建流程已变化，请刷新后重试');this.finish(r,'cancelled',errors.abort);return this.status();}
 stop(){if(this.current)this.finish(this.current,'cancelled',errors.abort);}
 async run(r:Registration){
  try{
   const result=await this.register({source:'herdr-bridge',createOnly:false,addons:structuredClone(registrationAddons),signal:r.controller.signal,
    appPreset:{name:r.name,desc:'通过 Herdr Bridge 连接你的原生 coding agent 会话'},
    onQRCodeReady:info=>{
     if(!active(r)||r.controller.signal.aborted)return;
     const u=new URL(info.url);
     if(u.protocol!=='https:'||u.username||u.password||!['open.feishu.cn','open.larkoffice.com','open.larksuite.com'].includes(u.hostname)||u.port)throw Error('unexpected_registration_url');
     clearTimeout(r.timer);r.status='pending';r.url=u.href;r.expiresAt=Date.now()+Math.min(600,Math.max(1,Number(info.expireIn)||600))*1000;
     r.message='用飞书扫码或打开创建页，在官方页面确认应用与权限。';
     r.timer=setTimeout(()=>this.finish(r,'expired',errors.expired_token),r.expiresAt-Date.now());r.timer.unref?.();
     // QR generation is local; the authorization URL is never sent to another service.
     Promise.resolve().then(()=>this.qr(u.href)).then(qr=>{if(active(r))r.qr=qr;}).catch(()=>{});
    },
    onStatusChange:info=>{if(active(r)&&info.status==='slow_down')r.message='等待飞书确认，平台已调整查询间隔。';},
   });
   // Ignore an SDK result arriving after cancellation/expiry or after a newer flow starts.
   if(!active(r)||r.controller.signal.aborted||this.current!==r)return;
   clearTimeout(r.timer);
   const existing=this.store.data.apps.find(a=>a.appId===result.client_id);
   const brand=result.user_info?.tenant_brand;
   if(brand&&brand!=='feishu'&&brand!=='lark')throw Error('unknown_brand');
   const owner=result.user_info?.open_id;
   const a=existing||normalizeApp({name:r.name,appId:result.client_id,appSecret:result.client_secret,
    domain:brand==='lark'?'lark':'feishu',allowedUsers:typeof owner==='string'&&/^ou_[a-zA-Z0-9]+$/.test(owner)?[owner]:[]});
   if(!existing){a.createdVia='registration';this.store.data.apps.push(a);}
   try{this.store.save();}catch(e){if(!existing)this.store.data.apps=this.store.data.apps.filter(x=>x!==a);throw e;}
   r.appId=a.id;
   if(!a.allowedUsers.length){this.finish(r,'needs_owner','请补充可操作用户');return;}
   r.status='connecting';r.message='正在连接';
   try{await this.connect(a);}catch{this.finish(r,'connection_error','应用已添加，连接未成功');return;}
   this.finish(r,'completed','已连接');
   this.store.log('应用接入',r.name+' 已通过飞书官方流程接入');
  }catch(e){
   const code=e?.code;
   this.finish(r,code==='expired_token'?'expired':code==='access_denied'?'denied':'error',errors[code]||'未能完成接入。可重新生成链接；如已在飞书创建应用，请使用已有应用入口。');
  }
 }
}
