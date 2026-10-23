// Creating butler's Feishu app through Feishu's official one-link flow (the SDK's registerApp, which the bridge uses
// too): Feishu gives a link, the owner opens it and confirms the new app and its permissions on Feishu's own page,
// and the SDK gets back the app's credentials and the open_id of whoever created it, who becomes the bot's owner.
import {registerApp} from '@larksuite/channel';

// The bot only sends as itself, receives direct messages and reads its own basic info; no card callbacks (it has no
// buttons) and no user scopes. preset false drops Feishu's default template, so nothing else is asked for.
export const APP_ADDONS={preset:false,
 scopes:{tenant:['im:message:send_as_bot','im:message.p2p_msg:readonly','application:bot.basic_info:read']},
 events:{items:{tenant:['im.message.receive_v1']}}};
const HOSTS=['open.feishu.cn','open.larkoffice.com','open.larksuite.com'];

// onLink(url, expiresInSeconds): show the link. Resolves to {appId, appSecret, owner, domain} once the app is created.
export async function createApp({register=registerApp,onLink,signal,name='工作管家'}){
 const result=await register({source:'herdr-butler',createOnly:true,addons:structuredClone(APP_ADDONS),signal,
  appPreset:{name,desc:'整理和你有关的飞书消息，定时汇总，在私聊里听你吩咐'},
  onQRCodeReady:info=>{
   const u=new URL(info.url);
   if(u.protocol!=='https:'||u.username||u.password||u.port||!HOSTS.includes(u.hostname))throw Error(`飞书给出的创建链接不在飞书的域名下，没有使用：${u.origin}`);
   onLink(u.href,Number(info.expireIn)||600);
  }});
 const appId=result?.client_id,appSecret=result?.client_secret,owner=result?.user_info?.open_id,brand=result?.user_info?.tenant_brand;
 if(typeof appId!=='string'||!/^cli_[a-zA-Z0-9]+$/.test(appId))throw Error('飞书返回的 App ID 不对');
 if(typeof appSecret!=='string'||!appSecret)throw Error('飞书没有返回 App Secret');
 if(typeof owner!=='string'||!/^ou_[a-zA-Z0-9]+$/.test(owner))throw Error('飞书没有返回创建者的 open_id，不知道机器人该听谁的');
 if(brand!==undefined&&brand!=='feishu'&&brand!=='lark')throw Error(`不认识的飞书版本：${brand}`);
 return {appId,appSecret,owner,domain:brand==='lark'?'lark':'feishu'};
}
