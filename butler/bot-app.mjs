// Butler's Feishu app, through Feishu's official one-link flow (the SDK's registerApp, which the bridge uses too):
// Feishu gives a link, the owner opens it and confirms on Feishu's own page. Creating the app returns its credentials
// and the open_id of whoever created it, who becomes the bot's owner. Updating it (registerApp with the app's id)
// shows the owner what the app would get on top of what it has, and applies it once confirmed: how an app made before
// the cards had buttons gets their callback.
import {registerApp} from '@larksuite/channel';

// The bot only sends as itself, receives direct messages, reads its own basic info and gets the clicks on its cards'
// buttons (card.action.trigger); no user scopes. preset false drops Feishu's default template, so nothing else is
// asked for. How the clicks are delivered (over the long connection) is not among what this can say: see README.
export const APP_ADDONS={preset:false,
 scopes:{tenant:['im:message:send_as_bot','im:message.p2p_msg:readonly','application:bot.basic_info:read']},
 events:{items:{tenant:['im.message.receive_v1']}},callbacks:{items:['card.action.trigger']}};
const HOSTS=['open.feishu.cn','open.larkoffice.com','open.larksuite.com'];
const APP_ID=/^cli_[a-zA-Z0-9]+$/;

// Runs the flow with options, showing its link through onLink(url, expiresInSeconds) once Feishu gives one under its
// own domain. Resolves to what Feishu returns.
function run({register,onLink,signal,...options}){
 return register({source:'herdr-butler',addons:structuredClone(APP_ADDONS),signal,...options,
  onQRCodeReady:info=>{
   const u=new URL(info.url);
   if(u.protocol!=='https:'||u.username||u.password||u.port||!HOSTS.includes(u.hostname))throw Error(`飞书给出的链接不在飞书的域名下，没有使用：${u.origin}`);
   onLink(u.href,Number(info.expireIn)||600);
  }});
}
const secretOf=result=>{
 if(typeof result?.client_secret!=='string'||!result.client_secret)throw Error('飞书没有返回 App Secret');
 return result.client_secret;
};

// A new app, never an existing one. Resolves to {appId, appSecret, owner, domain} once the app is created.
export async function createApp({register=registerApp,onLink,signal,name='工作管家'}){
 const result=await run({register,onLink,signal,createOnly:true,appPreset:{name,desc:'整理和你有关的飞书消息，定时汇总，在私聊里听你吩咐'}});
 const appId=result?.client_id,appSecret=secretOf(result),owner=result?.user_info?.open_id,brand=result?.user_info?.tenant_brand;
 if(typeof appId!=='string'||!APP_ID.test(appId))throw Error('飞书返回的 App ID 不对');
 if(typeof owner!=='string'||!/^ou_[a-zA-Z0-9]+$/.test(owner))throw Error('飞书没有返回创建者的 open_id，不知道机器人该听谁的');
 if(brand!==undefined&&brand!=='feishu'&&brand!=='lark')throw Error(`不认识的飞书版本：${brand}`);
 return {appId,appSecret,owner,domain:brand==='lark'?'lark':'feishu'};
}

// The app appId (the configured one) gets APP_ADDONS. createOnly must not be true: Feishu's page would then ignore
// appId and create a new app. Rejects when Feishu answers for any other app. Resolves to {appSecret}: the secret
// Feishu returns, which the caller keeps when it has changed.
export async function updateApp({register=registerApp,appId,onLink,signal}){
 if(typeof appId!=='string'||!APP_ID.test(appId))throw Error(`配置里的 App ID 不对：${appId}`);
 const result=await run({register,onLink,signal,createOnly:false,appId});
 if(result?.client_id!==appId)throw Error(`飞书返回的是另一个应用（${result?.client_id}），不是配置的 ${appId}；配置文件没有改动`);
 return {appSecret:secretOf(result)};
}
