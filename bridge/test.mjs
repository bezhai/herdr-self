import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';import net from 'node:net';import http from 'node:http';
import {Readable} from 'node:stream';
import {normalizeMachine,remoteInvocation,herdr,exec,makeDirectory,storeFile,removeDirectory,quote,Store} from './core.mjs';
import {skillPlacer,bundledSkills} from './skills.mjs';
import {namingPrompt,parseBranch,validBranch,branchOf,randomBranch,continueBranch,worktreePath} from './worktree-branch.mjs';import {normalizeApp,normalizeBinding,setPermissionMode,routable,supported,forwardable,Platforms,channelCache} from './platform.mjs';import {Topics} from './topics.mjs';
import {attachmentsOf,promptOf,fileName,titleOf,limits} from './attachments.mjs';
import {PendingChats,consoleUrl} from './pending-chats.mjs';
import {parseCron,zone,next,previous,upcoming,when,phrase} from './cron.mjs';import {Schedules} from './schedules.mjs';import {AgentSchedules} from './agent-schedules.mjs';import {main as runCommand,parse as parseCommand,usage} from './schedule-command.mjs';
import {check,card,plain} from './request-cards.mjs';import {fits} from './message-cards.mjs';import {nameOf} from './adoption.mjs';
import {Registrations} from './registration.mjs';import {staticFile,sendStatic} from './web-assets.mjs';import {fileURLToPath} from 'node:url';
import {normalize} from '@larksuite/channel';

function platformFixture(options){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-platform-')),store=new Store(dir),messages=[],unbound=[];return {dir,store,messages,unbound,platforms:new Platforms(store,{onMessage:(...args)=>messages.push(args),onUnbound:(...args)=>unbound.push(args),...options}),close(){fs.rmSync(dir,{recursive:true});}};}
const route={id:'b',name:'个人助手',enabled:true,appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/work',kind:'claude',requireMention:false};
const inbound={senderType:'user',senderId:'ou_user',chatId:'oc_1',messageId:'om_1',rawContentType:'text',content:'private prompt'};
const allowed={id:'a',name:'bot',enabled:true,allowedUsers:['ou_user']};
const plainText=content=>({tag:'div',text:{tag:'plain_text',content}});
// What Bridge posts into a thread besides request and adoption cards: cards without a header whose summary, which the chat list and
// notifications show, is the beginning of the text, the whole text unless given. A notice shows plain text, a reply its markdown in the
// full width.
const untitledOf=(summary,elements,config)=>({schema:'2.0',config:{...config,summary:{content:summary}},body:{elements}});
const notice=(text,summary=text)=>({card:untitledOf(summary,[plainText(text)])});
const replyOf=(text,summary=text,...after)=>({card:untitledOf(summary,[{tag:'markdown',content:text},...after],{width_mode:'fill'})});
const markdownIn=card=>card.body.elements[0].content;
// What a reply that Herdr cut ends with.
const truncatedNote=plainText('（回复过长，已截断，完整内容请在 Herdr 中查看）');
function registrationFixture(register,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-registration-')),store=new Store(dir);
 const registrations=new Registrations(store,{register,qr:async()=>'data:image/png;base64,test',...options});
 return {store,registrations,close(){registrations.stop();fs.rmSync(dir,{recursive:true});}};
}
const ready=o=>o.onQRCodeReady({url:'https://open.feishu.cn/page/launcher?user_code=test',expireIn:600});
test('registration stores credentials server-side, uses minimal bot scopes and allows only the creator',async()=>{
 const f=registrationFixture(async o=>{assert.equal(o.createOnly,false);assert.equal(o.addons.preset,false);assert.equal(o.addons.scopes.user,undefined);assert.deepEqual(o.addons.events.items.tenant,['im.message.receive_v1']);
  assert.deepEqual(o.addons.scopes.tenant,['im:message:send_as_bot','im:message.p2p_msg:readonly','im:message.group_at_msg:readonly','application:bot.basic_info:read','im:message.reactions:write_only','application:app_slash_command:read','application:app_slash_command:write','im:message:readonly']);ready(o);return {client_id:'cli_test',client_secret:'private-test-secret',user_info:{open_id:'ou_owner',tenant_brand:'feishu'}};});
 try{f.registrations.start({name:'test'});await f.registrations.current.done;assert.equal(f.registrations.status().status,'completed');const a=new Store(f.store.dir).data.apps[0];assert.equal(a.appSecret,'private-test-secret');assert.deepEqual(a.allowedUsers,['ou_owner']);assert.equal(a.enabled,false);assert.equal(a.domain,'feishu');assert.ok(!JSON.stringify(f.registrations.status()).includes('private-test-secret'));assert.equal(f.registrations.status().url,undefined);assert.equal(fs.statSync(path.join(f.store.dir,'state.json')).mode&0o777,0o600);}finally{f.close();}
});
test('duplicate starts reuse pending flow; cancellation fences a late SDK result and stale cancel',async()=>{
 let resolve;let calls=0;const f=registrationFixture(o=>{calls++;ready(o);return new Promise(r=>resolve=r);});
 try{const one=f.registrations.start({name:'one'}),two=f.registrations.start({name:'two'});assert.equal(one.id,two.id);assert.equal(calls,1);const done=f.registrations.current.done;f.registrations.cancel(one.id);resolve({client_id:'cli_late',client_secret:'late'});await done;assert.equal(f.store.data.apps.length,0);assert.equal(f.registrations.status().status,'cancelled');const next=f.registrations.start({name:'next'});assert.notEqual(next.id,one.id);assert.throws(()=>f.registrations.cancel(one.id));f.registrations.cancel(next.id);resolve({});await f.registrations.current.done;}finally{f.close();}
});
test('denial, expiry and errors do not expose SDK details or credentials',async()=>{
 for(const [error,status] of [[{code:'access_denied'},'denied'],[{code:'expired_token'},'expired'],[{message:'secret must not leak',response:{device_code:'private'}},'error']]){
  const f=registrationFixture(async o=>{ready(o);throw error;});try{f.registrations.start({name:'test'});await f.registrations.current.done;assert.equal(f.registrations.status().status,status);assert.equal(f.registrations.status().url,undefined);assert.ok(!JSON.stringify(f.registrations.status()).includes('private'));assert.equal(f.store.data.apps.length,0);}finally{f.close();}
 }
});
test('registration rejects unsafe URLs, handles missing owner and honors Lark tenant brand',async()=>{
 const bad=registrationFixture(async o=>{o.onQRCodeReady({url:'https://attacker.example/qr',expireIn:600});return {};});
 try{bad.registrations.start({name:'test'});await bad.registrations.current.done;assert.equal(bad.registrations.status().status,'error');assert.equal(bad.registrations.status().url,undefined);}finally{bad.close();}
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_lark',client_secret:'secret',user_info:{tenant_brand:'lark'}};});
 try{f.registrations.start({name:'test'});await f.registrations.current.done;assert.equal(f.store.data.apps[0].domain,'lark');assert.deepEqual(f.store.data.apps[0].allowedUsers,[]);assert.equal(f.store.data.apps[0].enabled,false);assert.equal(f.registrations.status().status,'needs_owner');}finally{f.close();}
});
test('begin timeout ignores late callback and does not publish an expired authorization link',async()=>{
 let options,resolve;const f=registrationFixture(o=>{options=o;return new Promise(r=>resolve=r);},{timeoutMs:10});
 try{f.registrations.start({name:'test'});await new Promise(r=>setTimeout(r,25));ready(options);resolve({client_id:'cli_late',client_secret:'late'});await f.registrations.current.done;assert.equal(f.registrations.status().status,'error');assert.equal(f.registrations.status().url,undefined);assert.equal(f.store.data.apps.length,0);}finally{f.close();}
});
test('SSH machine rejects option and shell injection; command arguments remain quoted',()=>{
 for(const host of ['-oProxyCommand=x','a;touch /tmp/bad','a$(id)','x\ny'])assert.throws(()=>normalizeMachine({name:'test',host}));
 const m=normalizeMachine({name:'test',host:'user@host',binary:'~/.local/bin/herdr'});const [bin,args]=remoteInvocation(m,[{path:m.binary},'--session','default','agent','prompt','w1:p1',"x'; echo hacked"]);assert.equal(bin,'ssh');assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('--'));assert.match(args.at(-1),/sh -c/);
 const shell=command=>'env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID sh -c '+quote(command);
 assert.equal(args.at(-1),shell(`"$HOME"/'.local/bin/herdr' '--session' 'default' 'agent' 'prompt' 'w1:p1' 'x'\\''; echo hacked'`));
 const remote=remoteInvocation(m,[{path:m.binary},'tab','create','--cwd',{path:'~/w x'},'--label','~/not-a-path'])[1].at(-1);assert.ok(remote.includes(quote(`"$HOME"/'w x'`).slice(1,-1)));assert.ok(remote.includes(quote(quote('~/not-a-path')).slice(1,-1)));
 // The program is a command name or a {path}; only {path} expands ~/, on the target machine.
 assert.equal(remoteInvocation(m,['mkdir','-p','--',{path:'~/w x'}])[1].at(-1),shell(`'mkdir' '-p' '--' "$HOME"/'w x'`));
 assert.equal(remoteInvocation(m,['mkdir;id','--',{path:"/srv/a'b"}])[1].at(-1),shell(`'mkdir;id' '--' '/srv/a'\\''b'`));
 const local=normalizeMachine({name:'local',type:'local',binary:'~/bin/herdr'});assert.deepEqual(remoteInvocation(local,[{path:local.binary},'--cwd',{path:'~/w x'},{path:'/srv'},'~/text']),[os.homedir()+'/bin/herdr',['--cwd',os.homedir()+'/w x','/srv','~/text']]);
 assert.deepEqual(remoteInvocation(local,['mkdir','-p','--',{path:'~/w x'}]),['mkdir',['-p','--',os.homedir()+'/w x']]);assert.deepEqual(remoteInvocation(local,[{path:'/opt/herdr'}]),['/opt/herdr',[]]);
 assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',session:'../default'}));assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',port:-1}));assert.throws(()=>normalizeMachine({name:'x',host:'cpu2',binary:'herdr'}),/Herdr 路径/);
});
test('a binding routes the pending chat of an app to a working directory and agent kind on a machine; app and chat never come from the client',()=>{
 const chat={token:'t',appId:'a',chatId:'oc_1',chatType:'group'},input={name:'助手',appId:'forged',chatId:'oc_forged',machineId:'m',cwd:'~/code/x',kind:'codex',requireMention:false};
 const {id,...b}=normalizeBinding({...input,rootId:'om_1',paneId:'w1:p1'},chat,[]);assert.match(id,/^[0-9a-f-]{36}$/);assert.deepEqual(b,{name:'助手',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/code/x',kind:'codex',requireMention:false,enabled:true});
 assert.equal(normalizeBinding({...input,requireMention:undefined},chat,[]).requireMention,true);assert.equal(normalizeBinding({...input,cwd:'/srv/app',kind:'claude'},chat,[]).cwd,'/srv/app');
 for(const requireMention of [true,undefined])assert.equal(normalizeBinding({...input,requireMention},{...chat,chatType:'p2p'},[]).requireMention,false);
 for(const cwd of ['relative','/a b','~/$(id)','/x;y','',undefined])assert.throws(()=>normalizeBinding({...input,cwd},chat,[]));assert.throws(()=>normalizeBinding({...input,cwd:'work'},chat,[]),/工作目录/);
 for(const kind of ['claude','codex','agy'])assert.equal(normalizeBinding({...input,kind},chat,[]).kind,kind);
 for(const kind of ['bash','antigravity','Agy','',undefined])assert.throws(()=>normalizeBinding({...input,kind},chat,[]),/^Error: Agent 类型无效$/,String(kind));
 assert.throws(()=>normalizeBinding(input,chat,[{appId:'a',chatId:'oc_1'}]),/该聊天已有绑定/);assert.equal(normalizeBinding(input,chat,[{appId:'other',chatId:'oc_1'},{appId:'a',chatId:'oc_2'}]).chatId,'oc_1');
});
test('a Claude binding has the permission mode default or auto, default when none is given; Codex and Antigravity bindings have none',()=>{
 const chat={token:'t',appId:'a',chatId:'oc_1',chatType:'group'},input={name:'助手',machineId:'m',cwd:'~/code/x',kind:'claude'};
 const {id,...b}=normalizeBinding(input,chat,[]);assert.deepEqual(b,{name:'助手',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/code/x',kind:'claude',permissionMode:'default',requireMention:true,enabled:true});
 for(const permissionMode of ['default','auto'])assert.equal(normalizeBinding({...input,permissionMode},chat,[]).permissionMode,permissionMode);
 for(const permissionMode of ['acceptEdits','plan','bypassPermissions','dontAsk','AUTO',1])assert.throws(()=>normalizeBinding({...input,permissionMode},chat,[]),/^Error: 权限模式无效$/,String(permissionMode));
 for(const kind of ['codex','agy'])for(const permissionMode of [undefined,'auto','bypassPermissions'])assert.equal('permissionMode' in normalizeBinding({...input,kind,permissionMode},chat,[]),false,kind+' '+permissionMode);
 const {id:agyId,...agy}=normalizeBinding({...input,kind:'agy',permissionMode:'auto'},chat,[]);assert.deepEqual(agy,{name:'助手',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/code/x',kind:'agy',requireMention:true,enabled:true});
});
test('changing the permission mode of a Claude binding changes that field only; Codex and Antigravity bindings and other modes are refused',()=>{
 const claude={...route},codex={...route,kind:'codex'},agy={...route,kind:'agy'};
 setPermissionMode(claude,'auto');assert.deepEqual(claude,{...route,permissionMode:'auto'});setPermissionMode(claude,'default');assert.deepEqual(claude,{...route,permissionMode:'default'});
 for(const mode of ['bypassPermissions','plan','',undefined])assert.throws(()=>setPermissionMode(claude,mode),/^Error: 权限模式无效$/);assert.equal(claude.permissionMode,'default');
 for(const other of [codex,agy]){const before={...other};assert.throws(()=>setPermissionMode(other,'auto'),/^Error: 只有 Claude 绑定可以设置权限模式$/,other.kind);assert.deepEqual(other,before);}
});
test('Bridge takes every message of a person; it can forward text, rich text, images and files with content of at most 16000 characters, and no other kind; mentions are left to topic handling',async()=>{
 const raw={sender:{sender_type:'user',sender_id:{open_id:'ou_user'}},message:{message_id:'om_message',chat_id:'oc_1',chat_type:'group',root_id:'om_root',message_type:'text',content:'{"text":"@_user_1 hi"}',mentions:[{key:'@_user_1',id:{open_id:'ou_bot'},name:'bot'}]}};
 const e=await normalize(raw,{botIdentity:{openId:'ou_bot',name:'bot'}}),of=(message_type,content)=>normalize({...raw,message:{...raw.message,message_type,content:JSON.stringify(content)}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(e.content.trim(),'hi');assert.equal(e.chatType,'group');assert.equal(e.mentionedBot,true);assert.equal(routable(e),true);assert.equal(routable({...e,senderType:'bot'}),false);assert.equal(routable({...e,senderId:''}),false);
 const other=await normalize({...raw,message:{...raw.message,mentions:[{key:'@_user_1',id:{open_id:'ou_other'},name:'other'}]}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(other.mentionedBot,false);assert.equal(routable(other),true);
 const dm=await normalize({...raw,message:{...raw.message,chat_type:'p2p',root_id:undefined,mentions:[]}},{botIdentity:{openId:'ou_bot',name:'bot'}});
 assert.equal(dm.chatType,'p2p');assert.equal(routable(dm),true);
 const kinds=x=>[routable(x),supported(x),forwardable(x)];
 const image=await of('image',{image_key:'img_1'}),file=await of('file',{file_key:'file_1',file_name:'a.pdf'}),post=await of('post',{content:[[{tag:'text',text:'看图'},{tag:'img',image_key:'img_2'}]]});
 assert.deepEqual([image.resources,file.resources,post.resources],[[{type:'image',fileKey:'img_1'}],[{type:'file',fileKey:'file_1',fileName:'a.pdf'}],[{type:'image',fileKey:'img_2'}]]);
 for(const x of [e,dm,image,file,post])assert.deepEqual(kinds(x),[true,true,true],x.rawContentType);
 // Stickers, merged forwards, cards and every other kind carry nothing Bridge can hand to an agent, whatever their content.
 for(const [type,content] of [['sticker',{file_key:'stk_1'}],['merge_forward',{}],['interactive',{elements:[]}],['audio',{file_key:'file_a'}],['media',{file_key:'file_v'}],['share_chat',{chat_id:'oc_x'}]]){const x=await of(type,content);assert.ok(x.content,type);assert.deepEqual(kinds(x),[true,false,false],type);}
 // Only the mention, blank, or more than 16000 characters: nothing to forward.
 const mention=await of('text',{text:'@_user_1'});assert.equal(mention.content,'');assert.deepEqual(kinds(mention),[true,true,false]);
 assert.equal(forwardable({...e,content:'  '}),false);assert.equal(forwardable({...e,content:'x'.repeat(16000)}),true);assert.equal(forwardable({...e,content:'x'.repeat(16001)}),false);assert.equal(forwardable({...e,senderType:'bot'}),true);
});
// What the SDK makes of an image message with image key key, and of a sticker.
const imageOf=key=>({rawContentType:'image',content:`![image](${key})`,resources:[{type:'image',fileKey:key}]}),sticker={rawContentType:'sticker',content:'<sticker key="stk_1"/>',resources:[{type:'sticker',fileKey:'stk_1'}]};
const imageMessage={...inbound,messageId:'om_image',...imageOf('img_1')},stickerMessage={...inbound,messageId:'om_sticker',...sticker};
const unsupportedText='暂不支持这类消息，目前只能转发文字、图片和文件';
test('the images and files of a message are numbered per kind and named in its prompt where they were: by absolute path, a file also by its name, or as failed; a path never ends a fragment that Claude Code would take as a pasted image',()=>{
 const post={messageId:'om_1',rawContentType:'post',content:'看看这个报错 \n![image](img_b)\n还有![image](img_c)\n<file key="file_m"/>\n<file key="file_g" name="日志 &quot;1&quot;.txt"/>',
  resources:[{type:'image',fileKey:'img_b'},{type:'image',fileKey:'img_c'},{type:'file',fileKey:'file_m'},{type:'file',fileKey:'file_g',fileName:'日志 "1"\n.txt'}]};
 const list=attachmentsOf(post);assert.deepEqual(list.map(x=>[x.type,x.fileKey,x.index,x.n]),[['image','img_b',1,1],['image','img_c',2,2],['file','file_m',3,1],['file','file_g',4,2]]);
 const dir='/srv/my app/.herdr-bridge/t';Object.assign(list[0],{path:dir+'/om_1-1.png'});Object.assign(list[1],{reason:'下载失败'});Object.assign(list[2],{path:dir+'/om_1-3.mp4'});Object.assign(list[3],{path:dir+'/om_1-4.txt'});
 const prompt=promptOf(post,list);
 assert.equal(prompt,`看看这个报错 \n[图片 1：${dir}/om_1-1.png]\n还有[图片 2：下载失败]\n[文件 1：未命名文件，${dir}/om_1-3.mp4]\n[文件 2：日志 "1" .txt，${dir}/om_1-4.txt]`);
 // Claude Code splits pasted text on newlines and before a / that follows a space, and attaches a fragment that ends in an image extension.
 for(const fragment of prompt.split('\n').flatMap(l=>l.split(/ (?=\/)/)))assert.doesNotMatch(fragment,/\.(png|jpe?g|gif|webp)$/i,fragment);
 const file={messageId:'om_2',rawContentType:'file',content:'<file key="file_f" name="报告 v2.pdf"/>',resources:[{type:'file',fileKey:'file_f',fileName:'报告 v2.pdf'}]};
 const [x]=attachmentsOf(file);assert.equal(promptOf(file,[{...x,path:'/srv/a/om_2-1.pdf'}]),'[文件 1：报告 v2.pdf，/srv/a/om_2-1.pdf]');assert.equal(promptOf(file,[{...x,reason:'超过 30 MB'}]),'[文件 1：下载失败]');
 assert.equal(promptOf(imageMessage,[{...attachmentsOf(imageMessage)[0],path:'/srv/a/om_image-1.jpg'}]),'[图片 1：/srv/a/om_image-1.jpg]');
 // Text that only looks like the markup of a resource stays as it is; a resource whose markup is missing is named at the end.
 const text={rawContentType:'text',content:' ![image](img_x) <file key="k"/> ',resources:[]};assert.deepEqual(attachmentsOf(text),[]);assert.equal(promptOf(text,[]),'![image](img_x) <file key="k"/>');
 const lost={rawContentType:'post',content:'看图',resources:[{type:'image',fileKey:'img_z'}]};assert.equal(promptOf(lost,[{...attachmentsOf(lost)[0],path:'/a/om-1.png'}]),'看图\n[图片 1：/a/om-1.png]');
 // Only images and files count.
 assert.deepEqual(attachmentsOf(stickerMessage),[]);
});
test('an attachment is written as <message id>-<position>.<extension>: an image takes the extension of its content type, a file that of its name, else of its content type; a topic title leaves attachments out',()=>{
 const image={type:'image',index:1},file={type:'file',index:2};
 for(const [type,name] of [['image/png','om_1-1.png'],['image/jpeg','om_1-1.jpg'],['image/gif','om_1-1.gif'],['image/webp','om_1-1.webp'],['',  'om_1-1.jpg'],['application/octet-stream','om_1-1.jpg']])assert.equal(fileName('om_1',image,type),name,type);
 for(const [x,type,name] of [[{fileName:'main.PY'},'application/octet-stream','om_1-2.py'],[{fileName:'a.tar.gz'},'','om_1-2.gz'],[{fileName:'说明'},'application/pdf','om_1-2.pdf'],[{fileName:'x.p y'},'text/plain','om_1-2.txt'],[{},'video/mp4','om_1-2.mp4'],[{fileName:'.env'},'',  'om_1-2.env'],[{},'','om_1-2.bin'],[{fileName:'a.'+'x'.repeat(17)},'','om_1-2.bin']])assert.equal(fileName('om_1',{...file,...x},type),name,JSON.stringify(x));
 assert.equal(fileName('om_../x y',image,'image/png'),'om____x_y-1.png');
 assert.equal(titleOf({rawContentType:'post',content:'看看这个报错 \n![image](img_b)\n还有<file key="f" name="a.txt"/>',resources:[{type:'image',fileKey:'img_b'},{type:'file',fileKey:'f',fileName:'a.txt'}]}),'看看这个报错 还有');
 assert.equal(titleOf(imageMessage),'图片');assert.equal(titleOf({rawContentType:'file',content:'<file key="f" name="a.txt"/>',resources:[{type:'file',fileKey:'f',fileName:'a.txt'}]}),'文件');
 assert.equal(titleOf({rawContentType:'text',content:' ![image](x)  文字\n很长'+'长'.repeat(30),resources:[]}),'![image](x) 文字 很长'+'长'.repeat(7));
 assert.deepEqual(limits,{image:10*1024*1024,file:30*1024*1024});
});
test('secrets are preserved only for the same application and are not part of the app status',()=>{const old={id:'a',appId:'cli_old',appSecret:'saved'};assert.equal(normalizeApp({name:'bot',appId:'cli_old',allowedUsers:[]},old).appSecret,'saved');assert.throws(()=>normalizeApp({name:'bot',appId:'cli_new',allowedUsers:[]},old));
 const f=platformFixture();try{assert.ok(!('appSecret' in JSON.parse(JSON.stringify(f.platforms.status({...old,allowedUsers:[]})))));}finally{f.close();}
});
test('a routed message goes to the topic handler with its app and binding, whether or not it mentions the bot',()=>{
 const f=platformFixture();try{f.store.data.bindings=[{...route,requireMention:true}];f.platforms.receive(allowed,inbound);
 assert.deepEqual(f.messages,[[allowed,f.store.data.bindings[0],inbound]]);assert.deepEqual(f.store.data.logs,[]);}finally{f.close();}
});
test('messages from outside the allowlist, to a disabled app or from a bot are not passed on; a bound chat gets what can be forwarded and the kinds that cannot, but no empty or overlong message',()=>{
 const f=platformFixture();try{f.store.data.bindings=[route];const dm={...inbound,chatId:'oc_2',chatType:'p2p'};
 for(const [app,msg] of [[allowed,{...inbound,senderId:'ou_other'}],[allowed,{...dm,senderId:'ou_other'}],[{...allowed,enabled:false},inbound],[{...allowed,enabled:false},dm],[allowed,{...dm,senderType:'bot'}],[allowed,{...imageMessage,senderType:'bot'}],[allowed,{...inbound,content:'  '}],[allowed,{...inbound,content:'x'.repeat(16001)}]])f.platforms.receive(app,msg);
 assert.deepEqual([f.messages,f.unbound],[[],[]]);
 // A sticker goes on whatever its content, so that the topic handler can say that it is not supported.
 for(const msg of [imageMessage,stickerMessage,{...stickerMessage,messageId:'om_empty_sticker',content:''}])f.platforms.receive(allowed,msg);
 assert.deepEqual(f.messages.map(([a,b,msg])=>[a.id,b.id,msg.messageId]),[['a','b','om_image'],['a','b','om_sticker'],['a','b','om_empty_sticker']]);assert.deepEqual(f.unbound,[]);}finally{f.close();}
});
test('a chat without a binding asks for one on any direct message and on any group message that mentions the bot, whether empty, with an image or of a kind Bridge cannot forward; a disabled binding blocks both',()=>{
 const f=platformFixture();try{f.store.data.bindings=[route,{...route,id:'off',chatId:'oc_off',enabled:false}];
  const dm={...inbound,chatId:'oc_dm',chatType:'p2p'},group={...inbound,chatId:'oc_group',chatType:'group',mentionedBot:false},mentioned={...group,messageId:'om_2',mentionedBot:true};
  for(const [app,msg] of [[allowed,dm],[allowed,group],[allowed,mentioned],[allowed,{...mentioned,chatId:'oc_off'}],[allowed,{...dm,chatId:'oc_off'}],[{...allowed,id:'other'},{...inbound,chatType:'p2p'}]])f.platforms.receive(app,msg);
  assert.deepEqual(f.unbound,[[allowed,dm],[allowed,mentioned],[{...allowed,id:'other'},{...inbound,chatType:'p2p'}]]);assert.deepEqual(f.messages,[]);
  // Only the mention, an image, a sticker: in a direct chat, or in a group with the mention.
  const variants=msg=>[{...msg,messageId:msg.messageId+'-empty',content:''},{...imageMessage,chatId:msg.chatId,chatType:msg.chatType,mentionedBot:msg.mentionedBot,messageId:msg.messageId+'-image'},{...stickerMessage,chatId:msg.chatId,chatType:msg.chatType,mentionedBot:msg.mentionedBot,messageId:msg.messageId+'-sticker'}];
  f.unbound.length=0;for(const msg of [dm,group,mentioned].flatMap(variants))f.platforms.receive(allowed,msg);
  assert.deepEqual(f.unbound.map(([,msg])=>msg.messageId),['om_1-empty','om_1-image','om_1-sticker','om_2-empty','om_2-image','om_2-sticker']);assert.deepEqual(f.messages,[]);
 }finally{f.close();}
});
test('a state file with legacy message queues loads only machines, apps, bindings, topics, schedules and logs; one from before schedules loads none',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-store-'));try{
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({machines:[{id:'m'}],apps:[{id:'a'}],bindings:[{id:'b'}],inbox:[{text:'old prompt'}],outbox:[{key:'k'}],logs:[{kind:'x'}]}));
  const store=new Store(dir);assert.deepEqual(store.data,{machines:[{id:'m'}],apps:[{id:'a'}],bindings:[{id:'b'}],topics:[],schedules:[],logs:[{kind:'x'}]});
  store.data.schedules.push({id:'s'});store.save();assert.deepEqual(new Store(dir).data.schedules,[{id:'s'}]);store.save();assert.ok(!fs.readFileSync(path.join(dir,'state.json'),'utf8').includes('old prompt'));
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('platform channels listen for messages, card clicks and connection events only, take clicks in their own queue and never retry a send',()=>{
 let options;const handlers={},f=platformFixture({channelFactory:o=>{options=o;return {on:(name,fn)=>{handlers[name]=fn;}};}});
 try{f.platforms.channel({id:'a',name:'bot',appId:'cli_test',appSecret:'private',allowedUsers:['ou_owner'],domain:'feishu'});
 assert.deepEqual(Object.keys(handlers).sort(),['cardAction','error','message','reconnected','reconnecting']);assert.deepEqual(options.outbound,{retry:{maxAttempts:1}});
 // A click must not wait behind the chat's messages.
 assert.deepEqual(options.safety.chatQueue,{enabled:true,mergeWhileBusy:false,cardActions:'separate'});}finally{f.close();}
});
test('replies go into the topic thread as cards, resolve to their message id and fail without a connected channel; cards are updated the same way',async()=>{
 const f=platformFixture(),sent=[],updates=[];try{
  await assert.rejects(f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0'}}),/飞书未连接/);await assert.rejects(f.platforms.updateCard(allowed,'om_card',{schema:'2.0'}),/飞书未连接/);
  f.platforms.runtime.set('a',{channel:{getConnectionStatus:()=>({state:'connected'}),send:async(...args)=>{sent.push(args);return {messageId:'om_r'+sent.length};},updateCard:async(...args)=>{updates.push(args);}}});
  assert.equal(await f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0'}}),'om_r1');assert.equal(await f.platforms.reply(allowed,'oc_1','om_1',{card:{schema:'2.0',body:{}}}),'om_r2');
  assert.deepEqual(sent,[['oc_1',{card:{schema:'2.0'}},{replyTo:'om_1',replyInThread:true}],['oc_1',{card:{schema:'2.0',body:{}}},{replyTo:'om_1',replyInThread:true}]]);
  assert.equal(await f.platforms.updateCard(allowed,'om_r2',{schema:'2.0',body:{}}),undefined);assert.deepEqual(updates,[['om_r2',{schema:'2.0',body:{}}]]);
 }finally{f.close();}
});
test('a message of the bot outside any thread goes into the chat as a card without replyTo and resolves to its message id, which can root a topic; it fails without a connected channel',async()=>{
 const f=platformFixture(),sent=[];try{
  await assert.rejects(f.platforms.send(allowed,'oc_1',{card:{schema:'2.0'}}),/飞书未连接/);
  f.platforms.runtime.set('a',{channel:{getConnectionStatus:()=>({state:'connected'}),send:async(...args)=>{sent.push(args);return {messageId:'om_root'};}}});
  assert.equal(await f.platforms.send(allowed,'oc_1',{card:{schema:'2.0'}}),'om_root');assert.deepEqual(sent,[['oc_1',{card:{schema:'2.0'}}]]);
 }finally{f.close();}
});
test('a card click reaches the card handler with its app, whose answer goes back to Feishu; people outside the allowlist and clicks on a disabled app get a toast',()=>{
 const handlers={},clicks=[],f=platformFixture({channelFactory:()=>({on:(name,fn)=>{handlers[name]=fn;}}),onCardAction:(...args)=>{clicks.push(args);return {toast:{type:'info',content:'正在提交'}};}});
 try{
  const a={...allowed,appId:'cli_test',appSecret:'private',domain:'feishu'};f.platforms.channel(a);
  const click=openId=>({messageId:'om_card',chatId:'oc_1',operator:{openId},action:{tag:'button',value:{request:1}}});
  assert.deepEqual(handlers.cardAction(click('ou_user')),{toast:{type:'info',content:'正在提交'}});assert.deepEqual(clicks,[[a,click('ou_user')]]);
  const refused={toast:{type:'error',content:'你不在这个应用的允许名单中，不能处理这个请求'}};
  assert.deepEqual(handlers.cardAction(click('ou_other')),refused);assert.deepEqual(handlers.cardAction({...click('ou_user'),operator:undefined}),refused);
  a.enabled=false;assert.deepEqual(handlers.cardAction(click('ou_user')),refused);assert.equal(clicks.length,1);
 }finally{f.close();}
});
test('message reactions are added and removed through the connected channel and fail without one',async()=>{
 const f=platformFixture(),calls=[];try{
  await assert.rejects(f.platforms.react(allowed,'om_1','OneSecond'),/飞书未连接/);await assert.rejects(f.platforms.unreact(allowed,'om_1','r_1'),/飞书未连接/);
  const channel={getConnectionStatus:()=>({state:'reconnecting'}),addReaction:async(...args)=>{calls.push(['add',...args]);return 'r_1';},removeReaction:async(...args)=>{calls.push(['remove',...args]);}};
  f.platforms.runtime.set('a',{channel});
  await assert.rejects(f.platforms.react(allowed,'om_1','OneSecond'),/飞书未连接/);await assert.rejects(f.platforms.unreact(allowed,'om_1','r_1'),/飞书未连接/);assert.deepEqual(calls,[]);
  channel.getConnectionStatus=()=>({state:'connected'});
  assert.equal(await f.platforms.react(allowed,'om_1','OneSecond'),'r_1');assert.equal(await f.platforms.unreact(allowed,'om_1','r_1'),undefined);
  assert.deepEqual(calls,[['add','om_1','OneSecond'],['remove','om_1','r_1']]);
 }finally{f.close();}
});
// A response body that counts its reads; chunks are strings or buffers.
function body(chunks){const s=new Readable({read(){s.reads++;this.push(chunks.length?Buffer.from(chunks.shift()):null);}});s.reads=0;return s;}
test('a resource of a received message is downloaded through the connected channel with its content type; one whose length exceeds the limit is refused before its body is read, and a Feishu error keeps its code',async()=>{
 const f=platformFixture(),calls=[],answers=[];try{
  await assert.rejects(f.platforms.download(allowed,'om_1',{type:'image',fileKey:'img_1'},10),/飞书未连接/);
  f.platforms.runtime.set('a',{channel:{getConnectionStatus:()=>({state:'connected'}),rawClient:{im:{v1:{messageResource:{get:async o=>{calls.push(o);return answers.shift()();}}}}}}});
  const ok=body(['ab','cd']);answers.push(()=>({headers:{'content-type':'image/PNG; charset=binary','content-length':'4'},getReadableStream:()=>ok}));
  assert.deepEqual(await f.platforms.download(allowed,'om_1',{type:'image',fileKey:'img_1'},10),{body:Buffer.from('abcd'),type:'image/png'});
  assert.deepEqual(calls,[{path:{message_id:'om_1',file_key:'img_1'},params:{type:'image'}}]);
  // The length says too much: nothing of the body is read.
  const big=body(['x'.repeat(11)]);answers.push(()=>({headers:{'content-type':'application/pdf','content-length':'11'},getReadableStream:()=>big}));
  await assert.rejects(f.platforms.download(allowed,'om_2',{type:'file',fileKey:'file_1',fileName:'a.pdf'},10),e=>e.code==='too_large');
  assert.deepEqual([big.reads,big.destroyed,calls[1]],[0,true,{path:{message_id:'om_2',file_key:'file_1'},params:{type:'file'}}]);
  // Without a length, or with a wrong one, the body counts as it comes.
  for(const headers of [{},{'content-length':'3'}]){const s=body(['123456','78901']);answers.push(()=>({headers,getReadableStream:()=>s}));await assert.rejects(f.platforms.download(allowed,'om_3',{type:'image',fileKey:'img_3'},10),e=>e.code==='too_large',JSON.stringify(headers));assert.equal(s.destroyed,true);}
  const exact=body(['1234567890']);answers.push(()=>({headers:{},getReadableStream:()=>exact}));assert.deepEqual(await f.platforms.download(allowed,'om_4',{type:'image',fileKey:'img_4'},10),{body:Buffer.from('1234567890'),type:''});
  // Feishu answers an error with a JSON body, which the stream response carries as a stream.
  answers.push(()=>{throw Object.assign(Error('Request failed with status code 400'),{response:{status:400,data:Readable.from([JSON.stringify({code:234003,msg:'File not in msg.'})])}});});
  await assert.rejects(f.platforms.download(allowed,'om_5',{type:'image',fileKey:'img_x'},10),e=>e.code===234003&&e.message==='飞书接口错误 234003：File not in msg.');
  answers.push(()=>{throw Error('timeout of 10000ms exceeded');});await assert.rejects(f.platforms.download(allowed,'om_6',{type:'image',fileKey:'img_6'},10),/^Error: timeout of 10000ms exceeded$/);
 }finally{f.close();}
});
test('a start failure with a local path and an English Herdr error keeps them out of the Feishu notice',async()=>{
 const f=topicFixture(),raw='no herdr server is running at /home/someone/.config/herdr/herdr.sock; run `herdr server`';try{
  f.h.on['workspace list']=()=>{throw Error(raw);};await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);assert.ok(f.replies.every(r=>!JSON.stringify(r[3]).includes('/home/')&&!JSON.stringify(r[3]).includes('herdr server')));
  assert.equal(f.store.data.topics[0].error,raw);
 }finally{f.close();}
});
test('Herdr commands keep Herdr error codes, honor per-call timeouts and expand ~/ only in path arguments',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-herdr-')),bin=path.join(dir,'herdr');
 fs.writeFileSync(bin,['#!/bin/sh','case "$3" in',
  ` blocked) echo 'warning: noise' >&2; echo '{"id":"cli:agent:prompt","error":{"code":"agent_blocked","message":"agent w1:p1 is blocked"}}' >&2; exit 1;;`,
  ` usage) echo 'agent prompt requires text' >&2; exit 2;;`,
  ` slow) sleep 0.3; echo '{"id":"x","result":{"type":"ok"}}';;`,
  ` cwd) printf '{"result":{"cwd":"%s","text":"%s"}}' "$5" "$6";;`,
  ` text) echo 'not json';;`,
  ` *) echo '{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}';;`,'esac',''].join('\n'),{mode:0o700});
 const m=normalizeMachine({name:'local',type:'local',binary:bin});
 try{
  assert.deepEqual(await herdr(m,['agent','list']),{type:'agent_list',agents:[]});
  await assert.rejects(herdr(m,['blocked']),e=>e.code==='agent_blocked'&&e.message==='agent w1:p1 is blocked');
  await assert.rejects(herdr(m,['usage']),e=>e.code===undefined&&/requires text/.test(e.message));
  await assert.rejects(herdr(m,['slow'],{timeoutMs:100}),/连接超时/);assert.deepEqual(await herdr(m,['slow'],{timeoutMs:5000}),{type:'ok'});
  assert.deepEqual(await herdr(m,['cwd','--cwd',{path:'~/work'},'~/work']),{cwd:os.homedir()+'/work',text:'~/work'});
  await assert.rejects(herdr(m,['text']),/^Error: 远程服务未返回有效 JSON$/);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('makeDirectory creates nested directories on a local machine, succeeds again when they exist and reports what mkdir says on failure',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-mkdir-')),target=path.join(dir,'a','b','c'),m=normalizeMachine({name:'local',type:'local'});
 try{
  await makeDirectory(m,target);assert.ok(fs.statSync(target).isDirectory());
  await makeDirectory(m,target);assert.ok(fs.statSync(target).isDirectory());
  fs.writeFileSync(path.join(dir,'file'),'');await assert.rejects(makeDirectory(m,path.join(dir,'file','x')),/mkdir/);
 }finally{fs.rmSync(dir,{recursive:true});}
});
const mode=p=>fs.statSync(p).mode&0o777;
// Sets the modification time of directory p to n days ago.
const age=(p,n)=>{const t=(Date.now()-n*86400000)/1000;fs.utimesSync(p,t,t);};
// Runs fn with process.env[key] set to value for its duration.
async function withEnv(key,value,fn){const old=process.env[key];process.env[key]=value;try{return await fn();}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}}
// What storeFile does on any machine, given the home directory that ~/ stands for there: files 0600 in directories 0700, a .gitignore of *
// that a person may change, and the clean-up of the other directories of the root.
async function storeFileBehaves(m,home){
 const body=Buffer.concat([Buffer.from("secret-marker ' \" $(id) `id`\n"),Buffer.from([0,255,10])]),root=path.join(home,'work','.herdr-bridge');
 const file=await storeFile(m,'~/work/.herdr-bridge','t1','om_1-1.png',body);
 assert.equal(file,path.join(root,'t1','om_1-1.png'));assert.deepEqual(fs.readFileSync(file),body);
 assert.deepEqual([mode(root),mode(path.join(root,'t1')),mode(file),mode(path.join(root,'.gitignore'))],[0o700,0o700,0o600,0o600]);assert.equal(fs.readFileSync(path.join(root,'.gitignore'),'utf8'),'*\n');
 fs.writeFileSync(path.join(root,'.gitignore'),'*\n!keep\n');
 // Directories of other topics unchanged for more than 7 days go, with what they hold; the topic written to stays however old.
 for(const [dir,days] of [['stale',8],['recent',6],['t1',30]]){fs.mkdirSync(path.join(root,dir),{recursive:true});fs.writeFileSync(path.join(root,dir,'x'),'');age(path.join(root,dir),days);}
 const absolute=path.join(home,'abs dir','.herdr-bridge');
 assert.equal(await storeFile(m,'~/work/.herdr-bridge','t1','om_2-1.pdf',Buffer.from('pdf')),path.join(root,'t1','om_2-1.pdf'));
 assert.deepEqual(fs.readdirSync(root).sort(),['.gitignore','recent','t1']);assert.deepEqual(fs.readdirSync(path.join(root,'t1')).sort(),['om_1-1.png','om_2-1.pdf','x']);assert.equal(fs.readFileSync(path.join(root,'.gitignore'),'utf8'),'*\n!keep\n');
 // An absolute root, here with a space, works the same.
 assert.equal(await storeFile(m,absolute,'t2','om_3-1.jpg',Buffer.from('jpg')),path.join(absolute,'t2','om_3-1.jpg'));assert.equal(fs.readFileSync(path.join(absolute,'t2','om_3-1.jpg'),'utf8'),'jpg');
 // A root that cannot be created fails.
 fs.writeFileSync(path.join(home,'file'),'');await assert.rejects(storeFile(m,path.join(home,'file','.herdr-bridge'),'t3','om_4-1.png',Buffer.from('x')));
 // removeDirectory removes a directory with what it holds; one that is gone already is fine.
 await removeDirectory(m,path.join(root,'t1'));assert.deepEqual(fs.readdirSync(root).sort(),['.gitignore','recent']);await removeDirectory(m,path.join(root,'t1'));
 await removeDirectory(m,'~/work/.herdr-bridge/recent');assert.deepEqual(fs.readdirSync(root),['.gitignore']);
 return body;
}
test('storeFile on a local machine writes a file 0600 in a directory 0700 under a root with a .gitignore that ignores everything, removes the other directories of the root unchanged for 7 days and resolves to its absolute path',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-store-local-')),home=path.join(dir,'home'),m=normalizeMachine({name:'local',type:'local'});
 try{fs.mkdirSync(home);await withEnv('HOME',home,()=>storeFileBehaves(m,home));}finally{fs.rmSync(dir,{recursive:true});}
});
test('storeFile on an SSH machine is one remote command under umask 077 that takes the content on stdin, never on the command line, and prints the absolute path; removeDirectory runs rm -rf there',async()=>{
 // A fake ssh records its arguments and runs the remote command here, with its own home.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-store-ssh-')),bin=path.join(dir,'bin'),home=path.join(dir,'remote home'),args=path.join(dir,'args');
 fs.mkdirSync(bin);fs.mkdirSync(home);
 fs.writeFileSync(path.join(bin,'ssh'),['#!/bin/sh',`printf '%s\\n' "$@" >> ${quote(args)}`,'for last; do :; done',`HOME=${quote(home)} exec sh -c "$last"`,''].join('\n'),{mode:0o700});
 const m=normalizeMachine({name:'cpu2',host:'cpu2'});
 try{
  const body=await withEnv('PATH',bin+':'+process.env.PATH,()=>storeFileBehaves(m,home));
  const lines=fs.readFileSync(args,'utf8');assert.ok(body.includes('secret-marker'));assert.ok(!lines.includes('secret-marker'));
  // Every call is one remote command line: four writes, then three removals.
  const prefix='env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID sh -c ',commands=lines.split('\n').filter(l=>l.startsWith(prefix)).map(l=>l.slice(prefix.length));
  const unquote=s=>{assert.ok(s.startsWith("'")&&s.endsWith("'"),s);return s.slice(1,-1).replaceAll("'\\''","'");};
  assert.equal(commands.length,7);
  // The program is sh with a fixed script; the root, the directory and the name are its arguments, the root's ~/ the remote home.
  const first=unquote(commands[0]);assert.ok(first.startsWith("'sh' '-c' '")&&first.endsWith(`' 'sh' "$HOME"/'work/.herdr-bridge' 't1' 'om_1-1.png'`),first);
  assert.match(first,/umask 077/);assert.match(first,/cat >/);assert.equal(unquote(commands[2]).slice(unquote(commands[2]).lastIndexOf("' 'sh' ")),`' 'sh' ${quote(path.join(home,'abs dir','.herdr-bridge'))} 't2' 'om_3-1.jpg'`);
  assert.deepEqual(commands.slice(4).map(unquote),[`'rm' '-rf' '--' ${quote(path.join(home,'work','.herdr-bridge','t1'))}`,`'rm' '-rf' '--' ${quote(path.join(home,'work','.herdr-bridge','t1'))}`,`'rm' '-rf' '--' "$HOME"/'work/.herdr-bridge/recent'`]);
  // Output that is not the path of the file, such as what a login script of the remote shell prints, fails the write: the path is what
  // removeDirectory later removes.
  fs.writeFileSync(path.join(bin,'ssh'),['#!/bin/sh','echo welcome','for last; do :; done',`HOME=${quote(home)} exec sh -c "$last"`,''].join('\n'),{mode:0o700});
  await withEnv('PATH',bin+':'+process.env.PATH,()=>assert.rejects(storeFile(m,'~/work/.herdr-bridge','t1','om_5-1.png',Buffer.from('x')),/未返回文件路径/));
 }finally{fs.rmSync(dir,{recursive:true});}
});

// Skills for the placement tests in directory src: alpha, with a file in a subdirectory and text that a shell would change, and beta.
function skillSource(src){
 for(const [p,text] of [['alpha/SKILL.md',"---\nname: alpha\n---\nsecret-marker ' \" $(id) `id`\n"],['alpha/ref/notes.md','notes\n'],['beta/SKILL.md','---\nname: beta\n---\n']]){
  fs.mkdirSync(path.dirname(path.join(src,p)),{recursive:true});fs.writeFileSync(path.join(src,p),text);
 }
}
// What directory dir holds, through a link: {relative path: text} of its files.
const tree=dir=>Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const p=path.join(e.parentPath,e.name);return [path.relative(dir,p),fs.readFileSync(p,'utf8')];}));
// What placing the skills of dir/skills does on any machine whose home directory is dir/home; resolves to the number of placements.
async function placeSkillsBehaves(m,dir){
 const home=path.join(dir,'home'),src=path.join(dir,'skills'),store=path.join(home,'.local/share/herdr-bridge/skills'),plain=path.join(home,'plain');let n=0;
 const place=(...args)=>{n++;return skillPlacer(exec,src)(m,...args);};
 // A copy holds the skill and Bridge's marker with the digest of the skills it was copied from.
 const copied=p=>{const {'.herdr-bridge-skill':mark,...rest}=tree(p);assert.match(mark,/^[0-9a-f]{64}\n$/);return rest;};
 skillSource(src);fs.mkdirSync(plain);
 // Claude reads .claude/skills and Codex .agents/skills, here through links to the store of the machine, which holds the skills as Bridge has them.
 assert.deepEqual(await place('~/plain','claude'),[]);assert.deepEqual(await place(plain,'codex'),[]);
 for(const at of ['.claude/skills','.agents/skills'])for(const name of ['alpha','beta'])assert.equal(fs.readlinkSync(path.join(plain,at,name)),path.join(store,name));
 for(const name of ['alpha','beta'])assert.deepEqual(tree(path.join(store,name)),tree(path.join(src,name)));
 // Antigravity follows no link: Bridge's links become real directories with the same content, which Codex then keeps, as both read them.
 assert.deepEqual(await place(plain,'agy'),[]);assert.deepEqual(await place(plain,'codex'),[]);
 for(const name of ['alpha','beta']){const p=path.join(plain,'.agents/skills',name);assert.ok(fs.lstatSync(p).isDirectory(),p);assert.deepEqual(copied(p),tree(path.join(src,name)));}
 // Unchanged content is not written again: what the store and a copy hold stays, each a file of its own, since a copy comes from the store.
 const copy=path.join(plain,'.agents/skills/alpha'),extra=[path.join(store,'alpha','store-extra'),path.join(copy,'copy-extra')];for(const p of extra)fs.writeFileSync(p,'');
 await place(plain,'claude');await place(plain,'agy');
 for(const p of extra)assert.ok(fs.existsSync(p),p);
 // Changed content replaces the store, which every link sees at once, and a copy at its next placement; nothing else is left behind.
 fs.writeFileSync(path.join(src,'alpha/SKILL.md'),'changed\n');fs.rmSync(path.join(src,'alpha/ref'),{recursive:true});
 await place(plain,'claude');assert.deepEqual(tree(path.join(plain,'.claude/skills/alpha')),{'SKILL.md':'changed\n'});assert.deepEqual(fs.readdirSync(path.dirname(store)),['skills']);
 await place(plain,'agy');assert.deepEqual(copied(copy),{'SKILL.md':'changed\n'});
 // Same-name skills that are not Bridge's stay as they are and are reported: a link elsewhere, a directory without Bridge's marker.
 const other=path.join(home,'other'),theirs=path.join(dir,'theirs');fs.mkdirSync(theirs);fs.mkdirSync(path.join(other,'.claude/skills'),{recursive:true});fs.symlinkSync(theirs,path.join(other,'.claude/skills/alpha'));
 fs.mkdirSync(path.join(other,'.agents/skills/beta'),{recursive:true});fs.writeFileSync(path.join(other,'.agents/skills/beta/SKILL.md'),'theirs\n');
 assert.deepEqual(await place(other,'claude'),[path.join(other,'.claude/skills/alpha')]);assert.deepEqual(await place(other,'agy'),[path.join(other,'.agents/skills/beta')]);
 assert.equal(fs.readlinkSync(path.join(other,'.claude/skills/alpha')),theirs);assert.deepEqual(fs.readdirSync(theirs),[]);assert.deepEqual(tree(path.join(other,'.agents/skills/beta')),{'SKILL.md':'theirs\n'});
 assert.ok(fs.lstatSync(path.join(other,'.agents/skills/alpha')).isDirectory());
 // In a Git repository each placed path goes into info/exclude once, as git sees it, and git status stays clean. Here .claude/skills is a
 // link to ../.agents/skills, which holds a skill of the repository's own, beta: Claude's alpha is .agents/skills/alpha to git.
 const repo=path.join(home,'repo'),worktree=path.join(home,'repo-wt'),exclude=path.join(repo,'.git','info','exclude');
 fs.mkdirSync(path.join(repo,'.agents/skills/beta'),{recursive:true});fs.writeFileSync(path.join(repo,'.agents/skills/beta/SKILL.md'),'theirs\n');
 fs.mkdirSync(path.join(repo,'.claude'));fs.symlinkSync('../.agents/skills',path.join(repo,'.claude/skills'));fs.mkdirSync(path.join(repo,'sub'));fs.writeFileSync(path.join(repo,'sub','x'),'');
 git(repo,'init','-q','-b','main');git(repo,'add','.');git(repo,'commit','-q','-m','init');fs.writeFileSync(exclude,'# mine');
 assert.deepEqual(await place(repo,'claude'),[path.join(repo,'.claude/skills/beta')]);assert.equal(fs.readlinkSync(path.join(repo,'.agents/skills/alpha')),path.join(store,'alpha'));
 assert.equal(fs.readFileSync(exclude,'utf8'),'# mine\n/.agents/skills/alpha\n');assert.equal(git(repo,'status','--porcelain'),'');
 // Again, for Codex, and in a linked worktree, which shares info/exclude, nothing is added; a subdirectory adds its own paths.
 git(repo,'worktree','add','-q',worktree,'-b','wt');
 await place(repo,'claude');await place(repo,'codex');await place(worktree,'agy');
 assert.ok(fs.lstatSync(path.join(worktree,'.agents/skills/alpha')).isDirectory());assert.equal(fs.readFileSync(exclude,'utf8'),'# mine\n/.agents/skills/alpha\n');assert.equal(git(worktree,'status','--porcelain'),'');
 await place(path.join(repo,'sub'),'claude');
 assert.equal(fs.readFileSync(exclude,'utf8'),'# mine\n/.agents/skills/alpha\n/sub/.claude/skills/alpha\n/sub/.claude/skills/beta\n');assert.equal(git(repo,'status','--porcelain'),'');
 // A directory where the skills directory cannot be created fails the placement with what failed.
 fs.writeFileSync(path.join(home,'file'),'');await assert.rejects(place(path.join(home,'file'),'claude'),/file/);
 return n;
}
test('placing skills on a local machine links Claude\'s and Codex\'s skills to the store of the machine and copies them for Antigravity, writes only changed content, leaves skills that are not Bridge\'s alone and records the placed paths once in the info/exclude of a Git repository',async()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skills-local-'))),home=path.join(dir,'home'),m=normalizeMachine({name:'local',type:'local'});
 try{fs.mkdirSync(home);await withEnv('HOME',home,()=>placeSkillsBehaves(m,dir));}finally{fs.rmSync(dir,{recursive:true});}
});
test('placing skills on an SSH machine is one remote command, which takes the skills as a tar archive on stdin, never on its command line, and does there what it does locally',async()=>{
 // A fake ssh records its arguments, each ended by a NUL since the script has several lines, and runs the remote command here, with its own home.
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skills-ssh-'))),bin=path.join(dir,'bin'),home=path.join(dir,'home'),args=path.join(dir,'args');
 fs.mkdirSync(bin);fs.mkdirSync(home);
 fs.writeFileSync(path.join(bin,'ssh'),['#!/bin/sh',`printf '%s\\0' "$@" >> ${quote(args)}`,'for last; do :; done',`HOME=${quote(home)} exec sh -c "$last"`,''].join('\n'),{mode:0o700});
 const m=normalizeMachine({name:'cpu2',host:'cpu2'});
 try{
  const n=await withEnv('PATH',bin+':'+process.env.PATH,()=>placeSkillsBehaves(m,dir)),lines=fs.readFileSync(args,'utf8');
  const prefix='env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID sh -c ',commands=lines.split('\0').filter(l=>l.startsWith(prefix)).map(l=>l.slice(prefix.length));
  assert.equal(commands.length,n);assert.ok(!lines.includes('secret-marker'));
  // The program is sh with a fixed script; the store and the working directory are its arguments, whose ~/ is the remote home.
  const first=commands[0].slice(1,-1).replaceAll("'\\''","'");
  assert.ok(first.startsWith("'sh' '-c' '")&&/' 'sh' "\$HOME"\/'\.local\/share\/herdr-bridge\/skills' '[0-9a-f]{64}' '\.claude\/skills' 'link' "\$HOME"\/'plain' 'alpha' 'beta'$/.test(first),first);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('skill placements run one after another on a machine and at once on different machines; each sends the skills of its directory as a tar archive, resolves to the paths the command lists and rejects with what it reports when it fails',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-skills-queue-')),src=path.join(dir,'skills'),calls=[],running={};let most=0,both=false;
 // What the command prints besides the paths, such as what a login script of the remote shell prints, is not a path.
 const fake=async(m,argv,{input})=>{
  calls.push([m.id,argv,input]);running[m.id]=(running[m.id]||0)+1;most=Math.max(most,running[m.id]);both||=Object.values(running).filter(Boolean).length>1;
  await later(20);running[m.id]--;return argv[8].path==='/broken'?{code:1,stdout:'',stderr:'mkdir: cannot create directory\n'}:{code:0,stdout:'welcome\n/w/.claude/skills/beta\n',stderr:''};
 };
 try{
  skillSource(src);const place=skillPlacer(fake,src),one={id:'m1'},two={id:'m2'};
  const results=await Promise.allSettled([place(one,'~/w','claude'),place(one,'/broken','codex'),place(one,'~/w','agy'),place(two,'/w','claude')]);
  assert.deepEqual([most,both],[1,true]);
  assert.deepEqual(results.map(r=>r.status==='fulfilled'?r.value:r.reason.message),[['/w/.claude/skills/beta'],'mkdir: cannot create directory',['/w/.claude/skills/beta'],['/w/.claude/skills/beta']]);
  const on=id=>calls.filter(c=>c[0]===id).map(c=>c[1]),[first,second,third]=on('m1'),input=calls.find(c=>c[0]==='m1')[2];
  assert.deepEqual(first.slice(0,2),['sh','-c']);assert.deepEqual(first.slice(3,5),['sh',{path:'~/.local/share/herdr-bridge/skills'}]);assert.match(first[5],/^[0-9a-f]{64}$/);
  assert.deepEqual(first.slice(6),['.claude/skills','link',{path:'~/w'},'alpha','beta']);assert.deepEqual(second.slice(6,8),['.agents/skills','link']);assert.deepEqual(third.slice(6,8),['.agents/skills','copy']);
  assert.deepEqual(execFileSync('tar',['-tf','-'],{input,encoding:'utf8'}).split('\n').filter(e=>e&&!e.endsWith('/')).sort(),['alpha/SKILL.md','alpha/ref/notes.md','beta/SKILL.md']);
  // The digest follows the content.
  assert.equal(on('m2')[0][5],first[5]);fs.writeFileSync(path.join(src,'beta/SKILL.md'),'changed\n');await place(two,'/w','claude');assert.notEqual(on('m2')[1][5],first[5]);
 }finally{fs.rmSync(dir,{recursive:true});}
});

const coded=(code,message)=>Object.assign(Error(message),{code});
// Git for the throwaway repositories of the tests: without the user's or the system's configuration and the HERDR_* variables, in English.
const gitEnv={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_'))),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',
 GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.com',LC_ALL:'C'};
const git=(cwd,...args)=>execFileSync('git',args,{cwd,env:gitEnv,encoding:'utf8'}).trim();
const gitIn=(cwd,...args)=>spawnSync('git',['-C',cwd,...args],{env:gitEnv,encoding:'utf8'});
// The --name value options of a Herdr command line.
const flags=args=>Object.fromEntries(args.flatMap((a,i)=>a.startsWith('--')&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--')?[[a,args[i+1]]]:[]));
// In-memory Herdr: records every CLI call; h.on['<group> <verb>'] replaces the next such call and may call run(args) for the default result.
// Agents start idle with state_change_seq 1; a prompt returns the agent as it is.
// h.retained[paneId] holds the replies Herdr keeps for the agent of that pane. h.made records every makeDirectory as [machine id, path].
// h.requests[paneId] holds the requests the agent of that pane waits on; an answer removes its request.
// `pane remote-answers <pane> on|off` sets or clears remote_answers on the agent of that pane; turning it on for a pane without an agent fails.
// `pane close <pane>` removes the agent of that pane.
// `api snapshot` returns the agents with h.workspaces, h.tabs and h.panes, the entries that only carry what Bridge reads (ids and labels).
// h.hosts[machine id], when present, is another machine with its own agents, retained replies and requests; every call to a host with
// down fails with that message. h.toolCalls[paneId] holds the tool call records Herdr keeps for the agent of that pane; `agent send-keys`
// only succeeds. `worktree create`, `list` and `remove` run the real git on the throwaway repositories of the tests, as Herdr does: create
// adds the worktree and opens a workspace for it, which h.workspaces lists with its checkout and repository; list reports the workspace
// open for each worktree; remove removes the worktree of an open workspace and closes it.
function fakeHerdr(){
 const h={calls:[],timeouts:[],machines:[],workspaces:[],tabs:[],panes:[],agents:[],retained:{},requests:{},toolCalls:{},hosts:{},made:[],created:0,opened:0,on:{}};
 const run=(args,host=h)=>{
  const [group,verb]=args;
  if(group==='workspace'&&verb==='list')return {type:'workspace_list',workspaces:h.workspaces};
  if(group==='workspace'&&verb==='create'){const id='w'+ ++h.created,n=++h.opened;h.workspaces.push({workspace_id:id,label:args[5]});return {type:'workspace_created',workspace:{workspace_id:id},tab:{tab_id:`${id}:t${n}`},root_pane:{pane_id:`${id}:p${n}`}};}
  if(group==='tab'&&verb==='rename')return {type:'tab_info',tab:{tab_id:args[2],label:args[3]}};
  if(group==='tab'&&verb==='create'){const n=++h.opened;return {type:'tab_created',tab:{tab_id:`${args[3]}:t${n}`},root_pane:{pane_id:`${args[3]}:p${n}`}};}
  if(group==='agent'&&verb==='start'){const agent={name:args[2],agent:args[4],pane_id:args[6],agent_status:'idle',state_change_seq:1};h.agents.push(agent);return {type:'agent_started',agent,argv:[args[4]]};}
  if(group==='agent'&&verb==='list')return {type:'agent_list',agents:host.agents};
  if(group==='api'&&verb==='snapshot')return {type:'session_snapshot',snapshot:{workspaces:host.workspaces||[],tabs:host.tabs||[],panes:host.panes||[],agents:host.agents}};
  if(group==='agent'&&verb==='prompt')return {type:'agent_prompted',agent:host.agents.find(a=>a.pane_id===args[2])};
  if(group==='agent'&&verb==='replies'){const after=args[3]==='--after'?Number(args[4]):0;return {type:'agent_replies',agent:host.agents.find(a=>a.pane_id===args[2]),replies:(host.retained[args[2]]||[]).filter(r=>r.seq>after)};}
  if(group==='agent'&&verb==='requests')return {type:'agent_requests',agent:host.agents.find(a=>a.pane_id===args[2]),requests:host.requests[args[2]]||[]};
  if(group==='agent'&&verb==='tool-calls'){const after=args[3]==='--after'?Number(args[4]):0;return {type:'agent_tool_calls',agent:host.agents.find(a=>a.pane_id===args[2]),tool_calls:(host.toolCalls?.[args[2]]||[]).filter(c=>c.seq>after)};}
  if(group==='agent'&&verb==='send-keys')return {type:'ok'};
  if(group==='agent'&&verb==='answer'){
   const waiting=host.requests[args[2]]||[],r=waiting.find(x=>String(x.id)===args[3]);if(!r)throw coded('request_not_found','request not found');
   host.requests[args[2]]=waiting.filter(x=>x!==r);return {type:'agent_answered',agent:host.agents.find(a=>a.pane_id===args[2])};
  }
  if(group==='pane'&&verb==='close'){host.agents=host.agents.filter(a=>a.pane_id!==args[2]);return {type:'ok'};}
  if(group==='pane'&&verb==='remote-answers'){
   const agent=host.agents.find(a=>a.pane_id===args[2]);if(args[3]==='on'&&!agent)throw coded('agent_not_found',`pane ${args[2]} has no agent`);
   if(agent){if(args[3]==='on')agent.remote_answers=true;else delete agent.remote_answers;}return {type:'ok'};
  }
  if(group==='worktree'&&verb==='create'){
   const o=flags(args),local=gitIn(o['--cwd'],'show-ref','--verify','--quiet','refs/heads/'+o['--branch']).status===0;fs.mkdirSync(path.dirname(o['--path']),{recursive:true});
   const r=gitIn(o['--cwd'],'worktree','add',...local?[o['--path'],o['--branch']]:['-b',o['--branch'],o['--path'],o['--base']||'HEAD']);if(r.status!==0)throw coded('worktree_create_failed',r.stderr.trim());
   const id='w'+ ++h.created,n=++h.opened;h.workspaces.push({workspace_id:id,label:o['--branch'],checkout:o['--path'],repo:o['--cwd']});
   return {type:'worktree_created',workspace:{workspace_id:id},tab:{tab_id:`${id}:t${n}`},root_pane:{pane_id:`${id}:p${n}`},worktree:{path:o['--path'],branch:o['--branch'],is_linked_worktree:true,open_workspace_id:id}};
  }
  if(group==='worktree'&&verb==='list'){
   const r=gitIn(flags(args)['--cwd'],'worktree','list','--porcelain');if(r.status!==0)throw coded('not_git_worktree',r.stderr.trim());
   return {type:'worktree_list',worktrees:r.stdout.trim().split('\n\n').map(block=>{
    const field=k=>block.split('\n').find(l=>l.startsWith(k+' '))?.slice(k.length+1),checkout=field('worktree'),open=h.workspaces.find(w=>w.checkout===checkout);
    return {path:checkout,branch:field('branch')?.replace('refs/heads/',''),...open&&{open_workspace_id:open.workspace_id}};
   })};
  }
  if(group==='worktree'&&verb==='remove'){
   const w=h.workspaces.find(x=>x.workspace_id===args[3]&&x.checkout);if(!w)throw coded('workspace_not_found',`workspace ${args[3]} not found`);
   const r=gitIn(w.repo,'worktree','remove',w.checkout);if(r.status!==0)throw coded(/contains modified or untracked files/.test(r.stderr)?'dirty_worktree_requires_force':'worktree_remove_failed',r.stderr.trim());
   h.workspaces=h.workspaces.filter(x=>x!==w);return {type:'worktree_removed',workspace_id:w.workspace_id,path:w.checkout,forced:false};
  }
  throw Error('unexpected herdr '+args.join(' '));
 };
 h.herdr=async(m,args,options={})=>{
  h.calls.push(args);h.timeouts.push(options.timeoutMs);h.machines.push(m.id);await null;const host=h.hosts[m.id]||h;if(host.down)throw Error(host.down);
  const key=args[0]+' '+args[1],hook=h.on[key];if(hook){delete h.on[key];return hook(args,a=>run(a,host));}return run(args,host);
 };
 h.makeDirectory=async(m,dir)=>{h.made.push([m.id,dir]);await null;};
 return h;
}
// Calls as [machine id, ...args].
const callsOn=f=>f.h.calls.map((c,i)=>[f.h.machines[i],...c]);
const cotPath='/open-apis/im/v1/message_cot';
// The binding's machine m is cpu2; machines are further machines of the store. f.api records the Feishu OpenAPI requests of the topics,
// the COT calls: a COT is created as c<n> in message om_cot_<n>. With cot false Feishu refuses every request, like for an app without the
// scope. restart() reads the state file into a new Topics with the same fakes, as after a Bridge restart. now, when given, is the clock of the
// topics.
// f.downloads records every attachment download as [app id, message id, type, file key, limit]; f.resources[file key], when present,
// answers it, an error by throwing it, else the body is 'data:<file key>' of type image/png. f.stored records every file written as
// [machine id, root, dir, name, body as text], which resolves to its path with ~/ as /home/u/; f.removed every directory removed as
// [machine id, dir]. f.execs records every other command run on a machine (see exec in core.mjs) as [machine id, ...argv]: claude answers
// from f.h.claude, by default with BRANCH=feat/add-login, as {code, stdout, stderr} or an Error to reject with, and f.naming records each of
// its calls as {argv, input, timeoutMs, shell}; anything else, git and test, runs here for real (see gitEnv). f.placed records every placement
// of Bridge's skills as [machine id, directory, agent kind, number of Herdr calls made before it]; it resolves to f.h.placing, by default
// no skills of others, or rejects with it when it is an Error.
function topicFixture({binding,machine,machines=[],cot=true,now}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-topics-')),store=new Store(dir),h=fakeHerdr(),replies=[],reacted=[],unreacted=[],updated=[],api=[],m={id:'m',name:'cpu2',enabled:true,...machine};
 const downloads=[],resources={},stored=[],removed=[],execs=[],naming=[],placed=[];
 store.data.machines=[m,...machines];store.data.bindings=[{...route,...binding}];store.save();const b=store.data.bindings[0];let sent=0,cots=0;
 // Every reply resolves to the next message id om_bot_<n>.
 const deps={herdr:h.herdr,makeDirectory:h.makeDirectory,machine:id=>{const x=store.data.machines.find(y=>y.id===id);if(!x)throw Error('机器连接不存在');return x;},app:id=>{if(id!==allowed.id)throw Error('应用不存在');return allowed;},
  download:async(a,messageId,r,limit)=>{downloads.push([a.id,messageId,r.type,r.fileKey,limit]);await null;const x=resources[r.fileKey];if(x instanceof Error)throw x;return x||{body:Buffer.from('data:'+r.fileKey),type:'image/png'};},
  storeFile:async(m,root,dir,name,body)=>{stored.push([m.id,root,dir,name,String(body)]);await null;return root.replace(/^~\//,'/home/u/')+'/'+dir+'/'+name;},
  removeDirectory:async(m,dir)=>{removed.push([m.id,dir]);await null;},
  placeSkills:async(m,cwd,kind)=>{placed.push([m.id,cwd,kind,h.calls.length]);await null;if(h.placing instanceof Error)throw h.placing;return h.placing||[];},
  exec:async(m,argv,options={})=>{
   execs.push([m.id,...argv]);await null;const args=argv.map(a=>typeof a==='string'?a:a.path);
   if(args.some(a=>/\bclaude\b/.test(a))){naming.push({argv,input:options.input,timeoutMs:options.timeoutMs,shell:options.shell});if(h.claude instanceof Error)throw h.claude;return {code:0,stdout:'BRANCH=feat/add-login\n',stderr:'',...h.claude};}
   const r=spawnSync(args[0],args.slice(1),{env:gitEnv,encoding:'utf8'});return {code:r.status,stdout:r.stdout,stderr:r.stderr};
  },
  reply:async(a,chatId,rootId,content)=>{replies.push([a.id,chatId,rootId,content]);return 'om_bot_'+ ++sent;},
  react:async(a,messageId,emojiType)=>{reacted.push([a.id,messageId,emojiType]);return 'r_'+messageId;},unreact:async(a,messageId,reactionId)=>{unreacted.push([a.id,messageId,reactionId]);},
  updateCard:async(a,messageId,card)=>{updated.push([a.id,messageId,card]);},
  request:async(a,o)=>{api.push(o);await null;if(!cot)throw Object.assign(Error('飞书接口错误 99991672：Access denied'),{code:99991672});return o.method==='POST'&&o.url===cotPath?{cot_id:'c'+ ++cots,message_id:'om_cot_'+cots}:{};},...now&&{now}};
 const topics=new Topics(store,deps);
 const send=msg=>topics.handle(allowed,b,{senderType:'user',senderId:'ou_user',chatId:'oc_1',rawContentType:'text',...msg});
 const restart=()=>{const s=new Store(dir);return {store:s,topics:new Topics(s,deps)};};
 return {dir,store,h,m,topics,replies,reacted,unreacted,updated,api,downloads,resources,stored,removed,execs,naming,placed,b,send,restart,close(){fs.rmSync(dir,{recursive:true});}};
}
// The COT calls of fixture f in order: ['create', message the COT answers], ['update', cot id, ...[event type, event]] and ['complete', cot
// id, reason].
const cotLog=f=>f.api.map(o=>o.method==='PUT'?['update',o.data.cot_id,...o.data.events.map(e=>[e.event_type,JSON.parse(e.content)])]
 :o.url.startsWith(cotPath+'/complete/')?['complete',o.url.slice(cotPath.length+'/complete/'.length),o.params.reason]:['create',o.data.origin_message_id]);
const cotLogs=f=>f.store.data.logs.filter(l=>l.kind==='执行过程').map(l=>[l.level,l.message]);
// An agent list with the agents of fixture f as they are, changed by fields.
const list=(f,fields)=>f.h.agents.map(a=>({...a,...fields}));
const later=ms=>new Promise(r=>setTimeout(r,ms));
test('a new topic creates the binding workspace, names its root tab after the topic, starts the agent there with a longer timeout, turns on remote answers for its pane and prompts it',async()=>{
 const f=topicFixture(),text='请帮我修复登录页在移动端点击提交按钮后没有任何反应的问题',title=text.slice(0,24);try{
  await f.send({messageId:'om_1',content:' '+text+'\n'});
  const [t]=f.store.data.topics,{id,agentName,createdAt,...rest}=t;
  assert.equal(agentName,'feishu-'+id.slice(0,8));assert.match(agentName,/^feishu-[0-9a-f]{8}$/);assert.ok(createdAt>0);
  assert.deepEqual(f.h.calls,[['workspace','list'],['workspace','create','--cwd',{path:'~/work'},'--label','飞书 · 个人助手','--no-focus'],['tab','rename','w1:t1',title],['agent','start',agentName,'--kind','claude','--pane','w1:p1','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p1','on'],['agent','prompt','w1:p1',text]]);
  assert.deepEqual(f.h.timeouts,[undefined,undefined,undefined,70000,undefined,undefined]);assert.deepEqual([...new Set(f.h.machines)],['m']);assert.equal(f.h.agents[0].remote_answers,true);
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',title,state:'ready',error:'',messageIds:['om_1'],replySeq:0,reactions:[],cards:[],
   cot:{cotId:'c1',messageId:'om_cot_1',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false}});
  assert.equal(new Store(f.dir).data.bindings[0].workspaceId,'w1');assert.equal(new Store(f.dir).data.topics[0].state,'ready');
  assert.deepEqual(f.replies,[]);assert.deepEqual(f.store.data.logs.map(l=>[l.kind,l.level,l.message]),[['话题会话','info',`个人助手：已在 cpu2 启动 ${agentName}`],['消息投递','info',`bot → 个人助手：已发送到 ${agentName}`]]);
 }finally{f.close();}
});
test('another topic opens a tab in the same workspace and turns on remote answers for its pane; replies in a topic prompt its pane without a new tab',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'第一个话题'});await f.send({messageId:'om_2',content:'第二个\n  话题'});
  const second=f.store.data.topics[1];
  assert.deepEqual(f.h.calls.slice(6),[['workspace','list'],['tab','create','--workspace','w1','--cwd',{path:'~/work'},'--label','第二个 话题','--no-focus'],['agent','start',second.agentName,'--kind','claude','--pane','w1:p2','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p2','on'],['agent','prompt','w1:p2','第二个\n  话题']]);
  assert.deepEqual([second.rootId,second.tabId,second.title],['om_2','w1:t2','第二个 话题']);
  f.h.calls.length=0;await f.send({messageId:'om_3',rootId:'om_1',content:'继续第一个'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','继续第一个']]);
  assert.equal(f.store.data.topics.length,2);assert.deepEqual(f.store.data.topics[0].messageIds,['om_1','om_3']);assert.deepEqual(f.replies,[]);
  // The first prompted message of each topic has its COT instead of a reaction.
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_1','om_2','om_3']);assert.deepEqual(f.store.data.topics.map(t=>[t.cot.origin,t.reactions.map(r=>r.messageId)]),[['om_1',['om_3']],['om_2',[]]]);
 }finally{f.close();}
});
test('a Claude binding starts each topic agent with -- --permission-mode and its mode, default when the binding has none; a Codex binding starts its agent with -- --no-daemon; an Antigravity binding passes nothing on',async()=>{
 for(const [binding,args] of [[{},['--','--permission-mode','default']],[{permissionMode:'default'},['--','--permission-mode','default']],[{permissionMode:'auto'},['--','--permission-mode','auto']],[{kind:'codex'},['--','--no-daemon']],[{kind:'agy'},[]]]){
  const f=topicFixture({binding});try{
   await f.send({messageId:'om_1',content:'one'});
   assert.deepEqual(f.h.calls.filter(c=>c[1]==='start'),[['agent','start',f.store.data.topics[0].agentName,'--kind',f.b.kind,'--pane','w1:p1','--timeout','60000',...args]],JSON.stringify(binding));
  }finally{f.close();}
 }
});
test('a changed permission mode applies to the topics opened afterwards; a running topic keeps its agent',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});setPermissionMode(f.b,'auto');
  await f.send({messageId:'om_2',rootId:'om_1',content:'more'});await f.send({messageId:'om_3',content:'two'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='start').map(c=>c.slice(-3)),[['--','--permission-mode','default'],['--','--permission-mode','auto']]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[2]),['w1:p1','w1:p1','w1:p2']);
 }finally{f.close();}
});
test('a message id is persisted before any Herdr call and handled at most once; each topic keeps its latest 50 ids',async()=>{
 const f=topicFixture();try{
  let saved;f.h.on['workspace list']=(args,run)=>{saved=JSON.parse(fs.readFileSync(path.join(f.dir,'state.json'),'utf8')).topics;return run(args);};
  const msg={messageId:'om_1',content:'hi'};await Promise.all([f.send(msg),f.send(msg)]);await f.send(msg);
  assert.deepEqual(saved.map(t=>[t.state,t.messageIds]),[['starting',['om_1']]]);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);
  for(let i=2;i<=51;i++)await f.send({messageId:'om_'+i,rootId:'om_1',content:'m'+i});
  const ids=f.store.data.topics[0].messageIds;assert.equal(ids.length,50);assert.deepEqual([ids[0],ids.at(-1)],['om_2','om_51']);
 }finally{f.close();}
});
test('messages that arrive while a topic is starting share its tab and are prompted in order',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=async(args,run)=>{await later(20);return run(args);};
  await Promise.all([f.send({messageId:'om_1',content:'first'}),f.send({messageId:'om_2',rootId:'om_1',content:'second'}),f.send({messageId:'om_3',rootId:'om_1',content:'third'})]);
  assert.equal(f.store.data.topics.length,1);assert.equal(f.h.calls.filter(c=>c[1]==='create'||c[1]==='start').length,2);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['first','second','third']);
 }finally{f.close();}
});
test('topics opened at the same time create the binding workspace once',async()=>{
 const f=topicFixture();try{
  f.h.on['workspace create']=async(args,run)=>{await later(20);return run(args);};
  await Promise.all([f.send({messageId:'om_1',content:'one'}),f.send({messageId:'om_2',content:'two'})]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='create').map(c=>c[0]),['workspace','tab']);assert.deepEqual(f.store.data.topics.map(t=>t.paneId),['w1:p1','w1:p2']);
 }finally{f.close();}
});
test('a closed workspace is created again for the next new topic',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});f.h.workspaces.length=0;f.h.calls.length=0;
  await f.send({messageId:'om_2',content:'two'});
  assert.deepEqual(f.h.calls.slice(0,4).map(c=>c.slice(0,2)),[['workspace','list'],['workspace','create'],['tab','rename'],['agent','start']]);
  assert.equal(f.b.workspaceId,'w2');assert.equal(f.store.data.topics[1].paneId,'w2:p2');
 }finally{f.close();}
});
test('a workspace id that Herdr reassigned to another workspace is not reused; a new workspace is created',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});f.h.workspaces[0].label='用户自己的工作区';f.h.calls.length=0;
  await f.send({messageId:'om_2',content:'two'});
  assert.deepEqual(f.h.calls.slice(0,3),[['workspace','list'],['workspace','create','--cwd',{path:'~/work'},'--label','飞书 · 个人助手','--no-focus'],['tab','rename','w2:t2','two']]);
  assert.equal(f.h.calls.some(c=>c[0]==='tab'&&c[1]==='create'),false);assert.deepEqual([f.b.workspaceId,f.store.data.topics[1].paneId],['w2','w2:p2']);
 }finally{f.close();}
});
test('each new topic creates its working directory on the machine before any workspace call, whether it creates the workspace or a tab in it',async()=>{
 const f=topicFixture();try{
  const seen=[],before=(args,run)=>{seen.push([...f.h.made]);return run(args);};
  f.h.on['workspace list']=before;await f.send({messageId:'om_1',content:'one'});
  f.h.on['workspace list']=before;await f.send({messageId:'om_2',content:'two'});
  assert.deepEqual(seen,[[['m','~/work']],[['m','~/work'],['m','~/work']]]);assert.deepEqual(f.h.calls.filter(c=>c[1]==='create').map(c=>c[0]),['workspace','tab']);
  // A message in a ready topic opens no tab and creates nothing.
  await f.send({messageId:'om_3',rootId:'om_1',content:'three'});assert.equal(f.h.made.length,2);
 }finally{f.close();}
});
test('a working directory that cannot be created fails the start like any start failure, before any workspace or tab is created',async()=>{
 const f=topicFixture(),raw="mkdir: cannot create directory '/srv/app': Permission denied";try{
  f.topics.makeDirectory=async()=>{throw Error(raw);};
  await f.send({messageId:'om_1',content:'one'});
  const t=f.store.data.topics[0];assert.deepEqual([t.state,t.error],['failed',raw]);assert.equal(new Store(f.dir).data.topics[0].state,'failed');
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);
  assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);assert.match(f.store.data.logs.at(-1).message,/启动失败.*Permission denied/);
 }finally{f.close();}
});
const skillLogs=f=>f.store.data.logs.filter(l=>l.kind==='skill').map(l=>[l.level,l.message]);
test('right before a new topic starts its agent, Bridge\'s skills are placed for the binding\'s agent kind in its working directory on its machine: in a new workspace, in a tab of the existing one and in a topic that begin opens; a message in a ready topic places nothing',async()=>{
 for(const kind of ['claude','codex','agy']){
  const f=topicFixture({binding:{kind}});try{
   await f.send({messageId:'om_1',content:'one'});await f.send({messageId:'om_2',content:'two'});
   await f.topics.begin(allowed,f.b,'om_root',{title:'报告',msg:{messageId:'om_root',content:'写报告'}}).delivered;
   await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
   const starts=f.h.calls.flatMap((c,i)=>c[1]==='start'?[i]:[]);assert.equal(starts.length,3);
   assert.deepEqual(f.placed,starts.map(i=>['m','~/work',kind,i]),kind);assert.deepEqual(skillLogs(f),[]);
  }finally{f.close();}
 }
});
test('a placement of skills that fails is only logged, and the topic starts and prompts its agent as usual; same-name skills that are not Bridge\'s are logged as left alone',async()=>{
 const f=topicFixture(),raw="mkdir: cannot create directory '/home/u/work/.claude': Permission denied";try{
  f.h.placing=Error(raw);await f.send({messageId:'om_1',content:'one'});
  assert.equal(f.store.data.topics[0].state,'ready');assert.deepEqual(f.h.calls.at(-1),['agent','prompt','w1:p1','one']);assert.deepEqual(f.replies,[]);
  f.h.placing=['/home/u/work/.claude/skills/bridge-schedule'];await f.send({messageId:'om_2',content:'two'});
  assert.equal(f.store.data.topics[1].state,'ready');
  assert.deepEqual(skillLogs(f),[['error',`个人助手：未能在 ~/work 放置 skill，${raw}`],['info','个人助手：/home/u/work/.claude/skills/bridge-schedule 已有同名 skill，不是 Bridge 放的，没有改动']]);
 }finally{f.close();}
});
test('a topic whose named agent is gone is closed with one notice and gets no further prompts',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',content:'one'});
  f.h.agents.splice(0,1,{name:'someone-else',pane_id:'w1:p1',agent_status:'idle'});f.h.calls.length=0;f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.equal(f.store.data.topics[0].state,'closed');
  assert.deepEqual(f.replies,[['a','oc_1','om_1',notice('该话题的会话已结束，请发起新话题')]]);
 }finally{f.close();}
});
test('a failed start marks the topic failed with a notice that carries no error details; the next message retries in a new tab',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=()=>{throw coded('agent_pane_busy','agent target pane w1:p1 is not an available shell');};
  await f.send({messageId:'om_1',content:'one'});
  const t=f.store.data.topics[0];assert.deepEqual([t.state,t.error],['failed','agent target pane w1:p1 is not an available shell']);assert.equal(new Store(f.dir).data.topics[0].state,'failed');
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);assert.match(f.store.data.logs.at(-1).message,/agent target pane w1:p1 is not an available shell/);assert.equal(f.h.calls.some(c=>c[1]==='prompt'),false);
  f.h.calls.length=0;await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.h.calls,[['workspace','list'],['tab','create','--workspace','w1','--cwd',{path:'~/work'},'--label','one','--no-focus'],['agent','start',t.agentName,'--kind','claude','--pane','w1:p2','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p2','on'],['agent','prompt','w1:p2','two']]);
  assert.deepEqual([t.state,t.error,t.paneId,f.store.data.topics.length],['ready','','w1:p2',1]);
 }finally{f.close();}
});
test('a topic on a disconnected machine fails without calling Herdr',async()=>{
 const f=topicFixture({machine:{enabled:false}});try{
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual([f.h.calls,f.store.data.topics[0].state,f.store.data.topics[0].error,f.replies.map(r=>r[3])],[[],'failed','机器连接已停用',[notice('启动失败，请在 Bridge 管理台查看原因')]]);
 }finally{f.close();}
});
test('agent_not_ready at start still opens the topic after turning on remote answers; agent_blocked sends a notice; other prompt errors are only logged',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=(args,run)=>{run(args);throw coded('agent_not_ready','agent is blocked during startup and is not ready for prompts');};
  f.h.on['agent prompt']=()=>{throw coded('agent_blocked','agent w1:p1 is blocked and requires interactive input');};
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(f.h.calls.slice(3,5).map(c=>c.slice(0,2)),[['agent','start'],['pane','remote-answers']]);assert.equal(f.h.agents[0].remote_answers,true);
  assert.equal(f.store.data.topics[0].state,'ready');assert.deepEqual(f.replies.map(r=>r[3]),[notice('Agent 正在等待确认，请到 Herdr 中处理后重发这条消息')]);
  f.h.on['agent prompt']=()=>{throw coded('agent_prompt_failed','pty closed');};f.replies.length=0;const logs=f.store.data.logs.length;
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.replies,[]);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,2);assert.equal(f.store.data.topics[0].state,'ready');
  const errors=f.store.data.logs.slice(logs);assert.equal(errors.length,1);assert.equal(errors[0].level,'error');assert.match(errors[0].message,/pty closed/);
 }finally{f.close();}
});
test('remote answers are turned on while the topic is still starting, after its agent started; a topic whose pane cannot get them fails to start',async()=>{
 const f=topicFixture();try{
  let during;f.h.on['pane remote-answers']=(args,run)=>{during=[f.store.data.topics[0].state,f.h.agents.map(a=>a.pane_id)];return run(args);};
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(during,['starting',['w1:p1']]);assert.equal(f.store.data.topics[0].state,'ready');
  f.h.on['pane remote-answers']=()=>{throw coded('agent_not_found','pane w1:p2 has no agent');};
  await f.send({messageId:'om_2',content:'two'});
  const t=f.store.data.topics[1];assert.deepEqual([t.state,t.error],['failed','pane w1:p2 has no agent']);
  assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);
 }finally{f.close();}
});
test('a binding that requires the mention ignores every message without it, a follow-up in a topic thread too: it is not recorded and gets no reaction, prompt, notice or COT',async()=>{
 const f=topicFixture({binding:{requireMention:true}});try{
  await f.send({messageId:'om_1',content:'no mention'});assert.deepEqual([f.store.data.topics.length,f.h.calls.length],[0,0]);
  await f.send({messageId:'om_2',content:'with mention',mentionedBot:true});const t=f.store.data.topics[0];
  f.h.calls.length=0;f.reacted.length=0;f.api.length=0;delete t.cot;
  await f.send({messageId:'om_3',rootId:'om_2',content:'follow-up'});
  assert.deepEqual([f.h.calls,f.reacted,f.replies,f.api,t.messageIds,new Store(f.dir).data.topics[0].messageIds],[[],[],[],[],['om_2'],['om_2']]);
  await f.send({messageId:'om_4',rootId:'om_2',content:'mentioned follow-up',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','mentioned follow-up']]);assert.deepEqual(t.messageIds,['om_2','om_4']);
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_4']);assert.deepEqual(cotLog(f)[0],['create','om_4']);
 }finally{f.close();}
});
test('a binding without the mention requirement, which every direct chat has, handles messages without the mention: a root message, a follow-up in its thread and /stop',async()=>{
 const f=topicFixture({binding:{requireMention:false}});try{
  await f.send({messageId:'om_1',content:'one'});await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  f.h.agents[0].agent_status='working';await f.send({messageId:'om_3',rootId:'om_1',content:'/stop'});
  assert.deepEqual(f.h.calls.filter(c=>['prompt','send-keys'].includes(c[1])),[['agent','prompt','w1:p1','one'],['agent','prompt','w1:p1','two'],['agent','send-keys','w1:p1','esc']]);
  assert.deepEqual(f.store.data.topics[0].messageIds,['om_1','om_2','om_3']);
 }finally{f.close();}
});
test('begin opens a topic of the binding under any root message, also one the bot posted, and gives its agent a text: the record is on disk before anything is awaited, nothing gets a reaction, the COT answers the root and the given fields go into the record',async()=>{
 const f=topicFixture();try{
  const {topic,delivered}=f.topics.begin(allowed,f.b,'om_root',{title:'每天的报告',msg:{messageId:'om_root',content:' 写一份报告\n'},fields:{scheduled:{id:'s1',n:1}}});
  assert.deepEqual(f.store.data.topics,[topic]);assert.deepEqual(new Store(f.dir).data.topics.map(t=>[t.rootId,t.state,t.messageIds,t.scheduled]),[['om_root','starting',['om_root'],{id:'s1',n:1}]]);
  const agent=await delivered;
  assert.equal(agent.pane_id,'w1:p1');assert.deepEqual([topic.state,topic.title,topic.chatId,topic.machineId],['ready','每天的报告','oc_1','m']);
  assert.deepEqual(f.h.calls.slice(2),[['tab','rename','w1:t1','每天的报告'],['agent','start',topic.agentName,'--kind','claude','--pane','w1:p1','--timeout','60000','--','--permission-mode','default'],['pane','remote-answers','w1:p1','on'],['agent','prompt','w1:p1','写一份报告']]);
  assert.deepEqual([f.reacted,f.replies],[[],[]]);assert.deepEqual(cotLog(f)[0],['create','om_root']);assert.equal(topic.cot.origin,'om_root');
  // A topic that fails to start resolves to nothing.
  f.h.on['agent start']=()=>{throw coded('agent_pane_busy','busy');};
  assert.equal(await f.topics.begin(allowed,f.b,'om_root2',{title:'x',msg:{messageId:'om_root2',content:'x'}}).delivered,undefined);assert.equal(f.store.data.topics[1].state,'failed');
 }finally{f.close();}
});
test('a message of a person in a topic that a schedule opened records when it came; other topics record nothing new',async()=>{
 let clock=1000;const f=topicFixture({now:()=>clock});try{
  const {topic}=f.topics.begin(allowed,f.b,'om_root',{title:'t',msg:{messageId:'om_root',content:'task'},fields:{scheduled:{id:'s1',n:1}}});await f.topics.queue(topic,()=>{});
  assert.equal(topic.createdAt,1000);assert.equal(topic.scheduled.messageAt,undefined);
  clock=5000;await f.send({messageId:'om_2',rootId:'om_root',content:'追问'});
  assert.deepEqual(topic.scheduled,{id:'s1',n:1,messageAt:5000});assert.equal(new Store(f.dir).data.topics[0].scheduled.messageAt,5000);
  await f.send({messageId:'om_3',content:'own topic'});await f.send({messageId:'om_4',rootId:'om_3',content:'more'});
  assert.equal('scheduled' in f.store.data.topics[1],false);assert.equal(f.store.data.topics[1].createdAt,5000);
 }finally{f.close();}
});
test('retiring a ready topic closes the pane of its agent, which takes its tab along, and then ends the topic with the notice given; a topic whose agent is gone ends without closing anything, and a pane that cannot be closed leaves the topic as it was',async()=>{
 const f=topicFixture();try{
  for(const [i,content] of ['one','two','three'].entries())await f.send({messageId:'om_'+(i+1),content});
  const [one,two,three]=f.store.data.topics;f.h.calls.length=0;f.replies.length=0;f.api.length=0;
  await f.topics.retire(one,'已关闭');
  assert.deepEqual(f.h.calls,[['agent','list'],['pane','close','w1:p1']]);assert.equal(one.state,'closed');assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',notice('已关闭')]]);
  assert.deepEqual(cotLog(f).map(c=>c[0]),['update','complete']);assert.equal(one.cot,undefined);assert.deepEqual(f.store.data.logs.at(-1).message,`${one.agentName}：已关闭 pane w1:p1`);
  // The pane id of an agent that is gone may name another pane by now.
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w1:p2');f.h.calls.length=0;f.replies.length=0;
  await f.topics.retire(two,'已关闭');
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.equal(two.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[notice('该话题的会话已结束，请发起新话题')]);
  f.h.on['pane close']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};f.replies.length=0;
  await f.topics.retire(three,'已关闭');
  assert.equal(three.state,'ready');assert.deepEqual(f.replies,[]);assert.deepEqual(f.store.data.logs.at(-1).message,`${three.agentName}：未能关闭 pane，连接超时，请检查 SSH 与 Herdr 状态`);
  // A topic that is not ready is left alone.
  f.h.calls.length=0;await f.topics.retire(one,'已关闭');assert.deepEqual(f.h.calls,[]);
 }finally{f.close();}
});
test('topics still starting when Bridge restarts are marked failed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-topics-'));try{
  const store=new Store(dir);store.data.topics=[{id:'t1',state:'starting',error:''},{id:'t2',state:'ready',error:''},{id:'t3',state:'choosing',error:'',adopted:{picker:'om_card'}}];store.save();
  new Topics(new Store(dir),{herdr:async()=>{},machine:()=>{},reply:async()=>{}});
  assert.deepEqual(new Store(dir).data.topics.map(t=>[t.state,t.error]),[['failed','Bridge 重启时 Agent 启动未完成'],['ready',''],['choosing','']]);
 }finally{fs.rmSync(dir,{recursive:true});}
});
const attachmentLogs=f=>f.store.data.logs.filter(l=>l.kind==='附件').map(l=>[l.level,l.message]);
test('the images and files of a message are downloaded and written into the topic directory under the binding working directory before the prompt, which names them by absolute path where they were; the title leaves them out',async()=>{
 const f=topicFixture();try{
  let before;const capture=()=>{f.h.on['agent prompt']=(args,run)=>{before=[...f.stored];return run(args);};};capture();
  f.resources.file_g={body:Buffer.from('log'),type:'text/plain'};
  await f.send({messageId:'om_1',rawContentType:'post',content:'看看这个报错 \n![image](img_b)\n<file key="file_g" name="日志 1.log"/>',resources:[{type:'image',fileKey:'img_b'},{type:'file',fileKey:'file_g',fileName:'日志 1.log'}]});
  const t=f.store.data.topics[0],dir=`/home/u/work/.herdr-bridge/${t.id}`;
  assert.deepEqual(f.downloads,[['a','om_1','image','img_b',limits.image],['a','om_1','file','file_g',limits.file]]);
  assert.deepEqual(f.stored,[['m','~/work/.herdr-bridge',t.id,'om_1-1.png','data:img_b'],['m','~/work/.herdr-bridge',t.id,'om_1-2.log','log']]);assert.deepEqual(before,f.stored);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt'),[['agent','prompt','w1:p1',`看看这个报错 \n[图片 1：${dir}/om_1-1.png]\n[文件 1：日志 1.log，${dir}/om_1-2.log]`]]);
  assert.deepEqual([t.title,f.h.calls[2]],['看看这个报错',['tab','rename','w1:t1','看看这个报错']]);
  assert.equal(t.attachmentDir,dir);assert.equal(new Store(f.dir).data.topics[0].attachmentDir,dir);assert.deepEqual(f.replies,[]);assert.deepEqual(attachmentLogs(f),[]);
  // In the ready topic, an image alone; then text, which downloads nothing.
  f.h.calls.length=0;capture();await f.send({messageId:'om_2',rootId:'om_1',...imageOf('img_c')});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1',`[图片 1：${dir}/om_2-1.png]`]]);assert.equal(before.length,3);
  await f.send({messageId:'om_3',rootId:'om_1',content:'谢谢'});assert.deepEqual([f.downloads.length,f.stored.length],[3,3]);
  // A topic that an image alone opens is called 图片.
  await f.send({messageId:'om_4',...imageOf('img_d')});assert.equal(f.store.data.topics[1].title,'图片');assert.deepEqual(f.stored.at(-1).slice(2,4),[f.store.data.topics[1].id,'om_4-1.png']);
 }finally{f.close();}
});
test('an attachment that cannot be downloaded, exceeds its limit or cannot be written is named as failed in the prompt, which still goes out after one notice in the topic; the details are only logged',async()=>{
 const f=topicFixture();try{
  Object.assign(f.resources,{img_big:coded('too_large','超过上限'),img_gone:coded(234003,'飞书接口错误 234003：File not in msg.'),file_big:coded('too_large','超过上限')});
  const store=f.topics.storeFile;f.topics.storeFile=async(m,root,dir,name,body)=>{if(name==='om_1-5.txt')throw Error('sh: 1: cannot create w: Permission denied');return store(m,root,dir,name,body);};
  let noticed;f.h.on['agent prompt']=(args,run)=>{noticed=f.replies.length;return run(args);};
  await f.send({messageId:'om_1',rawContentType:'post',content:'四个附件\n![image](img_ok)![image](img_big)![image](img_gone)\n<file key="file_big" name="big.zip"/>\n<file key="file_w" name="w.txt"/>',
   resources:[{type:'image',fileKey:'img_ok'},{type:'image',fileKey:'img_big'},{type:'image',fileKey:'img_gone'},{type:'file',fileKey:'file_big',fileName:'big.zip'},{type:'file',fileKey:'file_w',fileName:'w.txt'}]});
  const t=f.store.data.topics[0],dir=`/home/u/work/.herdr-bridge/${t.id}`;
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),[`四个附件\n[图片 1：${dir}/om_1-1.png][图片 2：下载失败][图片 3：下载失败]\n[文件 1：下载失败]\n[文件 2：下载失败]`]);
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',notice('未能把附件交给 Agent：图片 2 超过 10 MB，图片 3 下载失败，文件 1 超过 30 MB，文件 2 写入失败')]]);assert.equal(noticed,1);
  assert.deepEqual(attachmentLogs(f),[['error',`${t.agentName}：图片 2 超过 10 MB，超过上限`],['error',`${t.agentName}：图片 3 下载失败，飞书接口错误 234003：File not in msg.`],['error',`${t.agentName}：文件 1 超过 30 MB，超过上限`],['error',`${t.agentName}：文件 2 写入失败，sh: 1: cannot create w: Permission denied`]]);
  assert.equal(t.attachmentDir,dir);assert.equal(t.state,'ready');assert.deepEqual(cotLog(f)[0],['create','om_1']);
  // Nothing written: the topic has no attachment directory.
  await f.send({messageId:'om_2',...imageOf('img_gone')});const other=f.store.data.topics[1];
  assert.equal(f.h.calls.filter(c=>c[1]==='prompt').at(-1)[3],'[图片 1：下载失败]');assert.equal(other.attachmentDir,undefined);assert.deepEqual(f.replies.at(-1).slice(2),['om_2',notice('未能把附件交给 Agent：图片 1 下载失败')]);
 }finally{f.close();}
});
test('a kind of message that Bridge cannot forward gets a notice in its thread and opens no topic; in a binding that requires the mention only when it mentions the bot',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',...sticker});
  assert.deepEqual([f.store.data.topics,f.h.calls,f.reacted,f.downloads],[[],[],[],[]]);assert.deepEqual(f.replies,[['a','oc_1','om_1',notice(unsupportedText)]]);
  await f.send({messageId:'om_2',content:'hi'});f.replies.length=0;f.h.calls.length=0;f.reacted.length=0;
  await f.send({messageId:'om_3',rootId:'om_2',rawContentType:'merge_forward',content:'<forwarded_messages/>',resources:[]});
  assert.deepEqual([f.replies,f.h.calls,f.reacted,f.store.data.topics[0].messageIds],[[['a','oc_1','om_2',notice(unsupportedText)]],[],[],['om_2']]);
  f.topics.reply=async()=>{throw Error('飞书未连接');};await f.send({messageId:'om_4',...sticker});assert.match(f.store.data.logs.at(-1).message,/飞书未连接/);
 }finally{f.close();}
 const g=topicFixture({binding:{requireMention:true}});try{
  await g.send({messageId:'om_1',...sticker});assert.deepEqual(g.replies,[]);
  await g.send({messageId:'om_2',...sticker,mentionedBot:true});assert.deepEqual([g.replies,g.store.data.topics],[[['a','oc_1','om_2',notice(unsupportedText)]],[]]);
 }finally{g.close();}
});
test('the attachment directory of a topic is removed when the topic ends and when its binding is removed, then also for a topic whose removal failed before; a failure is only logged and a topic without attachments removes nothing',async()=>{
 const f=topicFixture();try{
  await f.send({messageId:'om_1',...imageOf('img_1')});await f.send({messageId:'om_2',content:'没有附件'});await f.send({messageId:'om_3',...imageOf('img_3')});await f.send({messageId:'om_4',...imageOf('img_4')});
  const [one,two,three,four]=f.store.data.topics,dirOf=t=>`/home/u/work/.herdr-bridge/${t.id}`;
  // The agents of the first two topics exit.
  f.h.agents=f.h.agents.filter(a=>!['w1:p1','w1:p2'].includes(a.pane_id));await f.topics.sync(f.m,f.h.agents);
  assert.deepEqual([one.state,two.state],['closed','closed']);assert.deepEqual(f.removed,[['m',dirOf(one)]]);assert.equal(one.attachmentDir,undefined);assert.equal(new Store(f.dir).data.topics[0].attachmentDir,undefined);
  // A removal that fails keeps the record for the next try.
  f.topics.removeDirectory=async()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w1:p3');await f.topics.sync(f.m,f.h.agents);
  assert.deepEqual([three.state,three.attachmentDir],['closed',dirOf(three)]);assert.deepEqual(attachmentLogs(f),[['error',`${three.agentName}：未能删除附件目录，连接超时，请检查 SSH 与 Herdr 状态`]]);
  f.topics.removeDirectory=async(m,dir)=>{f.removed.push([m.id,dir]);};f.h.calls.length=0;
  await f.topics.unbind('b');
  assert.deepEqual(f.removed.slice(1).sort(),[['m',dirOf(three)],['m',dirOf(four)]].sort());assert.deepEqual(f.h.calls,[['pane','remote-answers','w1:p4','off']]);assert.deepEqual(f.store.data.topics,[]);
 }finally{f.close();}
});

// A ready topic whose agent runs in w1:p1, with the COT c1 of its first message om_1 open unless the fixture options refuse it;
// snapshot(seq) is an agent list in which that agent reports reply_seq seq. om_1 mentions the bot, as a binding that requires it needs.
async function readyTopic(options){
 const f=topicFixture(options);await f.send({messageId:'om_1',content:'one',mentionedBot:true});f.h.calls.length=0;f.replies.length=0;f.api.length=0;
 return {...f,t:f.store.data.topics[0],snapshot:reply_seq=>f.h.agents.map(a=>({...a,reply_seq}))};
}
const forwarded=f=>f.store.data.logs.filter(l=>l.kind==='回复转发').map(l=>[l.level,l.message]);
test('new replies of a topic agent are fetched after the stored seq and sent in order into its thread as cards without a header, whose summary is the beginning of the reply with its whitespace collapsed; a topic without a seq counts from 0',async()=>{
 const f=await readyTopic();try{
  delete f.t.replySeq;f.h.retained['w1:p1']=[{seq:1,text:'**第一条**'},{seq:2,text:'第二条\n\n- 列表'}];
  await f.topics.sync(f.m,f.snapshot(2));
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','0']]);
  assert.deepEqual(f.replies,[['a','oc_1','om_1',replyOf('**第一条**')],['a','oc_1','om_1',replyOf('第二条\n\n- 列表','第二条 - 列表')]]);assert.equal(new Store(f.dir).data.topics[0].replySeq,2);
  f.h.retained['w1:p1'].push({seq:5,text:'第三条'});f.h.calls.length=0;f.replies.length=0;
  await f.topics.sync(f.m,f.snapshot(5));
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','2']]);assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('第三条')]);assert.equal(f.t.replySeq,5);
  assert.deepEqual(forwarded(f),Array(3).fill(['info',`个人助手：已转发 ${f.t.agentName} 的回复`]));assert.ok(!JSON.stringify(f.store.data.logs).includes('第一条'));
 }finally{f.close();}
});
test('an unchanged reply_seq, or an agent without one from an older Herdr, calls nothing and sends nothing',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:3,text:'x'}];f.t.replySeq=3;
  await f.topics.sync(f.m,f.snapshot(3));await f.topics.sync(f.m,f.h.agents);delete f.t.replySeq;await f.topics.sync(f.m,f.h.agents);
  assert.deepEqual([f.h.calls,f.replies],[[],[]]);
 }finally{f.close();}
});
test('syncs with the same snapshot fetch the replies once',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:1,text:'a'},{seq:2,text:'b'}];const snapshot=f.snapshot(2);
  await Promise.all([f.topics.sync(f.m,snapshot),f.topics.sync(f.m,snapshot)]);await f.topics.sync(f.m,snapshot);
  assert.equal(f.h.calls.length,1);assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('a'),replyOf('b')]);
 }finally{f.close();}
});
test('each reply seq is on disk before its send; a failed send is logged once, not retried, and the seq still advances',async()=>{
 const f=await readyTopic();try{
  const seen=[];f.topics.reply=async(a,chatId,rootId,{card})=>{seen.push([markdownIn(card),new Store(f.dir).data.topics[0].replySeq]);if(markdownIn(card)==='一')throw Error('飞书未连接');};
  f.h.retained['w1:p1']=[{seq:1,text:'一'},{seq:2,text:'二'}];
  await f.topics.sync(f.m,f.snapshot(2));await f.topics.sync(f.m,f.snapshot(2));
  assert.deepEqual(seen,[['一',1],['二',2]]);assert.equal(f.h.calls.length,1);assert.equal(f.t.replySeq,2);
  assert.deepEqual(forwarded(f),[['error',`个人助手：${f.t.agentName} 的回复未发出，飞书未连接`],['info',`个人助手：已转发 ${f.t.agentName} 的回复`]]);
 }finally{f.close();}
});
test('a reply_seq below the stored one, after Herdr restarted and counts from 1 again, fetches all replies and sends those up to the snapshot',async()=>{
 const f=await readyTopic();try{
  f.t.replySeq=7;f.h.retained['w1:p1']=[{seq:1,text:'一'},{seq:2,text:'二'},{seq:3,text:'快照之后'}];
  await f.topics.sync(f.m,f.snapshot(2));
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1']]);assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('一'),replyOf('二')]);assert.equal(f.t.replySeq,2);
  f.h.calls.length=0;await f.topics.sync(f.m,f.snapshot(3));
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','2']]);assert.deepEqual(f.replies.at(-1)[3],replyOf('快照之后'));
 }finally{f.close();}
});
test('a truncated reply ends with a note pointing to Herdr, in plain text after its markdown',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:1,text:'很长的回复',truncated:true},{seq:2,text:'完整的回复',truncated:false}];
  await f.topics.sync(f.m,f.snapshot(2));
  assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('很长的回复','很长的回复',truncatedNote),replyOf('完整的回复')]);
 }finally{f.close();}
});
// The bytes of the request that sends card into a thread: the card serialized, as the content string of a serialized body.
const requestBytes=card=>Buffer.byteLength(JSON.stringify({content:JSON.stringify(card),msg_type:'interactive',reply_in_thread:true}));
test('a card fits a message when its request stays within 30 KB, counting what serializing it twice adds',()=>{
 // A quote takes 4 bytes serialized twice: 6900 of them fit, 7100 do not.
 const of=n=>card('标题','blue',[plain('"'.repeat(n))]);
 assert.equal(fits(of(6900)),true);assert.ok(requestBytes(of(6900))<30*1000);assert.equal(fits(of(7100)),false);
});
test('a reply too large for one card goes out as several cards in order, each request within 30 KB however much its text grows when serialized twice; a code block split between cards is closed and opened again with its info string, a line too long for a card is cut, and only the last card has the truncation note',async()=>{
 const f=await readyTopic();try{
  // Serialized twice, a quote or backslash takes 4 bytes and a CJK character 3.
  const code=Array.from({length:700},(_,i)=>`const path${i} = "C:\\\\路径\\\\${i}";`),long='"'.repeat(12000);
  const text=['开头的说明','```ts',...code,'```','代码之后',long,'结尾'].join('\n');assert.ok(Buffer.byteLength(text)<=64*1024);
  f.h.retained['w1:p1']=[{seq:1,text,truncated:true}];await f.topics.sync(f.m,f.snapshot(1));
  const cards=f.replies.map(r=>r[3].card),parts=cards.map(markdownIn),lines=parts.flatMap(p=>p.split('\n'));
  assert.ok(cards.length>2);assert.deepEqual([f.t.replySeq,forwarded(f)],[1,[['info',`个人助手：已转发 ${f.t.agentName} 的回复`]]]);
  for(const [i,card] of cards.entries()){
   assert.ok(requestBytes(card)<=30000,`card ${i}: ${requestBytes(card)} bytes`);assert.equal(card.header,undefined);assert.equal(card.config.width_mode,'fill');
   const summary=card.config.summary.content;assert.ok([...summary].length<=100&&parts[i].replace(/\s+/g,' ').trim().startsWith(summary.replace(/…$/,'')),`card ${i}: ${summary}`);
   // Every card opens and closes its code blocks.
   assert.equal(parts[i].split('\n').filter(l=>l.startsWith('```')).length%2,0,`card ${i}`);
   assert.deepEqual(card.body.elements.slice(1),i===cards.length-1?[truncatedNote]:[],`card ${i}`);
  }
  // Splitting does not waste the room of a card.
  assert.ok(requestBytes(cards[0])>20000);
  assert.ok(parts[0].startsWith('开头的说明\n```ts\nconst path0 ')&&parts[0].endsWith('\n```'));assert.ok(parts[1].startsWith('```ts\nconst '));assert.ok(parts.at(-1).endsWith('\n结尾'));
  // No code line is lost or cut; the long line is cut into pieces that start cards and add up to it.
  assert.deepEqual(lines.filter(l=>l.startsWith('const ')),code);
  const pieces=lines.filter(l=>/^"+$/.test(l));assert.ok(pieces.length>1);assert.equal(pieces.join(''),long);for(const piece of pieces)assert.ok(parts.some(p=>p.startsWith(piece)));
  assert.deepEqual(lines.filter(l=>!l.startsWith('const ')&&!/^"+$/.test(l)&&!l.startsWith('```')),['开头的说明','代码之后','结尾']);
 }finally{f.close();}
});
test('a card that fails ends its reply: the cards after it are dropped, nothing is sent again and the next reply still goes out',async()=>{
 const f=await readyTopic();try{
  const reply=f.topics.reply;let calls=0;f.topics.reply=async(...args)=>{if(++calls===2)throw Error('飞书未连接');return reply(...args);};
  f.h.retained['w1:p1']=[{seq:1,text:Array(300).fill('"'.repeat(100)).join('\n')},{seq:2,text:'下一条'}];
  await f.topics.sync(f.m,f.snapshot(2));await f.topics.sync(f.m,f.snapshot(2));
  assert.equal(calls,3);assert.equal(f.replies.length,2);assert.ok(markdownIn(f.replies[0][3].card).startsWith('"'.repeat(100)+'\n'));assert.deepEqual(f.replies[1][3],replyOf('下一条'));
  assert.equal(f.t.replySeq,2);assert.deepEqual(forwarded(f),[['error',`个人助手：${f.t.agentName} 的回复只发出了前 1 张卡片，飞书未连接`],['info',`个人助手：已转发 ${f.t.agentName} 的回复`]]);
 }finally{f.close();}
});
test('sync forwards replies only for ready topics of its machine, bridge-opened or adopted, whose pane has an agent with remote answers on, whatever its name',async()=>{
 const f=topicFixture();try{
  const topic={bindingId:'b',appId:'a',chatId:'oc_1',machineId:'m',paneId:'w1:p1',agentName:'feishu-1',state:'ready',replySeq:0};
  f.store.data.topics=[{...topic,id:'ready',rootId:'om_ready'},...['closed','failed','starting','choosing'].map(state=>({...topic,id:state,rootId:'om_'+state,state})),{...topic,id:'elsewhere',rootId:'om_elsewhere',machineId:'m2'},
   {...topic,id:'adopted',rootId:'om_adopted',paneId:'w1:p4',agentName:'review',adopted:{picker:'om_card',kind:'claude'}}];
  f.h.retained={'w1:p1':[{seq:1,text:'hi'}],'w1:p4':[{seq:1,text:'adopted hi'}]};
  await f.topics.sync(f.m,[{name:'someone-else',pane_id:'w1:p1',reply_seq:1,remote_answers:true},{pane_id:'w1:p4',reply_seq:1,remote_answers:true}]);
  assert.deepEqual(f.h.calls,[['agent','replies','w1:p1','--after','0'],['agent','replies','w1:p4','--after','0']]);
  assert.deepEqual(f.replies,[['a','oc_1','om_ready',replyOf('hi')],['a','oc_1','om_adopted',replyOf('adopted hi')]]);
 }finally{f.close();}
});
const endedNotice=notice('该话题的会话已结束，请发起新话题'),adoptedGone=notice('被接管的 Agent 已退出、已更换或所在 pane 已关闭，话题已结束接管');
test('a ready topic ends in sync with one notice once a fresh agent list confirms that its pane closed or its agent no longer has remote answers on; a stale list ends nothing',async()=>{
 const f=await readyTopic();try{
  const t=f.t,agent=f.h.agents[0];assert.equal(agent.remote_answers,true);
  // A list taken before remote answers were turned on: the fresh list still has them.
  await f.topics.sync(f.m,[{...agent,remote_answers:undefined}]);await f.topics.sync(f.m,[]);
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','list']]);assert.equal(t.state,'ready');assert.deepEqual(f.replies,[]);
  // Herdr clears the setting when the agent exits or changes: a list without it ends the topic.
  f.h.calls.length=0;delete agent.remote_answers;
  await Promise.all([f.topics.sync(f.m,f.h.agents),f.topics.sync(f.m,f.h.agents)]);await f.topics.sync(f.m,f.h.agents);
  assert.equal(t.state,'closed');assert.equal(new Store(f.dir).data.topics[0].state,'closed');assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',endedNotice]]);
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);
 }finally{f.close();}
});
test('sync runs in the topic queue after a message being prompted, and skips a topic that such a message closed',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:1,text:'done'}];f.h.on['agent prompt']=async(args,run)=>{await later(20);return run(args);};
  await Promise.all([f.send({messageId:'om_2',rootId:'om_1',content:'two'}),f.topics.sync(f.m,f.snapshot(1))]);
  assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)),[['agent','list'],['agent','prompt'],['agent','replies']]);assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('done')]);
  const snapshot=f.snapshot(2);f.h.agents.length=0;f.h.calls.length=0;
  await Promise.all([f.send({messageId:'om_3',rootId:'om_1',content:'three'}),f.topics.sync(f.m,snapshot)]);
  assert.deepEqual(f.h.calls,[['agent','list']]);assert.equal(f.t.state,'closed');assert.equal(f.t.replySeq,1);
 }finally{f.close();}
});
test('a queued reply fetch whose binding was removed meanwhile sends nothing',async()=>{
 const f=await readyTopic();try{
  f.h.retained['w1:p1']=[{seq:1,text:'done'}];f.h.on['agent prompt']=async(args,run)=>{await later(20);return run(args);};
  const done=Promise.all([f.send({messageId:'om_2',rootId:'om_1',content:'two'}),f.topics.sync(f.m,f.snapshot(1))]);
  f.store.data.bindings=[];f.store.data.topics=[];await done;
  assert.deepEqual(f.h.calls.map(c=>c[1]),['list','prompt']);assert.deepEqual(f.replies,[]);
 }finally{f.close();}
});

const onDisk=f=>new Store(f.dir).data.topics[0].reactions;
test('every message a topic accepts gets a OneSecond reaction at once, even while an earlier message is still starting the agent; the first one prompted trades it for its COT; no start notice is sent',async()=>{
 const f=topicFixture();try{
  let during;f.h.on['agent start']=async(args,run)=>{await later(20);during=f.reacted.map(r=>r[1]);return run(args);};
  await Promise.all([f.send({messageId:'om_1',content:'one'}),f.send({messageId:'om_2',rootId:'om_1',content:'two'})]);
  assert.deepEqual(during,['om_1','om_2']);assert.deepEqual(f.reacted,[['a','om_1','OneSecond'],['a','om_2','OneSecond']]);
  assert.deepEqual(f.replies,[]);assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);assert.deepEqual(onDisk(f).map(r=>r.messageId),['om_2']);
  assert.deepEqual(cotLog(f).filter(c=>c[0]==='create'),[['create','om_1']]);
  await f.send({messageId:'om_1',content:'one'});assert.equal(f.reacted.length,2);
 }finally{f.close();}
});
test('a reaction is recorded on disk without a state seq, which becomes the state_change_seq that the prompt returned',async()=>{
 const f=topicFixture({cot:false});try{
  let before;f.h.on['agent prompt']=(args,run)=>{before=onDisk(f);const r=run(args);return {...r,agent:{...r.agent,state_change_seq:7}};};
  await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(before,[{messageId:'om_1',reactionId:'r_om_1',stateSeq:null}]);assert.deepEqual(onDisk(f),[{messageId:'om_1',reactionId:'r_om_1',stateSeq:7}]);assert.deepEqual(f.unreacted,[]);
 }finally{f.close();}
});
test('sync removes the reaction of a turn that has ended: the agent is idle or done and has changed state since the prompt',async()=>{
 const f=await readyTopic({cot:false});try{
  const agent=(agent_status,state_change_seq)=>[{...f.h.agents[0],agent_status,state_change_seq}];
  // A message still waiting for its prompt keeps its reaction whatever the agent does.
  f.t.reactions.push({messageId:'om_waiting',reactionId:'r_waiting',stateSeq:null});
  for(const snapshot of [agent('working',5),agent('blocked',5),agent('unknown',5),agent('idle',1),agent('done',1),[{...agent('done',5)[0],name:'someone-else',remote_answers:undefined}],[]])await f.topics.sync(f.m,snapshot);
  assert.deepEqual(f.unreacted,[]);assert.deepEqual(onDisk(f).map(r=>r.messageId),['om_1']);assert.equal(f.t.reactions.length,2);
  await f.topics.sync(f.m,agent('done',2));
  assert.deepEqual(f.unreacted,[['a','om_1','r_om_1']]);assert.deepEqual(onDisk(f),[{messageId:'om_waiting',reactionId:'r_waiting',stateSeq:null}]);
  f.t.reactions=[];await f.send({messageId:'om_2',rootId:'om_1',content:'two'});f.unreacted.length=0;
  await f.topics.sync(f.m,agent('idle',3));await f.topics.sync(f.m,agent('idle',3));
  assert.deepEqual(f.unreacted,[['a','om_2','r_om_2']]);assert.deepEqual(onDisk(f),[]);assert.deepEqual(f.h.calls.filter(c=>c[1]==='replies'),[]);
 }finally{f.close();}
});
test('when a snapshot has new replies and ends a turn, the replies are sent before the reaction is removed',async()=>{
 const f=await readyTopic({cot:false});try{
  const events=[];f.topics.reply=async(a,chatId,rootId,{card})=>{events.push('reply '+markdownIn(card));};f.topics.unreact=async(a,messageId)=>{events.push('unreact '+messageId);};
  f.h.retained['w1:p1']=[{seq:1,text:'a'},{seq:2,text:'b'}];
  await f.topics.sync(f.m,f.h.agents.map(a=>({...a,agent_status:'done',state_change_seq:3,reply_seq:2})));
  assert.deepEqual(events,['reply a','reply b','unreact om_1']);
 }finally{f.close();}
});
test('a message that is not prompted loses its reaction: failed start, blocked agent, prompt error or closed topic',async()=>{
 const f=topicFixture();try{
  f.h.on['agent start']=()=>{throw coded('agent_pane_busy','busy');};await f.send({messageId:'om_1',content:'one'});
  f.h.on['agent prompt']=()=>{throw coded('agent_blocked','blocked');};await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  f.h.on['agent prompt']=()=>{throw coded('agent_prompt_failed','pty closed');};await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因'),notice('Agent 正在等待确认，请到 Herdr 中处理后重发这条消息')]);
  assert.deepEqual(f.unreacted,[['a','om_1','r_om_1'],['a','om_2','r_om_2'],['a','om_3','r_om_3']]);assert.deepEqual(onDisk(f),[]);
  const t=f.store.data.topics[0];t.state='closed';f.h.calls.length=0;await f.send({messageId:'om_4',rootId:'om_1',content:'four'});
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.unreacted.at(-1),['a','om_4','r_om_4']);assert.deepEqual(onDisk(f),[]);
 }finally{f.close();}
});
test('a topic closed because its agent is gone loses every reaction',async()=>{
 const f=await readyTopic({cot:false});try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});f.t.reactions.push({messageId:'om_waiting',reactionId:'r_waiting',stateSeq:null});
  f.h.agents.length=0;await f.send({messageId:'om_3',rootId:'om_1',content:'three'});
  assert.equal(f.t.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[notice('该话题的会话已结束，请发起新话题')]);
  assert.deepEqual(f.unreacted.map(r=>r[1]).sort(),['om_1','om_2','om_3','om_waiting']);assert.equal(f.unreacted.length,4);assert.deepEqual(onDisk(f),[]);
 }finally{f.close();}
});
test('a reaction Feishu refuses is logged and the message is still prompted without a record',async()=>{
 const f=topicFixture();try{
  f.topics.react=async()=>{throw Error('飞书未连接');};await f.send({messageId:'om_1',content:'one'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['one']);assert.deepEqual(onDisk(f),[]);assert.deepEqual(f.unreacted,[]);
  const t=f.store.data.topics[0];assert.deepEqual(f.store.data.logs.filter(l=>l.kind==='消息表情').map(l=>[l.level,l.message]),[['error',`${t.agentName}：未能贴上表情，飞书未连接`]]);
 }finally{f.close();}
});
test('a message still settles without rejecting when its turn seq cannot be saved',async()=>{
 const f=topicFixture();try{
  const save=f.store.save.bind(f.store);let failed=0;
  f.store.save=()=>{if(!failed&&f.store.data.topics[0]?.reactions?.[0]?.stateSeq!=null){failed++;throw Error('disk full');}save();};
  await f.send({messageId:'om_1',content:'one'});
  assert.equal(failed,1);assert.deepEqual([f.store.data.logs.at(-1).level,f.store.data.logs.at(-1).kind],['error','消息投递']);assert.match(f.store.data.logs.at(-1).message,/disk full/);
 }finally{f.close();}
});
test('a removal Feishu refuses is logged once and its record is dropped anyway',async()=>{
 const f=await readyTopic({cot:false});try{
  let calls=0;f.topics.unreact=async()=>{calls++;throw Error('飞书未连接');};const done=f.h.agents.map(a=>({...a,agent_status:'done',state_change_seq:2}));
  await f.topics.sync(f.m,done);await f.topics.sync(f.m,done);
  assert.equal(calls,1);assert.deepEqual(onDisk(f),[]);assert.deepEqual(f.store.data.logs.filter(l=>l.kind==='消息表情').map(l=>[l.level,l.message]),[['error',`${f.t.agentName}：未能取消表情，飞书未连接`]]);
 }finally{f.close();}
});

// Requests as `agent requests` reports them.
const bash={id:1,kind:'permission',tool_name:'Bash',description:'列出文件',input_preview:'ls -la',decisions:['allow','allow_always','deny']};
const edit={id:2,kind:'permission',tool_name:'Edit',input_preview:'{"file_path":"a.txt"}',decisions:['allow','deny']};
const ask={id:3,kind:'question',tool_name:'AskUserQuestion',input_preview:'{}',questions:[
 {question:'用哪种数据库？',header:'数据库',options:[{label:'PostgreSQL',description:'关系型'},{label:'SQLite'}],multi_select:false},
 {question:'需要哪些功能？',options:[{label:'登录'},{label:'搜索'},{label:'导出'}],multi_select:true}]};
const cardOf=(title,template,elements)=>({schema:'2.0',config:{update_multi:true},header:{title:{tag:'plain_text',content:title},template},body:{elements}});
const expiredCard=title=>cardOf(title,'grey',[plainText('已失效（超时、已在终端处理或本轮已结束）')]);
// Every element with the tag, at any depth.
const find=(x,tag)=>x&&typeof x==='object'?[...x.tag===tag?[x]:[],...Object.values(x).flatMap(v=>find(v,tag))]:[];
// A ready topic whose agent in w1:p1 waits on requests. pending(ids) is an agent list that reports those request ids; cards() the cards
// sent into the thread; value(card,decision) the callback value of a button; click(...) a click by an allowed person; settled() waits for
// the answers that clicks started.
async function requestTopic(...requests){
 const f=await readyTopic();f.h.requests['w1:p1']=requests;
 return {...f,
  pending:(ids=f.h.requests['w1:p1'].map(r=>r.id),fields={})=>f.h.agents.map(a=>({...a,request_ids:ids,...fields})),
  cards:()=>f.replies.filter(r=>r[3].card.header).map(r=>r[3].card),records:()=>new Store(f.dir).data.topics[0].cards,
  value:(card,decision)=>find(card,'button').find(b=>!decision||b.behaviors[0].value.decision===decision).behaviors[0].value,
  click:(messageId,value,formValue,openId='ou_user')=>f.topics.click(allowed,{messageId,chatId:'oc_1',operator:{openId},action:{tag:'button',value,formValue}}),
  settled:()=>Promise.all(f.topics.answering.values()),
 };
}
const cardLogs=f=>f.store.data.logs.filter(l=>l.kind==='请求卡片').map(l=>[l.level,l.message]);
test('each new request gets a card in the topic thread, recorded with its request id, card message and title only after Feishu took it',async()=>{
 const f=await requestTopic(bash,edit);try{
  const reply=f.topics.reply,onDiskAtSend=[];f.topics.reply=async(...args)=>{onDiskAtSend.push(f.records()||[]);return reply(...args);};
  await f.topics.sync(f.m,f.pending());
  assert.deepEqual(f.h.calls,[['agent','requests','w1:p1']]);assert.deepEqual(f.replies.map(r=>r.slice(0,3)),[['a','oc_1','om_1'],['a','oc_1','om_1']]);
  const buttons=(value,...decisions)=>({tag:'column_set',horizontal_spacing:'8px',columns:decisions.map(([content,type,decision])=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value:{...value,decision}}]}]}))});
  const allow=['允许','primary','allow'],always=['总是允许','default','allow_always'],deny=['拒绝','danger','deny'];
  assert.deepEqual(f.cards(),[
   cardOf('权限确认 · Bash','orange',[plainText('列出文件'),plainText('ls -la'),buttons({request:1,check:check(bash),render:1},allow,always,deny)]),
   // "总是允许" only when the request offers it.
   cardOf('权限确认 · Edit','orange',[plainText('{"file_path":"a.txt"}'),buttons({request:2,check:check(edit),render:2},allow,deny)])]);
  assert.deepEqual(onDiskAtSend,[[],[{requestId:1,messageId:'om_bot_1',title:'权限确认 · Bash'}]]);
  assert.deepEqual(f.records(),[{requestId:1,messageId:'om_bot_1',title:'权限确认 · Bash'},{requestId:2,messageId:'om_bot_2',title:'权限确认 · Edit'}]);
  assert.deepEqual(cardLogs(f),[['info',`${f.t.agentName}：已发送请求 #1 的卡片`],['info',`${f.t.agentName}：已发送请求 #2 的卡片`]]);assert.ok(!JSON.stringify(f.store.data.logs).includes('ls -la'));
  // Lists with the recorded ids, or from an older Herdr without request ids, call nothing.
  f.h.calls.length=0;await f.topics.sync(f.m,f.pending());f.t.cards=[];await f.topics.sync(f.m,f.h.agents);
  assert.deepEqual(f.h.calls,[]);assert.equal(f.cards().length,2);assert.deepEqual(f.updated,[]);
 }finally{f.close();}
});
test('a question card lists each question in a form with a single or multi select and an 其他 input, and submits them with one button',async()=>{
 const f=await requestTopic(ask);try{
  await f.topics.sync(f.m,f.pending());
  const options=labels=>labels.map((content,i)=>({text:{tag:'plain_text',content},value:String(i)})),other=i=>({tag:'input',name:'other'+i,width:'fill',placeholder:{tag:'plain_text',content:'其他（填写后以此为准）'}});
  assert.deepEqual(f.cards(),[cardOf('Agent 提问','blue',[{tag:'form',name:'answers',elements:[
   plainText('数据库：用哪种数据库？\n· PostgreSQL：关系型'),{tag:'select_static',name:'q0',width:'fill',placeholder:{tag:'plain_text',content:'选择一项'},options:options(['PostgreSQL','SQLite'])},other(0),
   plainText('需要哪些功能？'),{tag:'multi_select_static',name:'q1',width:'fill',placeholder:{tag:'plain_text',content:'选择一项或多项'},options:options(['登录','搜索','导出'])},other(1),
   {tag:'button',text:{tag:'plain_text',content:'提交'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{request:3,check:check(ask),render:1,questions:2}}]}]}])]);
  assert.deepEqual(f.records(),[{requestId:3,messageId:'om_bot_1',title:'Agent 提问'}]);
 }finally{f.close();}
});
test('Herdr leaves out empty lists and false flags: a question without options has only the 其他 input and is answered by it; a permission without decisions has no buttons',async()=>{
 const open={id:6,kind:'question',tool_name:'AskUserQuestion',input_preview:'{}',questions:[{question:'项目叫什么？'}]},bare={id:7,kind:'permission',tool_name:'Bash',input_preview:'ls'};
 const f=await requestTopic(open,bare);try{
  await f.topics.sync(f.m,f.pending());const [card,plainCard]=f.cards();
  assert.deepEqual(find(card,'form')[0].elements.map(e=>e.tag),['div','input','button']);
  assert.deepEqual(plainCard,cardOf('权限确认 · Bash','orange',[plainText('ls')]));
  assert.deepEqual(f.click('om_bot_1',f.value(card),{}),{toast:{type:'warning',content:'请回答所有问题'}});await f.settled();
  f.click('om_bot_1',f.value(f.updated[0][2]),{other0:'herdr'});await f.settled();
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='answer'),[['agent','answer','w1:p1','6','--answers',JSON.stringify({'项目叫什么？':['herdr']})]]);
 }finally{f.close();}
});
test('a card Feishu refuses is logged and left unrecorded, so the next list sends it again; lists with the same ids send each card once',async()=>{
 const f=await requestTopic(bash);try{
  const reply=f.topics.reply;let refuse=true;f.topics.reply=async(...args)=>{if(refuse)throw Error('飞书未连接');return reply(...args);};
  await f.topics.sync(f.m,f.pending());
  assert.deepEqual(f.records(),[]);assert.deepEqual(cardLogs(f),[['error',`${f.t.agentName}：请求 #1 的卡片未发出，飞书未连接`]]);
  refuse=false;const list=f.pending();await Promise.all([f.topics.sync(f.m,list),f.topics.sync(f.m,list)]);await f.topics.sync(f.m,list);
  assert.equal(f.cards().length,1);assert.deepEqual(f.records(),[{requestId:1,messageId:'om_bot_1',title:'权限确认 · Bash'}]);
  assert.deepEqual(f.h.calls,[['agent','requests','w1:p1'],['agent','requests','w1:p1']]);
 }finally{f.close();}
});
test('a request that agent requests shows but the agent list did not report yet waits for a list that does',async()=>{
 const f=await requestTopic(bash,edit);try{
  await f.topics.sync(f.m,f.pending([1]));assert.deepEqual(f.records().map(c=>c.requestId),[1]);
  await f.topics.sync(f.m,f.pending([1,2]));assert.deepEqual(f.records().map(c=>c.requestId),[1,2]);assert.equal(f.cards().length,2);
 }finally{f.close();}
});
test('the card of a request that ended outside Feishu shows 已失效 with its title; the record is dropped before the update, which is not repeated',async()=>{
 const f=await requestTopic(bash,edit,ask);try{
  await f.topics.sync(f.m,f.pending());f.h.calls.length=0;
  let onDiskAtUpdate;const update=f.topics.updateCard;f.topics.updateCard=async(...args)=>{onDiskAtUpdate=f.records();return update(...args);};
  await f.topics.sync(f.m,f.pending([2,3]));
  assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')]]);assert.deepEqual(onDiskAtUpdate.map(c=>c.requestId),[2,3]);assert.deepEqual(f.h.calls,[]);
  f.topics.updateCard=async()=>{throw Error('飞书未连接');};
  await f.topics.sync(f.m,f.pending([3]));await f.topics.sync(f.m,f.pending([3]));
  assert.deepEqual(f.records().map(c=>c.requestId),[3]);assert.deepEqual(cardLogs(f).filter(l=>l[0]==='error'),[['error',`${f.t.agentName}：请求 #2 的卡片未能更新，飞书未连接`]]);
  // An agent missing from the list waits on nothing.
  f.topics.updateCard=update;await f.topics.sync(f.m,[]);
  assert.deepEqual(f.updated.at(-1),['a','om_bot_3',expiredCard('Agent 提问')]);assert.deepEqual(f.records(),[]);
 }finally{f.close();}
});
test('a topic closed because its agent is gone marks its cards 已失效',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());f.h.agents.length=0;await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.equal(f.t.state,'closed');assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')]]);assert.deepEqual(f.records(),[]);
 }finally{f.close();}
});
test('a click gets its toast at once; the decision then goes to Herdr outside the topic queue and the card shows it with the person, without buttons',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  // A message whose prompt hangs holds the topic queue.
  let release;f.h.on['agent prompt']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
  const message=f.send({messageId:'om_2',rootId:'om_1',content:'two'});await later(5);f.h.calls.length=0;
  assert.deepEqual(f.click('om_bot_1',f.value(card,'allow')),{toast:{type:'info',content:'正在提交'}});assert.equal(f.h.calls.some(c=>c[1]==='answer'),false);
  await f.settled();
  assert.deepEqual(f.h.calls,[['agent','requests','w1:p1'],['agent','answer','w1:p1','1','--decision','allow']]);
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('权限确认 · Bash','green',[plainText('列出文件'),plainText('ls -la'),{tag:'markdown',content:'已允许 · <at id=ou_user></at>'}])]]);
  assert.deepEqual(f.records(),[]);assert.deepEqual(cardLogs(f).at(-1),['info',`${f.t.agentName}：请求 #1 已在飞书中回答`]);
  release();await message;assert.equal(f.topics.answering.size,0);
 }finally{f.close();}
});
test('拒绝 tells the agent that the person refused in Feishu; 总是允许 is passed on as allow_always',async()=>{
 const f=await requestTopic(bash,{...bash,id:4});try{
  await f.topics.sync(f.m,f.pending());const [first,second]=f.cards();
  f.click('om_bot_1',f.value(first,'deny'));f.click('om_bot_2',f.value(second,'allow_always'));await f.settled();
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='answer'),[['agent','answer','w1:p1','1','--decision','deny','--message','用户在飞书中拒绝了这次操作'],['agent','answer','w1:p1','4','--decision','allow_always']]);
  assert.deepEqual(f.updated.map(u=>[u[1],u[2].header.template,find(u[2],'markdown')[0].content]),[['om_bot_1','red','已拒绝 · <at id=ou_user></at>'],['om_bot_2','green','已总是允许 · <at id=ou_user></at>']]);
  assert.equal(find(f.updated,'button').length,0);
 }finally{f.close();}
});
test('a click on a request that has ended, that Herdr reports as not found, or whose id Herdr now gives another request shows 已失效',async()=>{
 const f=await requestTopic(bash,edit,ask);try{
  await f.topics.sync(f.m,f.pending());const [one,two,three]=f.cards();
  // Ended before the click: nothing is answered.
  f.h.requests['w1:p1']=[edit,ask];f.click('om_bot_1',f.value(one,'allow'));await f.settled();
  // Herdr restarted and counts ids from 1 again: id 2 is now another request.
  f.h.requests['w1:p1']=[{...bash,id:2},ask];f.click('om_bot_2',f.value(two,'allow'));await f.settled();
  assert.equal(f.h.calls.some(c=>c[1]==='answer'),false);
  f.h.on['agent answer']=()=>{throw coded('request_not_found','request 3 not found');};f.click('om_bot_3',f.value(three),{q0:'0',q1:['1']});await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')],['a','om_bot_2',expiredCard('权限确认 · Edit')],['a','om_bot_3',expiredCard('Agent 提问')]]);assert.deepEqual(f.records(),[]);
 }finally{f.close();}
});
test('a click whose answer fails for another reason marks the card failed and drops its record, so the next list sends a new card',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  f.h.on['agent answer']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};f.click('om_bot_1',f.value(card,'allow'));await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('权限确认 · Bash','grey',[plainText('提交失败。Agent 仍在等待时会重新发送卡片')])]]);assert.deepEqual(f.records(),[]);
  assert.deepEqual(cardLogs(f).at(-1),['error',`${f.t.agentName}：请求 #1 未能回答，连接超时，请检查 SSH 与 Herdr 状态`]);
  await f.topics.sync(f.m,f.pending());assert.equal(f.cards().length,2);assert.deepEqual(f.records(),[{requestId:1,messageId:'om_bot_2',title:'权限确认 · Bash'}]);
  assert.notEqual(f.value(f.cards()[1],'allow').render,f.value(card,'allow').render);
 }finally{f.close();}
});
test('while a card is being answered from Feishu, a list without its request does not mark it 已失效 and a second click is not answered',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  let release;f.h.on['agent answer']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
  f.click('om_bot_1',f.value(card,'allow'));await later(5);
  await f.topics.sync(f.m,f.pending([]));assert.deepEqual(f.updated,[]);assert.deepEqual(f.records().map(c=>c.requestId),[1]);
  assert.deepEqual(f.click('om_bot_1',f.value(card,'deny'),undefined,'ou_owner'),{toast:{type:'info',content:'正在提交，请稍候'}});
  release();await f.settled();
  assert.equal(f.h.calls.filter(c=>c[1]==='answer').length,1);assert.deepEqual(f.updated.map(u=>find(u[2],'markdown')[0]?.content),['已允许 · <at id=ou_user></at>']);
  await f.topics.sync(f.m,f.pending([]));assert.equal(f.updated.length,1);assert.deepEqual(f.records(),[]);
 }finally{f.close();}
});
test('a question card answers each question by its text: the chosen option, the chosen options, or the 其他 text instead of any choice',async()=>{
 const f=await requestTopic(ask,{...ask,id:5});try{
  await f.topics.sync(f.m,f.pending());const [first,second]=f.cards();
  assert.deepEqual(f.click('om_bot_1',f.value(first),{q0:'1',other0:'  ',q1:['0','2'],other1:''}),{toast:{type:'info',content:'正在提交'}});
  f.click('om_bot_2',f.value(second),{q0:'0',other0:' MySQL ',q1:['1'],other1:'全部'});await f.settled();
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='answer'),[
   ['agent','answer','w1:p1','3','--answers',JSON.stringify({'用哪种数据库？':['SQLite'],'需要哪些功能？':['登录','导出']})],
   ['agent','answer','w1:p1','5','--answers',JSON.stringify({'用哪种数据库？':['MySQL'],'需要哪些功能？':['全部']})]]);
  assert.deepEqual(f.updated[0],['a','om_bot_1',cardOf('Agent 提问','green',[plainText('用哪种数据库？\n回答：SQLite'),plainText('需要哪些功能？\n回答：登录、导出'),{tag:'markdown',content:'已回答 · <at id=ou_user></at>'}])]);
 }finally{f.close();}
});
test('a question card with a question left unanswered gets a toast, is not submitted, and is drawn again with the choices kept so it can be submitted again',async()=>{
 const f=await requestTopic(ask);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  for(const form of [{q0:'1',other1:'  '},{q1:[],other0:'x'},undefined]){
   assert.deepEqual(f.click('om_bot_1',f.value(card),form),{toast:{type:'warning',content:'请回答所有问题'}});await f.settled();
  }
  assert.equal(f.h.calls.some(c=>c[1]==='answer'),false);assert.deepEqual(f.records().map(c=>c.messageId),['om_bot_1']);
  const [again]=f.updated.map(u=>u[2]);
  // The channel drops a repeated click with the same button value, so every drawing carries a new render number.
  assert.deepEqual(f.updated.map(u=>[u[1],f.value(u[2]).render]),[['om_bot_1',2],['om_bot_1',3],['om_bot_1',4]]);
  assert.equal(find(again,'select_static')[0].initial_option,'1');assert.equal(find(again,'multi_select_static')[0].selected_values,undefined);
  assert.deepEqual(find(f.updated[1][2],'input').map(i=>i.default_value),['x',undefined]);
  f.click('om_bot_1',f.value(f.updated[2][2]),{q0:'0',q1:['2']});await f.settled();
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='answer').map(c=>c.at(-1)),[JSON.stringify({'用哪种数据库？':['PostgreSQL'],'需要哪些功能？':['导出']})]);
 }finally{f.close();}
});
test('a click on a card without a record gets a toast that the request has ended; a card in a topic that is no longer ready shows 已失效',async()=>{
 const f=await requestTopic(bash);try{
  await f.topics.sync(f.m,f.pending());const [card]=f.cards();
  const ended={toast:{type:'info',content:'这个请求已结束'}};
  assert.deepEqual(f.click('om_other',f.value(card,'allow')),ended);assert.deepEqual(f.click('om_bot_1',{...f.value(card,'allow'),request:9}),ended);
  f.t.state='closed';assert.deepEqual(f.click('om_bot_1',f.value(card,'allow')),ended);await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',expiredCard('权限确认 · Bash')]]);assert.deepEqual(f.records(),[]);assert.deepEqual(f.h.calls,[['agent','requests','w1:p1']]);
 }finally{f.close();}
});
const blockedNotice=notice('Agent 正在等待终端里的操作，请到 Herdr 中处理');
test('an agent blocked without requests in two lists in a row with the same state_change_seq gets one notice for that blocked episode',async()=>{
 const f=await requestTopic(bash);try{
  f.h.requests['w1:p1']=[];const list=(agent_status,state_change_seq,request_ids)=>f.h.agents.map(a=>({...a,agent_status,state_change_seq,request_ids}));
  await f.topics.sync(f.m,list('blocked',4));assert.deepEqual(f.replies,[]);
  await f.topics.sync(f.m,list('blocked',4));assert.deepEqual(f.replies.map(r=>r.slice(1)),[['oc_1','om_1',blockedNotice]]);assert.equal(new Store(f.dir).data.topics[0].blockedSeq,4);
  await f.topics.sync(f.m,list('blocked',4));assert.equal(f.replies.length,1);
  // A new blocked episode gets its own notice; a list without the agent, or with the agent working, breaks the run of lists.
  await f.topics.sync(f.m,list('blocked',6));await f.topics.sync(f.m,[]);await f.topics.sync(f.m,list('blocked',6));assert.equal(f.replies.length,1);
  await f.topics.sync(f.m,list('blocked',6));assert.equal(f.replies.length,2);
  // A blocked agent that waits on a request has a card instead.
  f.h.requests['w1:p1']=[bash];await f.topics.sync(f.m,list('blocked',8,[1]));await f.topics.sync(f.m,list('blocked',8,[1]));
  assert.deepEqual(f.replies.slice(2).map(r=>r[3].card.header?.title.content),['权限确认 · Bash']);
  // Other states never get the notice.
  for(const status of ['working','idle','unknown'])for(let i=0;i<2;i++)await f.topics.sync(f.m,list(status,10));
  assert.equal(f.replies.length,3);
 }finally{f.close();}
});
test('a prompt that meets a blocked agent posts its own notice for that episode, and the lists that follow post none',async()=>{
 const f=await readyTopic();try{
  Object.assign(f.h.agents[0],{agent_status:'blocked',state_change_seq:3});f.h.on['agent prompt']=()=>{throw coded('agent_blocked','agent w1:p1 is blocked');};
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('Agent 正在等待确认，请到 Herdr 中处理后重发这条消息')]);assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)),[['agent','list'],['agent','prompt'],['agent','list']]);
  for(let i=0;i<3;i++)await f.topics.sync(f.m,f.h.agents);
  assert.equal(f.replies.length,1);assert.equal(f.t.blockedSeq,3);
 }finally{f.close();}
});

// COT. The events of the run of the ready topic om_1 that its first message started, as cotLog shows them: a step per tool call that
// opens with its title or tool name and an icon and closes as done or failed, and a line of text for the status.
const run={threadId:'om_1',runId:'om_1'};
const opened=(id,name,title,icon)=>[['TOOL_CALL_START',{toolCallId:id,toolCallName:name,title,icon}],['TOOL_CALL_END',{toolCallId:id}]];
const closed=(id,failed=false)=>['TOOL_CALL_RESULT',{messageId:'result-'+id,toolCallId:id,role:'tool',content:failed?'失败':'完成',isError:failed}];
const said=(id,text)=>[['TEXT_MESSAGE_START',{messageId:id,role:'assistant'}],['TEXT_MESSAGE_CONTENT',{messageId:id,delta:text}],['TEXT_MESSAGE_END',{messageId:id}]];
const stopped=f=>f.store.data.logs.filter(l=>l.kind==='话题停止').map(l=>[l.level,l.message]);
test('a prompted message gets a COT in the topic thread, created after the prompt, which takes the place of its reaction and is kept in the topic record; the COT shows its run started',async()=>{
 const f=topicFixture();try{
  let prompted;const request=f.topics.request;f.topics.request=async(a,o)=>{prompted??=f.h.calls.some(c=>c[1]==='prompt');return request(a,o);};
  await f.send({messageId:'om_1',content:'one'});
  assert.equal(prompted,true);
  assert.deepEqual(f.api[0],{method:'POST',url:cotPath,params:{receive_id_type:'chat_id'},data:{receive_id:'oc_1',origin_message_id:'om_1',reply_in_thread:true}});
  const update=f.api[1];assert.deepEqual([update.method,update.url,update.data.message_id,update.data.cot_id],['PUT',cotPath,'om_cot_1','c1']);
  // Every event carries its AG-UI event as JSON and a timestamp in ms.
  assert.ok(update.data.events.every(e=>Object.keys(e).join()==='event_type,content,timestamp'&&typeof e.content==='string'&&Math.abs(e.timestamp-Date.now())<60000));
  assert.deepEqual(cotLog(f),[['create','om_1'],['update','c1',['RUN_STARTED',run]]]);
  assert.deepEqual(new Store(f.dir).data.topics[0].cot,{cotId:'c1',messageId:'om_cot_1',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false});
  // The reaction marked the message at once; the COT takes its place.
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_1']);assert.deepEqual(f.unreacted.map(r=>r[1]),['om_1']);assert.deepEqual(onDisk(f),[]);assert.deepEqual(cotLogs(f),[]);
 }finally{f.close();}
});
test('the COT starts after the tool calls that the agent made before the prompt',async()=>{
 const f=topicFixture();try{
  f.h.on['agent prompt']=(args,run)=>{const r=run(args);return {...r,agent:{...r.agent,tool_call_seq:12}};};
  await f.send({messageId:'om_1',content:'one'});assert.equal(f.store.data.topics[0].cot.toolSeq,12);
 }finally{f.close();}
});
test('a message prompted while the COT of an earlier one is open keeps its reaction until its turn ends; a message that is not prompted gets no COT',async()=>{
 const f=await readyTopic();try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(f.api,[]);assert.deepEqual(onDisk(f),[{messageId:'om_2',reactionId:'r_om_2',stateSeq:1}]);assert.equal(f.t.cot.origin,'om_1');
  delete f.t.cot;f.h.on['agent prompt']=()=>{throw coded('agent_blocked','agent w1:p1 is blocked');};
  await f.send({messageId:'om_3',rootId:'om_1',content:'three'});assert.deepEqual(f.api,[]);assert.equal(f.t.cot,undefined);
 }finally{f.close();}
});
test('a COT that Feishu refuses is logged and leaves the message its reaction until its turn ends, while delivery and replies go on; the next prompted message tries again',async()=>{
 const f=topicFixture({cot:false});try{
  await f.send({messageId:'om_1',content:'one'});const t=f.store.data.topics[0];
  assert.deepEqual(cotLog(f),[['create','om_1']]);assert.equal(t.cot,undefined);assert.deepEqual(onDisk(f),[{messageId:'om_1',reactionId:'r_om_1',stateSeq:1}]);
  assert.deepEqual(cotLogs(f),[['error',`${t.agentName}：未能创建 COT，飞书接口错误 99991672：Access denied`]]);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);
  f.h.retained['w1:p1']=[{seq:1,text:'done'}];await f.topics.sync(f.m,list(f,{agent_status:'done',state_change_seq:2,reply_seq:1}));
  assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('done')]);assert.deepEqual(f.unreacted.map(r=>r[1]),['om_1']);assert.equal(f.api.length,1);
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});assert.deepEqual(cotLog(f),[['create','om_1'],['create','om_2']]);
 }finally{f.close();}
});
test('the tool calls of the agent become steps of the COT in seq order across lists: a start opens a step with its title or else its tool name and an icon, an end closes it as done or failed; the seq is on disk',async()=>{
 const f=await readyTopic();try{
  const calls=f.h.toolCalls['w1:p1']=[{seq:3,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'npm test'},{seq:4,tool_call_id:'t2',phase:'start',tool_name:'Read',title:'src/a.rs'},{seq:6,tool_call_id:'t1',phase:'end',tool_name:'Bash'}];
  const working=seq=>list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:seq});
  await f.topics.sync(f.m,working(6));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','0']]);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','npm test','bash'),...opened('t2','Read','src/a.rs','read'),closed('t1')]]);assert.equal(new Store(f.dir).data.topics[0].cot.toolSeq,6);
  // The same list again shows nothing new.
  await f.topics.sync(f.m,working(6));assert.equal(f.h.calls.length,1);assert.equal(f.api.length,1);
  calls.push({seq:9,tool_call_id:'t2',phase:'end',tool_name:'Read',failed:true},{seq:10,tool_call_id:'t3',phase:'start',tool_name:'Grep'},{seq:11,tool_call_id:'t4',phase:'start',tool_name:'apply_patch',title:'a.rs'},
   {seq:12,tool_call_id:'t5',phase:'start',tool_name:'shell',title:'ls'},{seq:13,tool_call_id:'t6',phase:'start',tool_name:'Task',title:'审查改动'},{seq:14,tool_call_id:'t7',phase:'start',tool_name:'Edit',title:'很'.repeat(300)});
  f.h.calls.length=0;f.api.length=0;await f.topics.sync(f.m,working(14));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','6']]);
  assert.deepEqual(cotLog(f),[['update','c1',closed('t2',true),...opened('t3','Grep','Grep','search'),...opened('t4','apply_patch','a.rs','write'),...opened('t5','shell','ls','bash'),...opened('t6','Task','审查改动','default'),...opened('t7','Edit','很'.repeat(199)+'…','write')]]);
  assert.equal(f.t.cot.toolSeq,14);assert.deepEqual(cotLogs(f),[]);
 }finally{f.close();}
});
test('a tool call seq below the stored one, after Herdr restarted or handed off and counts from 1 again, fetches all tool calls and shows those up to the list; more than 50 events go out in updates of at most 50, in order',async()=>{
 const f=await readyTopic();try{
  f.t.cot.toolSeq=40;f.h.toolCalls['w1:p1']=Array.from({length:31},(_,i)=>({seq:i+1,tool_call_id:'t'+(i+1),phase:'start',tool_name:'Bash',title:'step '+(i+1)}));
  await f.topics.sync(f.m,list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:30}));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1']]);
  const batches=f.api.map(o=>o.data.events);assert.deepEqual(batches.map(b=>b.length),[50,10]);
  assert.deepEqual(cotLog(f).flatMap(u=>u.slice(2)),Array.from({length:30},(_,i)=>opened('t'+(i+1),'Bash','step '+(i+1),'bash')).flat());
  const stamps=batches.flat().map(e=>e.timestamp);assert.ok(stamps.every((s,i)=>!i||s>stamps[i-1]));assert.equal(f.t.cot.toolSeq,30);
  f.h.calls.length=0;f.api.length=0;await f.topics.sync(f.m,list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:31}));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','30']]);assert.deepEqual(cotLog(f),[['update','c1',...opened('t31','Bash','step 31','bash')]]);
 }finally{f.close();}
});
test('tool calls that cannot be fetched are fetched again with the next list; an update Feishu refuses is logged once and not repeated',async()=>{
 const f=await readyTopic();try{
  f.h.toolCalls['w1:p1']=[{seq:3,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'ls'}];const working=list(f,{agent_status:'working',state_change_seq:2,tool_call_seq:3});
  f.h.on['agent tool-calls']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};await f.topics.sync(f.m,working);
  assert.deepEqual(f.api,[]);assert.equal(f.t.cot.toolSeq,0);assert.deepEqual(cotLogs(f),[['error',`${f.t.agentName}：未能读取工具调用，连接超时，请检查 SSH 与 Herdr 状态`]]);
  const request=f.topics.request;f.topics.request=async(a,o)=>{f.api.push(o);throw Error('飞书未连接');};
  await f.topics.sync(f.m,working);await f.topics.sync(f.m,working);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','ls','bash')]]);assert.equal(f.t.cot.toolSeq,3);assert.deepEqual(cotLogs(f).at(-1),['error',`${f.t.agentName}：COT 未能更新，飞书未连接`]);
  f.topics.request=request;
 }finally{f.close();}
});
test('while the agent waits for a confirmation, on a request card or blocked without one, the COT status says so after the steps that led there; once it runs again the COT says that before the steps that follow, each change once',async()=>{
 const f=await requestTopic(bash);try{
  f.h.toolCalls['w1:p1']=[{seq:2,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'ls -la'}];
  const waiting=f.pending([1],{agent_status:'blocked',state_change_seq:3,tool_call_seq:2});
  await f.topics.sync(f.m,waiting);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','ls -la','bash'),...said('status-3','等待确认')]]);assert.equal(new Store(f.dir).data.topics[0].cot.waiting,true);
  assert.equal(f.cards().length,1);await f.topics.sync(f.m,waiting);assert.equal(f.api.length,1);
  f.h.toolCalls['w1:p1'].push({seq:5,tool_call_id:'t1',phase:'end',tool_name:'Bash'});f.api.length=0;
  await f.topics.sync(f.m,f.pending([],{agent_status:'working',state_change_seq:4,tool_call_seq:5}));
  assert.deepEqual(cotLog(f),[['update','c1',...said('status-4','继续运行'),closed('t1')]]);assert.equal(f.t.cot.waiting,false);
  // Blocked without a request, such as on a question that Feishu cannot answer.
  f.api.length=0;await f.topics.sync(f.m,f.pending([],{agent_status:'blocked',state_change_seq:6,tool_call_seq:5}));
  assert.deepEqual(cotLog(f),[['update','c1',...said('status-6','等待确认')]]);
 }finally{f.close();}
});
test('once its turn ends the COT shows its last steps, finishes as done and is completed, after the replies went out as cards; the next prompted message gets a new COT',async()=>{
 const f=await readyTopic();try{
  const order=[],reply=f.topics.reply,request=f.topics.request;f.topics.reply=async(...args)=>{order.push('reply');return reply(...args);};f.topics.request=async(a,o)=>{order.push(o.method);return request(a,o);};
  f.h.retained['w1:p1']=[{seq:1,text:'改好了'}];f.h.toolCalls['w1:p1']=[{seq:4,tool_call_id:'t1',phase:'end',tool_name:'Edit'}];
  // A turn has not ended while the agent works, or is idle without a state change since the prompt.
  for(const fields of [{agent_status:'working',state_change_seq:2},{agent_status:'idle',state_change_seq:1}])await f.topics.sync(f.m,list(f,fields));
  assert.deepEqual(f.api,[]);
  const done=list(f,{agent_status:'done',state_change_seq:2,reply_seq:1,tool_call_seq:4});await f.topics.sync(f.m,done);
  assert.deepEqual(f.replies.map(r=>r[3]),[replyOf('改好了')]);
  assert.deepEqual(cotLog(f),[['update','c1',closed('t1'),['RUN_FINISHED',{...run,status:'done'}]],['complete','c1','done']]);
  assert.deepEqual(f.api.at(-1),{method:'POST',url:cotPath+'/complete/c1',params:{message_id:'om_cot_1',reason:'done'}});
  assert.deepEqual(order,['reply','PUT','POST']);assert.equal(new Store(f.dir).data.topics[0].cot,undefined);
  await f.topics.sync(f.m,done);assert.equal(f.api.length,2);
  await f.send({messageId:'om_2',rootId:'om_1',content:'two'});
  assert.deepEqual(cotLog(f).slice(2),[['create','om_2'],['update','c2',['RUN_STARTED',{threadId:'om_1',runId:'om_2'}]]]);
 }finally{f.close();}
});
test('a topic that ends while its COT is open shows the COT failed and completes it, also when the update fails',async()=>{
 const f=await readyTopic();try{
  f.h.agents.length=0;await f.topics.sync(f.m,[]);
  assert.equal(f.t.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[endedNotice]);
  assert.deepEqual(cotLog(f),[['update','c1',['RUN_ERROR',{message:'话题已结束'}]],['complete','c1','error']]);assert.equal(new Store(f.dir).data.topics[0].cot,undefined);
 }finally{f.close();}
 const g=await readyTopic();try{
  const request=g.topics.request;g.topics.request=async(a,o)=>{if(o.method!=='PUT')return request(a,o);g.api.push(o);throw Error('飞书未连接');};
  g.h.agents.length=0;await g.topics.sync(g.m,[]);
  assert.deepEqual(cotLog(g),[['update','c1',['RUN_ERROR',{message:'话题已结束'}]],['complete','c1','error']]);assert.deepEqual(cotLogs(g),[['error',`${g.t.agentName}：COT 未能更新，飞书未连接`]]);
 }finally{g.close();}
});
test('an open COT is kept on disk with its topic and completed by the first sync after a restart when its turn ended meanwhile',async()=>{
 const f=await readyTopic();try{
  f.h.toolCalls['w1:p1']=[{seq:3,tool_call_id:'t1',phase:'start',tool_name:'Bash',title:'ls'},{seq:4,tool_call_id:'t1',phase:'end',tool_name:'Bash'}];
  const {store,topics}=f.restart();assert.deepEqual(store.data.topics[0].cot,{cotId:'c1',messageId:'om_cot_1',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false});
  await topics.sync(f.m,list(f,{agent_status:'idle',state_change_seq:2,tool_call_seq:4}));
  assert.deepEqual(f.h.calls,[['agent','tool-calls','w1:p1','--after','0']]);
  assert.deepEqual(cotLog(f),[['update','c1',...opened('t1','Bash','ls','bash'),closed('t1'),['RUN_FINISHED',{...run,status:'done'}]],['complete','c1','done']]);
  assert.equal(new Store(f.dir).data.topics[0].cot,undefined);
 }finally{f.close();}
});
test('/stop in a ready topic sends Esc to its working or blocked agent and shows the open COT interrupted; without a COT a notice says so; the command is not prompted and gets no reaction',async()=>{
 const f=await readyTopic();try{
  f.h.agents[0].agent_status='working';f.reacted.length=0;
  await f.send({messageId:'om_2',rootId:'om_1',content:' /stop '});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','send-keys','w1:p1','esc']]);assert.deepEqual(f.replies,[]);assert.deepEqual(f.reacted,[]);
  assert.deepEqual(cotLog(f),[['update','c1',['RUN_FINISHED',{...run,status:'interrupted'}]],['complete','c1','error']]);assert.equal(new Store(f.dir).data.topics[0].cot,undefined);
  assert.deepEqual(stopped(f),[['info',`${f.t.agentName}：已发送停止`]]);assert.deepEqual(f.t.messageIds,['om_1','om_2']);
  f.h.agents[0].agent_status='blocked';f.h.calls.length=0;f.api.length=0;
  await f.send({messageId:'om_3',rootId:'om_1',content:'/stop'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','send-keys','w1:p1','esc']]);assert.deepEqual(f.api,[]);assert.deepEqual(f.replies.map(r=>r[3]),[notice('已停止 Agent 当前这一轮')]);
 }finally{f.close();}
});
test('/stop without a running turn sends no key and replies a notice; a /stop that cannot reach the agent is logged with a notice',async()=>{
 const f=await readyTopic();try{
  for(const status of ['idle','done','unknown']){f.h.agents[0].agent_status=status;await f.send({messageId:'om_'+status,rootId:'om_1',content:'/stop'});}
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','list'],['agent','list']]);assert.deepEqual(f.api,[]);assert.equal(f.t.cot.cotId,'c1');
  assert.deepEqual(f.replies.map(r=>r[3]),Array(3).fill(notice('Agent 当前没有在运行的一轮')));
  f.h.agents[0].agent_status='working';f.replies.length=0;f.h.on['agent send-keys']=()=>{throw coded('agent_not_ready','agent w1:p1 is not ready');};
  await f.send({messageId:'om_4',rootId:'om_1',content:'/stop'});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('未能停止 Agent，请稍后重试')]);assert.deepEqual(stopped(f),[['error',`${f.t.agentName}：未能停止，agent w1:p1 is not ready`]]);assert.equal(f.t.cot.cotId,'c1');
 }finally{f.close();}
});
test('in a binding that requires the mention, /stop in a topic thread needs it too: without it no key is sent and nothing is recorded or replied',async()=>{
 const f=await readyTopic({binding:{requireMention:true}});try{
  f.h.agents[0].agent_status='working';f.reacted.length=0;
  await f.send({messageId:'om_2',rootId:'om_1',content:'/stop'});
  assert.deepEqual([f.h.calls,f.replies,f.reacted,f.api,f.t.messageIds],[[],[],[],[],['om_1']]);assert.equal(f.t.cot.cotId,'c1');
  await f.send({messageId:'om_3',rootId:'om_1',content:'/stop',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','send-keys','w1:p1','esc']]);assert.deepEqual(cotLog(f),[['update','c1',['RUN_FINISHED',{...run,status:'interrupted'}]],['complete','c1','error']]);
  assert.deepEqual([f.t.messageIds,f.reacted],[['om_1','om_3'],[]]);
 }finally{f.close();}
});
test('a root /stop, such as the stop button of a COT sends in a direct chat, stops the one topic of the chat whose COT is open; with none or several it asks for /stop in the topic; it never opens a topic',async()=>{
 const f=await readyTopic();try{
  await f.send({messageId:'om_2',content:'two'});const [one,two]=f.store.data.topics;
  // A topic of another binding with an open COT does not count.
  f.store.data.topics.push({...structuredClone(two),id:'other',bindingId:'other',rootId:'om_other'});
  for(const a of f.h.agents)a.agent_status='working';f.h.calls.length=0;f.api.length=0;f.replies.length=0;
  await f.send({messageId:'om_stop1',content:' /stop '});
  const ask=['a','oc_1','om_stop1',notice('请在要停止的话题里发送 /stop')];assert.deepEqual(f.replies,[ask]);assert.deepEqual([f.h.calls,f.api],[[],[]]);
  delete one.cot;await f.send({messageId:'om_stop2',content:'/stop',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','send-keys','w1:p2','esc']]);assert.deepEqual(cotLog(f),[['update','c2',['RUN_FINISHED',{threadId:'om_2',runId:'om_2',status:'interrupted'}]],['complete','c2','error']]);
  assert.equal(f.replies.length,1);f.h.calls.length=0;
  await f.send({messageId:'om_stop3',content:'/stop'});assert.deepEqual(f.replies.at(-1),['a','oc_1','om_stop3',notice('请在要停止的话题里发送 /stop')]);assert.deepEqual(f.h.calls,[]);
  assert.deepEqual(f.store.data.topics.map(t=>t.rootId),['om_1','om_2','om_other']);assert.deepEqual(f.reacted.map(r=>r[1]).filter(id=>id.startsWith('om_stop')),[]);
 }finally{f.close();}
});

// Adoption. On cpu2 (machine m), besides the ready bridge topic om_1 in w1:p1 with its open COT c1, workspace w2 (herdr) holds: in tab 1, a
// Claude with the Herdr name review, a session and two retained replies in the pane labelled 赤尾重构; in tab 出题, a Codex attached to its
// background app-server without a session or replies in a pane without a label; and a pane without an agent. cpu1 cannot be reached, gpu1
// runs no agent and the disconnected gpu2 is left out.
const claudePane={agent:'claude',name:'review',pane_id:'w2:p1',workspace_id:'w2',tab_id:'w2:t1',cwd:'/home/someone/code/herdr',agent_status:'idle',state_change_seq:4,reply_seq:2,agent_session:{source:'herdr:claude',agent:'claude',kind:'id',value:'s-claude'}};
const codexPane={agent:'codex',pane_id:'w2:p2',workspace_id:'w2',tab_id:'w2:t2',cwd:'/srv/app',agent_status:'working',state_change_seq:7};
const claudeChoice={machine:'m',pane:'w2:p1',kind:'claude',name:'review',session:'s-claude'},codexChoice={machine:'m',pane:'w2:p2',kind:'codex'};
// The picker: a form whose dropdown offers an option per agent and whose 接管 button submits the chosen one; machines that cannot be reached
// follow it. Each option carries what the agent is checked against when it is chosen.
const option=(content,choice)=>({text:{tag:'plain_text',content},value:JSON.stringify(choice)});
const pickerForm=(render,...options)=>({tag:'form',name:'picker',elements:[{tag:'select_static',name:'agent',width:'fill',placeholder:{tag:'plain_text',content:'选择要接管的 Agent'},options},
 {tag:'button',text:{tag:'plain_text',content:'接管'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{adopt:true,render}}]}]});
const claudeOption=option('cpu2 · 赤尾重构 · Claude · 空闲',claudeChoice),codexOption=option('cpu2 · 出题 · Codex · 运行中',codexChoice),cpu1Down=plainText('cpu1 · 连接失败');
// The picker of the agents above with its render number; a notice comes first.
const pickerCard=(render,notice)=>cardOf('接管 Agent','blue',[...notice?[plainText(notice)]:[],pickerForm(render,claudeOption,codexOption),cpu1Down]);
const introLines=['话题里的消息会发给这个 Agent，它的回复会转到这里。发送 /release 结束接管，Agent 会继续在终端的 pane 里运行。'];
const adoptLogs=f=>f.store.data.logs.filter(l=>l.kind==='话题接管').map(l=>[l.level,l.message]);
// What a submission of the picker form holds: the value of the chosen option, a raw string as is, or nothing when no option was chosen.
const formValue=adopt=>adopt===undefined?{}:{agent:typeof adopt==='string'?adopt:JSON.stringify(adopt)};
async function adoptFixture(binding){
 const f=topicFixture({binding,machines:[{id:'m2',name:'cpu1',enabled:true},{id:'m3',name:'gpu1',enabled:true},{id:'m4',name:'gpu2',enabled:false}]});
 await f.send({messageId:'om_1',content:'bridge topic',mentionedBot:true});
 f.h.agents.push(structuredClone(claudePane),structuredClone(codexPane),{name:'shell',pane_id:'w2:p3',workspace_id:'w2',tab_id:'w2:t1',agent_status:'unknown',state_change_seq:0});
 // Herdr labels a tab without a name by its position.
 f.h.workspaces.push({workspace_id:'w2',label:'herdr'});f.h.tabs.push({tab_id:'w2:t1',workspace_id:'w2',label:'1'},{tab_id:'w2:t2',workspace_id:'w2',label:'出题'});
 f.h.panes.push({pane_id:'w2:p1',workspace_id:'w2',tab_id:'w2:t1',label:'赤尾重构'},{pane_id:'w2:p2',workspace_id:'w2',tab_id:'w2:t2'},{pane_id:'w2:p3',workspace_id:'w2',tab_id:'w2:t1'});
 f.h.retained['w2:p1']=[{seq:1,text:'旧回复'},{seq:2,text:'\n改好了。\n\n- 修复了登录'}];
 f.h.hosts.m2={down:'ssh: connect to host cpu1 port 22: Connection timed out'};f.h.hosts.m3={agents:[],retained:{},requests:{}};
 f.h.calls.length=0;f.h.machines.length=0;f.reacted.length=0;f.unreacted.length=0;f.api.length=0;
 return {...f,
  // The topic whose thread starts at message id.
  topic:id=>f.store.data.topics.find(t=>t.rootId===id),
  pickers:()=>f.replies.filter(r=>r[3].card.header).map(r=>r[3].card),
  // A submission of picker messageId by an allowed person with agent adopt chosen (see formValue).
  pick:(messageId,adopt,render=1,openId='ou_user')=>f.topics.click(allowed,{messageId,chatId:'oc_1',operator:{openId},action:{tag:'button',name:'submit',value:{adopt:true,render},formValue:formValue(adopt)}}),
  settled:()=>Promise.all(f.topics.answering.values()),
  // Sends /adopt, which mentions the bot, and submits agent adopt on its picker, which is reply om_bot_<n>.
  async adopt(rootId,adopt,n=1){await f.send({messageId:rootId,content:'/adopt',mentionedBot:true});f.topics.click(allowed,{messageId:'om_bot_'+n,chatId:'oc_1',operator:{openId:'ou_user'},action:{tag:'button',name:'submit',value:{adopt:true,render:n},formValue:formValue(adopt)}});await Promise.all(f.topics.answering.values());return f.store.data.topics.find(t=>t.rootId===rootId);},
 };
}
test('an agent is named by the label of its pane, else the label given to its tab, else the label of its workspace, else its pane; agents that would share a name are told apart by their panes',()=>{
 const snapshot=(agents,{panes=[],tabs=[],workspaces=[]}={})=>({agents,panes,tabs,workspaces}),workspaces=[{workspace_id:'w1',label:'herdr'}];
 const x={agent:'claude',pane_id:'w1:p1',tab_id:'w1:t1',workspace_id:'w1'};
 assert.equal(nameOf(snapshot([x],{panes:[{pane_id:'w1:p1',label:'赤尾重构'}],tabs:[{tab_id:'w1:t1',label:'重构'}],workspaces}),x),'赤尾重构');
 assert.equal(nameOf(snapshot([x],{panes:[{pane_id:'w1:p1'}],tabs:[{tab_id:'w1:t1',label:'重构'}],workspaces}),x),'重构');
 // Herdr labels a tab without a name by its position, which names nothing.
 assert.equal(nameOf(snapshot([x],{panes:[{pane_id:'w1:p1'}],tabs:[{tab_id:'w1:t1',label:'3'}],workspaces}),x),'herdr');
 assert.equal(nameOf(snapshot([x]),x),'w1:p1');
 assert.equal(nameOf(snapshot([x],{panes:[{pane_id:'w1:p1',label:'很'.repeat(50)}]}),x),'很'.repeat(39)+'…');
 // Two agents split in one tab without pane labels; an agent with a name of its own keeps it.
 const y={...x,agent:'codex',pane_id:'w1:p2'},z={...x,pane_id:'w1:p3',tab_id:'w1:t2'};
 const s=snapshot([x,y,z],{panes:[{pane_id:'w1:p1'},{pane_id:'w1:p2'},{pane_id:'w1:p3',label:'出题'}],tabs:[{tab_id:'w1:t1',label:'重构'},{tab_id:'w1:t2',label:'2'}],workspaces});
 assert.deepEqual([x,y,z].map(a=>nameOf(s,a)),['重构 (w1:p1)','重构 (w1:p2)','出题']);
});
test('/adopt as a root message replies in its thread with a picker whose dropdown names each agent on every connected machine by machine, the pane name the person gave in Herdr, kind and status, leaving out panes that topics of any binding hold; an unreachable machine shows 连接失败 outside it; each machine is read with one Herdr call',async()=>{
 const f=await adoptFixture();try{
  // A ready topic of another binding holds w2:p4, which shares the 出题 tab with the Codex: only the agents offered are told apart by their
  // panes. A closed topic no longer holds the Codex pane.
  f.h.agents.push({agent:'claude',name:'other',pane_id:'w2:p4',workspace_id:'w2',tab_id:'w2:t2',agent_status:'idle',state_change_seq:1,remote_answers:true});
  f.store.data.topics.push({...f.topic('om_1'),id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p4'},{...f.topic('om_1'),id:'old',rootId:'om_old',paneId:'w2:p2',state:'closed'});
  await f.send({messageId:'om_cmd',content:' /adopt '});
  assert.deepEqual(f.replies,[['a','oc_1','om_cmd',{card:pickerCard(1)}]]);
  assert.deepEqual(callsOn(f).map(c=>JSON.stringify(c)).sort(),[['m','api','snapshot'],['m2','api','snapshot'],['m3','api','snapshot']].map(c=>JSON.stringify(c)).sort());
  const {id,createdAt,...rest}=f.topic('om_cmd');assert.ok(createdAt>0);
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_cmd',machineId:'',workspaceId:'',tabId:'',paneId:'',agentName:'',title:'接管 Agent',state:'choosing',error:'',messageIds:['om_cmd'],replySeq:0,reactions:[],cards:[],adopted:{picker:'om_bot_1'}});
  assert.deepEqual(new Store(f.dir).data.topics.find(t=>t.id===id).adopted,{picker:'om_bot_1'});
  assert.deepEqual(f.reacted,[]);assert.equal(f.h.calls.some(c=>['workspace','tab'].includes(c[0])||c[1]==='start'||c[1]==='prompt'),false);
  assert.deepEqual(adoptLogs(f),[['error','cpu1：ssh: connect to host cpu1 port 22: Connection timed out'],['info','个人助手：已发送可接管的 Agent 列表']]);
 }finally{f.close();}
});
test('/adopt is a command only on a root message: in a thread it is a message to the agent, a mention-only group needs the @, and a repeated delivery sends one picker',async()=>{
 const f=await adoptFixture({requireMention:true});try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'/adopt',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','/adopt']]);assert.deepEqual(f.replies,[]);
  f.h.calls.length=0;await f.send({messageId:'om_cmd',content:'/adopt'});
  assert.deepEqual([f.h.calls,f.replies,f.topic('om_cmd')],[[],[],undefined]);
  await f.send({messageId:'om_cmd2',content:'/adopt',mentionedBot:true});await f.send({messageId:'om_cmd2',content:'/adopt',mentionedBot:true});
  assert.deepEqual(f.replies.map(r=>r[2]),['om_cmd2']);assert.equal(f.pickers().length,1);
 }finally{f.close();}
});
test('the Chinese commands of earlier versions are messages like any other: /接管 opens a topic and /结束接管 is prompted to the adopted agent',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_old',content:'/接管'});
  assert.equal(f.topic('om_old').adopted,undefined);assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['/接管']);assert.equal(f.pickers().length,0);
  const t=await f.adopt('om_cmd',claudeChoice,1);f.h.calls.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'/结束接管'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w2:p1','/结束接管']]);assert.equal(t.state,'ready');
 }finally{f.close();}
});
test('a message in the thread of a picker before any selection gets a notice, is not prompted and opens no tab',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});f.h.calls.length=0;f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'先说一句'});
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.replies,[['a','oc_1','om_cmd',notice('请先在上面的卡片中选择要接管的 Agent')]]);
  assert.deepEqual(f.unreacted,[['a','om_2','r_om_2']]);assert.deepEqual([f.topic('om_cmd').state,f.topic('om_cmd').messageIds],['choosing',['om_cmd','om_2']]);
 }finally{f.close();}
});
test('a picker that Feishu refuses is logged and its topic closed',async()=>{
 const f=await adoptFixture();try{
  f.topics.reply=async()=>{throw Error('飞书未连接');};await f.send({messageId:'om_cmd',content:'/adopt'});
  assert.equal(f.topic('om_cmd').state,'closed');assert.deepEqual(adoptLogs(f).at(-1),['error','个人助手：可接管的 Agent 列表未发出，飞书未连接']);
 }finally{f.close();}
});
test('submitting an agent turns on its remote answers, links the topic to its machine and pane under its pane name, posts the intro with its full latest reply and marks the picker adopted',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});f.h.calls.length=0;f.h.machines.length=0;f.replies.length=0;
  assert.deepEqual(f.pick('om_bot_1',claudeChoice),{toast:{type:'info',content:'正在接管'}});
  await f.settled();
  assert.deepEqual(callsOn(f),[['m','api','snapshot'],['m','pane','remote-answers','w2:p1','on'],['m','agent','replies','w2:p1','--after','1']]);
  const t=f.topic('om_cmd'),{id,createdAt,messageIds,...rest}=t;
  assert.deepEqual(rest,{bindingId:'b',appId:'a',chatId:'oc_1',rootId:'om_cmd',machineId:'m',workspaceId:'w2',tabId:'w2:t1',paneId:'w2:p1',agentName:'赤尾重构',title:'接管 · 赤尾重构',state:'ready',error:'',replySeq:2,reactions:[],cards:[],adopted:{picker:'om_bot_1',kind:'claude',session:'s-claude'}});
  assert.equal(new Store(f.dir).data.topics.find(x=>x.id===id).state,'ready');assert.equal(f.h.agents.find(a=>a.pane_id==='w2:p1').remote_answers,true);
  assert.deepEqual(f.replies,[['a','oc_1','om_cmd',notice(['已接管 cpu2 上的 Claude · 赤尾重构','工作目录：~/code/herdr',...introLines,'最近一条回复：'].join('\n'),
   '已接管 cpu2 上的 Claude · 赤尾重构 工作目录：~/code/herdr 话题里的消息会发给这个 Agent，它的回复会转到这里。发送 /release 结束接管，Agent 会继续在…')],['a','oc_1','om_cmd',replyOf('\n改好了。\n\n- 修复了登录','改好了。 - 修复了登录')]]);
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('接管 Agent','green',[plainText('cpu2 · 赤尾重构 · Claude · 空闲'),{tag:'markdown',content:'已接管 · <at id=ou_user></at>'}])]]);
  assert.deepEqual(adoptLogs(f).at(-1),['info','个人助手：已接管 cpu2 上的 赤尾重构']);
  // The picker takes no further selection.
  assert.deepEqual(f.pick('om_bot_1',codexChoice),{toast:{type:'info',content:'这个话题已接管 Agent，不能再选择'}});await f.settled();assert.equal(f.h.calls.length,3);
 }finally{f.close();}
});
test('an agent without a reported session gets a warning in the intro; an agent without replies gets no reply; a pane without a label is named after its tab',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});f.h.calls.length=0;f.replies.length=0;
  f.pick('om_bot_1',codexChoice);await f.settled();
  assert.deepEqual(f.h.calls,[['api','snapshot'],['pane','remote-answers','w2:p2','on']]);
  assert.deepEqual(f.replies.map(r=>r[3]),[notice(['已接管 cpu2 上的 Codex · 出题','工作目录：/srv/app',...introLines,'这个 Agent 没有向 Herdr 上报会话（例如连着后台 app-server 的 Codex），它的回复可能无法转回飞书。'].join('\n'),
   '已接管 cpu2 上的 Codex · 出题 工作目录：/srv/app 话题里的消息会发给这个 Agent，它的回复会转到这里。发送 /release 结束接管，Agent 会继续在终端的 pan…')]);
  const t=f.topic('om_cmd');assert.deepEqual([t.paneId,t.agentName,t.title,t.replySeq,t.adopted],['w2:p2','出题','接管 · 出题',0,{picker:'om_bot_1',kind:'codex'}]);
 }finally{f.close();}
});
test('a selection whose agent exited or changed meanwhile, whose remote answers cannot be turned on or whose machine was disconnected links nothing and redraws the picker with the reason and the agents left',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});const t=f.topic('om_cmd');
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w2:p1');f.h.calls.length=0;
  assert.deepEqual(f.pick('om_bot_1',claudeChoice),{toast:{type:'info',content:'正在接管'}});await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('接管 Agent','blue',[plainText('所选的 Agent 已退出或已变化，请重新选择'),pickerForm(2,codexOption),cpu1Down])]]);
  assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.deepEqual([t.state,t.paneId],['choosing','']);
  // The same pane with another session holds another agent.
  f.h.agents.push({...structuredClone(claudePane),agent_session:{...claudePane.agent_session,value:'s-other'}});f.h.calls.length=0;
  f.pick('om_bot_1',claudeChoice,2);await f.settled();
  assert.deepEqual(f.updated.at(-1)[2].body.elements[0],plainText('所选的 Agent 已退出或已变化，请重新选择'));assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.equal(t.state,'choosing');
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};
  f.pick('om_bot_1',codexChoice,3);await f.settled();
  assert.deepEqual(f.updated.at(-1)[2].body.elements[0],plainText('接管失败，请稍后重试'));assert.deepEqual([t.state,t.paneId],['choosing','']);
  assert.deepEqual(adoptLogs(f).filter(l=>l[1].startsWith('个人助手：接管失败')),[['error','个人助手：接管失败，连接超时，请检查 SSH 与 Herdr 状态']]);
  // A machine disconnected meanwhile is left out of the redrawn picker.
  f.m.enabled=false;f.pick('om_bot_1',codexChoice,4);await f.settled();
  assert.deepEqual(f.updated.at(-1)[2],cardOf('接管 Agent','blue',[plainText('所选的机器已断开，请重新选择'),plainText('没有可以接管的 Agent'),cpu1Down]));
  assert.deepEqual([t.state,t.paneId],['choosing','']);f.m.enabled=true;
  // A selection from the redrawn picker still works.
  f.pick('om_bot_1',codexChoice,5);await f.settled();assert.deepEqual([t.state,t.paneId],['ready','w2:p2']);
 }finally{f.close();}
});
test('two pickers selecting the same agent at once link it to one topic only; the other picker says it was adopted meanwhile and no longer lists it',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_a',content:'/adopt'});await f.send({messageId:'om_b',content:'/adopt'});
  f.h.calls.length=0;f.pick('om_bot_1',codexChoice);f.pick('om_bot_2',codexChoice,2);await f.settled();
  assert.deepEqual([f.topic('om_a').state,f.topic('om_b').state],['ready','choosing']);assert.equal(f.h.calls.filter(c=>c[0]==='pane').length,1);
  const [,,card]=f.updated.find(u=>u[1]==='om_bot_2');
  assert.deepEqual(card,cardOf('接管 Agent','blue',[plainText('所选的 Agent 已被其他话题接管，请重新选择'),pickerForm(3,claudeOption),cpu1Down]));
 }finally{f.close();}
});
test('agents offered under the same name on one machine are told apart by their panes, in the picker and in the topic that adopts one; agents that topics hold do not count',async()=>{
 const f=await adoptFixture();try{
  // A second Codex split into the 出题 tab, and a Claude there that a ready topic of another binding holds.
  f.h.agents.push({agent:'codex',pane_id:'w2:p5',workspace_id:'w2',tab_id:'w2:t2',agent_status:'idle',state_change_seq:2},{agent:'claude',pane_id:'w2:p4',workspace_id:'w2',tab_id:'w2:t2',agent_status:'idle',state_change_seq:1,remote_answers:true});
  f.h.panes.push({pane_id:'w2:p4',workspace_id:'w2',tab_id:'w2:t2'},{pane_id:'w2:p5',workspace_id:'w2',tab_id:'w2:t2'});
  f.store.data.topics.push({...f.topic('om_1'),id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p4'});
  const offered=card=>find(card,'select_static')[0].options.map(o=>o.text.content);
  await f.send({messageId:'om_a',content:'/adopt'});
  assert.deepEqual(offered(f.pickers()[0]),['cpu2 · 赤尾重构 · Claude · 空闲','cpu2 · 出题 (w2:p2) · Codex · 运行中','cpu2 · 出题 (w2:p5) · Codex · 空闲']);
  f.pick('om_bot_1',{machine:'m',pane:'w2:p5',kind:'codex'});await f.settled();
  assert.deepEqual([f.topic('om_a').agentName,f.topic('om_a').title],['出题 (w2:p5)','接管 · 出题 (w2:p5)']);
  // Once a topic holds w2:p5, the Codex left goes by the tab's name alone.
  await f.send({messageId:'om_b',content:'/adopt'});
  assert.deepEqual(offered(f.pickers()[1]),['cpu2 · 赤尾重构 · Claude · 空闲','cpu2 · 出题 · Codex · 运行中']);
  f.pick('om_bot_3',codexChoice,2);await f.settled();
  assert.deepEqual([f.topic('om_b').agentName,f.topic('om_b').title],['出题','接管 · 出题']);
 }finally{f.close();}
});
test('a submission without a chosen agent, or with a value that is no choice of the picker, gets a warning, adopts nothing and draws the picker again so that it can be submitted again',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_cmd',content:'/adopt'});const t=f.topic('om_cmd');f.h.calls.length=0;
  assert.deepEqual(f.pick('om_bot_1',undefined),{toast:{type:'warning',content:'请选择要接管的 Agent'}});await f.settled();
  assert.deepEqual(f.updated,[['a','om_bot_1',pickerCard(2,'请选择要接管的 Agent')]]);
  for(const [i,value] of ['not json','null','{"machine":"m"}'].entries()){
   assert.deepEqual(f.pick('om_bot_1',value,2+i),{toast:{type:'warning',content:'请选择要接管的 Agent'}},value);await f.settled();
   assert.deepEqual(f.updated.at(-1)[2],pickerCard(3+i,'请选择要接管的 Agent'),value);
  }
  assert.equal(f.h.calls.some(c=>c[0]==='pane'),false);assert.deepEqual([t.state,t.paneId],['choosing','']);
  // The picker drawn again takes a choice.
  f.pick('om_bot_1',claudeChoice,5);await f.settled();assert.deepEqual([t.state,t.paneId,t.agentName],['ready','w2:p1','赤尾重构']);
 }finally{f.close();}
});
test('a click on a picker without a topic gets a toast that the card has expired; a second click while one is being adopted waits for it',async()=>{
 const f=await adoptFixture();try{
  assert.deepEqual(f.pick('om_unknown',claudeChoice),{toast:{type:'info',content:'这张卡片已失效，请重新发送 /adopt'}});
  await f.send({messageId:'om_cmd',content:'/adopt'});
  let release;f.h.on['pane remote-answers']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
  f.pick('om_bot_1',claudeChoice);await later(5);
  assert.deepEqual(f.pick('om_bot_1',codexChoice,1,'ou_owner'),{toast:{type:'info',content:'正在接管，请稍候'}});
  release();await f.settled();assert.equal(f.topic('om_cmd').paneId,'w2:p1');assert.equal(f.h.calls.filter(c=>c[0]==='pane').length,1);
 }finally{f.close();}
});
test('an adopted topic prompts its pane, forwards only the replies after the one in the intro, sends request cards, opens a COT for a prompted message and completes it when the turn ends, and never opens a tab',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);f.h.calls.length=0;f.h.machines.length=0;f.replies.length=0;f.api.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'继续'});
  assert.deepEqual(callsOn(f),[['m','agent','list'],['m','agent','prompt','w2:p1','继续']]);assert.deepEqual([t.reactions,t.cot.origin,t.cot.stateSeq],[[],'om_2',4]);
  assert.deepEqual(cotLog(f),[['create','om_2'],['update','c2',['RUN_STARTED',{threadId:'om_cmd',runId:'om_2'}]]]);
  const agent=f.h.agents.find(a=>a.pane_id==='w2:p1');f.h.retained['w2:p1'].push({seq:3,text:'新回复'});f.h.requests['w2:p1']=[bash];f.h.calls.length=0;
  await f.topics.sync(f.m,f.h.agents.map(a=>a===agent?{...a,reply_seq:3,request_ids:[1],agent_status:'done',state_change_seq:9}:a));
  assert.deepEqual(f.replies.map(r=>r[2]),['om_cmd','om_cmd']);assert.deepEqual(f.replies[0][3],replyOf('新回复'));assert.equal(f.replies[1][3].card.header.title.content,'权限确认 · Bash');
  assert.deepEqual(f.h.calls,[['agent','replies','w2:p1','--after','2'],['agent','requests','w2:p1']]);
  assert.deepEqual(cotLog(f).slice(2),[['update','c2',['RUN_FINISHED',{threadId:'om_cmd',runId:'om_2',status:'done'}]],['complete','c2','done']]);assert.equal(t.cot,undefined);
  assert.deepEqual(t.cards,[{requestId:1,messageId:'om_bot_5',title:'权限确认 · Bash'}]);
 }finally{f.close();}
});
test('/release in an adopted topic turns off its remote answers and ends the topic without touching the pane, which keeps running; later messages are not prompted',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);await f.send({messageId:'om_2',rootId:'om_cmd',content:'继续'});
  f.h.calls.length=0;f.replies.length=0;f.reacted.length=0;f.unreacted.length=0;f.api.length=0;
  await f.send({messageId:'om_3',rootId:'om_cmd',content:' /release '});
  assert.deepEqual(f.h.calls,[['pane','remote-answers','w2:p1','off']]);assert.equal(t.state,'closed');assert.equal(new Store(f.dir).data.topics.find(x=>x.id===t.id).state,'closed');
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_cmd',notice('已结束接管。Agent 仍在终端的 pane 里运行，话题里的消息不再发给它')]]);
  assert.equal(f.h.agents.find(a=>a.pane_id==='w2:p1').remote_answers,undefined);assert.deepEqual(adoptLogs(f).at(-1),['info','个人助手：已结束接管 cpu2 上的 赤尾重构']);
  // The command gets no reaction; the COT of the turn still running ends as failed with the topic.
  assert.deepEqual(f.reacted,[]);assert.deepEqual(f.unreacted,[]);assert.deepEqual(cotLog(f),[['update','c2',['RUN_ERROR',{message:'话题已结束'}]],['complete','c2','error']]);
  f.h.calls.length=0;await f.send({messageId:'om_4',rootId:'om_cmd',content:'还在吗'});await f.send({messageId:'om_5',rootId:'om_cmd',content:'/release'});
  assert.deepEqual(f.h.calls,[]);assert.equal(f.replies.length,1);
 }finally{f.close();}
});
test('/release anywhere but an adopted topic is an ordinary message: a bridge topic prompts it to its agent',async()=>{
 const f=await adoptFixture();try{
  await f.send({messageId:'om_2',rootId:'om_1',content:'/release'});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w1:p1','/release']]);assert.equal(f.topic('om_1').state,'ready');
 }finally{f.close();}
});
test('when /release cannot turn off remote answers the topic stays linked with a notice, unless its agent turns out to be gone, which ends the topic',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice);f.replies.length=0;
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'/release'});
  assert.equal(t.state,'ready');assert.deepEqual(f.replies.map(r=>r[3]),[notice('未能结束接管，请稍后重试')]);assert.match(adoptLogs(f).at(-1)[1],/^个人助手：未能结束接管，连接超时/);
  f.h.agents=f.h.agents.filter(a=>a.pane_id!=='w2:p1');f.h.on['pane remote-answers']=()=>{throw coded('pane_not_found','pane w2:p1 not found');};f.replies.length=0;
  await f.send({messageId:'om_3',rootId:'om_cmd',content:'/release'});
  assert.equal(t.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[adoptedGone]);
 }finally{f.close();}
});
test('in a binding that requires the mention, a topic that waits for a choice ignores messages without it; with it they get the notice to choose',async()=>{
 const f=await adoptFixture({requireMention:true});try{
  await f.send({messageId:'om_cmd',content:'/adopt',mentionedBot:true});const t=f.topic('om_cmd');f.h.calls.length=0;f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'选好了吗'});
  assert.deepEqual([f.h.calls,f.replies,f.reacted,t.messageIds],[[],[],[],['om_cmd']]);
  await f.send({messageId:'om_3',rootId:'om_cmd',content:'选好了吗',mentionedBot:true});
  assert.deepEqual(f.replies.map(r=>r[3]),[notice('请先在上面的卡片中选择要接管的 Agent')]);assert.deepEqual(t.messageIds,['om_cmd','om_3']);
 }finally{f.close();}
});
test('in a binding that requires the mention, messages in an adopted topic need it too, /release included: without it the topic stays linked and nothing is prompted',async()=>{
 const f=await adoptFixture({requireMention:true});try{
  const t=await f.adopt('om_cmd',claudeChoice);assert.equal(t.state,'ready');f.h.calls.length=0;f.replies.length=0;f.reacted.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',content:'继续'});await f.send({messageId:'om_3',rootId:'om_cmd',content:'/release'});
  assert.deepEqual([f.h.calls,f.replies,f.reacted,t.state,t.messageIds],[[],[],[],'ready',['om_cmd']]);
  await f.send({messageId:'om_4',rootId:'om_cmd',content:'继续',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','prompt','w2:p1','继续']]);f.h.calls.length=0;
  await f.send({messageId:'om_5',rootId:'om_cmd',content:'/release',mentionedBot:true});
  assert.deepEqual(f.h.calls,[['pane','remote-answers','w2:p1','off']]);assert.equal(t.state,'closed');
 }finally{f.close();}
});
test('an adopted topic ends with its own notice when its pane closes, its agent exits or another agent takes the pane; no pane is closed',async()=>{
 const changes={gone:agents=>agents.filter(a=>a.pane_id!=='w2:p1'),replaced:agents=>agents.map(a=>a.pane_id==='w2:p1'?{...a,agent:'codex',agent_session:undefined,remote_answers:undefined}:a)};
 for(const [name,change] of Object.entries(changes)){
  const f=await adoptFixture();try{
   const t=await f.adopt('om_cmd',claudeChoice);f.h.calls.length=0;f.replies.length=0;f.h.agents=change(f.h.agents);
   await f.topics.sync(f.m,f.h.agents);
   assert.equal(t.state,'closed',name);assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_cmd',adoptedGone]],name);assert.deepEqual(f.h.calls,[['agent','list']],name);
   assert.equal(f.topic('om_1').state,'ready',name);
  }finally{f.close();}
 }
});
test('removing a binding drops its topics, turns off remote answers for those linked to an agent, bridge-opened or adopted, and shows their open COT failed; a failure is only logged',async()=>{
 const f=await adoptFixture();try{
  await f.adopt('om_cmd',claudeChoice);await f.send({messageId:'om_cmd2',content:'/adopt'});
  const {cot,...linked}=f.topic('om_1'),other={...linked,id:'other',bindingId:'other',rootId:'om_other',paneId:'w2:p2'};f.store.data.topics.push(other);
  f.h.calls.length=0;f.h.machines.length=0;f.api.length=0;
  await f.topics.unbind('b');
  assert.deepEqual(f.store.data.topics,[other]);assert.deepEqual(new Store(f.dir).data.topics.map(t=>t.id),['other']);
  assert.deepEqual(callsOn(f),[['m','pane','remote-answers','w1:p1','off'],['m','pane','remote-answers','w2:p1','off']]);
  assert.equal(cot.cotId,'c1');assert.deepEqual(cotLog(f),[['update','c1',['RUN_ERROR',{message:'话题已结束'}]],['complete','c1','error']]);
  f.h.on['pane remote-answers']=()=>{throw Error('连接超时，请检查 SSH 与 Herdr 状态');};await f.topics.unbind('other');
  assert.deepEqual(f.store.data.topics,[]);assert.match(f.store.data.logs.at(-1).message,/未能关闭.*连接超时/);
 }finally{f.close();}
});
test('an adopted topic writes attachments under the working directory that Herdr reports for its agent, where the agent runs before where its shell is; without one they fail; /release removes the directory',async()=>{
 const f=await adoptFixture();try{
  const t=await f.adopt('om_cmd',claudeChoice),prompts=()=>f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),root='/home/someone/code/herdr/.herdr-bridge';f.replies.length=0;
  await f.send({messageId:'om_2',rootId:'om_cmd',...imageOf('img_a')});
  assert.deepEqual(f.stored,[['m',root,t.id,'om_2-1.png','data:img_a']]);assert.deepEqual(prompts().at(-1),`[图片 1：${root}/${t.id}/om_2-1.png]`);
  const agent=f.h.agents.find(a=>a.pane_id==='w2:p1');agent.foreground_cwd='/home/someone/code/herdr/sub';
  await f.send({messageId:'om_3',rootId:'om_cmd',...imageOf('img_b')});
  assert.equal(f.stored.at(-1)[1],'/home/someone/code/herdr/sub/.herdr-bridge');assert.equal(t.attachmentDir,`/home/someone/code/herdr/sub/.herdr-bridge/${t.id}`);
  delete agent.foreground_cwd;delete agent.cwd;assert.deepEqual(f.replies,[]);
  await f.send({messageId:'om_4',rootId:'om_cmd',...imageOf('img_c')});
  assert.deepEqual([f.stored.length,f.downloads.length,prompts().at(-1)],[2,2,'[图片 1：下载失败]']);assert.deepEqual(f.replies.map(r=>r[3]),[notice('未能把附件交给 Agent：图片 1 写入失败')]);
  assert.match(attachmentLogs(f).at(-1)[1],/图片 1 写入失败，Agent 的工作目录未知/);
  await f.send({messageId:'om_5',rootId:'om_cmd',content:'/release'});
  assert.equal(t.state,'closed');assert.deepEqual(f.removed,[['m',`/home/someone/code/herdr/sub/.herdr-bridge/${t.id}`]]);assert.equal(t.attachmentDir,undefined);
 }finally{f.close();}
});

// A throwaway repository main with one commit, in a directory of its own; target(branch) is where the worktree of branch goes, and
// origin(branch) gives main an origin that has branch, which main has not fetched.
function gitRepo(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-wt-'))),main=path.join(root,'main');fs.mkdirSync(main);
 git(main,'init','-q','-b','main');git(main,'commit','-q','--allow-empty','-m','init');
 return {root,main,target:branch=>path.join(root,'main-worktrees',branch.replaceAll('/','-')),
  origin(branch){const origin=path.join(root,'origin.git');git(root,'clone','-q','--bare',main,origin);git(main,'remote','add','origin',origin);git(origin,'branch',branch,'main');},
  close(){fs.rmSync(root,{recursive:true,force:true});}};
}
// A topic fixture whose binding works in a repository of its own (see gitRepo), by default in its main checkout.
function wtFixture({binding,...options}={}){const repo=gitRepo(),f=topicFixture({...options,binding:{cwd:repo.main,...binding}});return {...f,repo,close(){f.close();repo.close();}};}
const gitArgs=(cwd,...args)=>['env','GIT_TERMINAL_PROMPT=0','LC_ALL=C','git','-C',{path:cwd},...args];
const namingArgs=root=>['sh','-c','cd -- "$1" && exec claude -p --model haiku','sh',root];
// A notice of several lines, whose summary has its whitespace collapsed and holds at most 100 code points.
const noticeOf=text=>{const s=[...text.replace(/\s+/g,' ').trim()];return notice(text,s.length>100?s.slice(0,99).join('')+'…':s.join(''));};
const intro=(branch,p,...notes)=>noticeOf(['已在 cpu2 新建 worktree',`分支：${branch}`,`路径：${p}`,...notes].join('\n'));
const wtUsage=notice('用法：/wt <任务描述>，或 /wt -b <已有分支> [任务描述]'),notRetried=notice('这个 worktree 话题没有启动成功，请重新发送 /wt 开新话题');
const randomName=/^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/;
const removeButton=render=>({tag:'button',text:{tag:'plain_text',content:'删除 worktree'},type:'danger',behaviors:[{type:'callback',value:{worktree:'remove',render}}]});
const keptHint=plainText('worktree 已保留。删除时如有未提交的改动会拒绝，分支始终保留');
// The card of a worktree topic without an agent: heading and text, the branch and path of its worktree, then the hint and the button drawn
// with render, what a click that removed nothing found and the button, or who removed it.
const removalCardOf=(heading,text,branch,p,{render,refused,removed}={})=>cardOf(heading,removed?'green':refused?'orange':'grey',[plainText(text),plainText(`分支：${branch}\n路径：${p}`),
 ...removed?[{tag:'markdown',content:`${removed} · <at id=ou_user></at>`}]:[refused?plainText(refused):keptHint,removeButton(render)]]);
const endedText='该话题的会话已结束，请发起新话题';
// A click on the 删除 worktree button of card messageId as drawn with render, by an allowed person unless openId says otherwise.
const removeClick=(messageId,render,openId='ou_user')=>({messageId,chatId:'oc_1',operator:{openId},action:{tag:'button',value:{worktree:'remove',render}}});
test('worktree branches: haiku\'s answer names a branch only with a clean exit and a valid BRANCH= line, the fallback looks like Herdr\'s names, and the worktree of a branch is beside its repository with / as -',()=>{
 assert.equal(parseBranch('x\nBRANCH=feat/a-b c\nBRANCH=fix/z'),'feat/a-b');assert.equal(parseBranch('nothing'),undefined);
 for(const b of ['feat/add-login','fix/a1','style/x'])assert.ok(validBranch(b),b);
 for(const b of ['feature/x','feat/','feat/Add','feat/a_b','feat/a--b','feat/-a','feat/a/b','feat/'+'a'.repeat(60),'Feat/x'])assert.ok(!validBranch(b),b);
 assert.deepEqual(branchOf({code:0,stdout:'Sure.\nBRANCH=feat/add-login\n',stderr:''}),{branch:'feat/add-login'});
 assert.deepEqual(branchOf({code:1,stdout:'',stderr:' Not logged in \n'}),{reason:'claude 退出码 1：Not logged in'});
 assert.deepEqual(branchOf({code:0,stdout:'BRANCH=Feature/X\n',stderr:''}),{reason:'输出里没有可用的 BRANCH= 行：BRANCH=Feature/X'});
 for(let i=0;i<20;i++)assert.match(randomBranch(),randomName);
 assert.equal(worktreePath('/src/genvi','feat/a/b'),'/src/genvi-worktrees/feat-a-b');assert.equal(continueBranch('fix/x'),'Continue work on branch fix/x');
 assert.match(namingPrompt('加验证码'),/^You are a git branch naming tool[\s\S]*BRANCH=type\/short-kebab-name[\s\S]*Requirement:\n加验证码$/);
});
test('exec resolves to the exit status and output of a command on a machine whatever the status, and rejects when it cannot start, does not finish in time or ssh itself fails; with shell, a local command line goes through the user\'s shell like an SSH command, without the HERDR_* variables',async()=>{
 const local=normalizeMachine({name:'local',type:'local'}),ssh=normalizeMachine({name:'cpu2',host:'cpu2'}),shell=os.userInfo().shell||'/bin/sh';
 assert.deepEqual(await exec(local,['sh','-c','echo out; echo err >&2; exit 3']),{code:3,stdout:'out\n',stderr:'err\n'});
 await assert.rejects(exec(local,['sleep','5'],{timeoutMs:100}),e=>e.timedOut===true&&/连接超时/.test(e.message));
 await assert.rejects(exec(local,['/nonexistent/bridge-program']),/ENOENT/);
 assert.deepEqual(remoteInvocation(local,['sh','-c','exec claude "$@"',{path:'~/w x'}],{shell:true}),[shell,['-c',`'sh' '-c' 'exec claude "$@"' "$HOME"/'w x'`]]);
 assert.deepEqual(remoteInvocation(ssh,['claude','-p'],{shell:true}),remoteInvocation(ssh,['claude','-p']));
 const r=await withEnv('HERDR_PANE_ID','w1:p1',()=>exec(local,['sh','-c','env; printf "%s" "$1"','sh',{path:'~/x'}],{shell:true}));
 assert.equal(r.code,0);assert.doesNotMatch(r.stdout,/^HERDR_/m);assert.ok(r.stdout.endsWith(os.homedir()+'/x'),r.stdout.slice(-200));
 // A fake ssh that runs the remote command here: its status comes back, and 255 is the failure of ssh itself.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-exec-')),bin=path.join(dir,'bin');fs.mkdirSync(bin);
 try{
  fs.writeFileSync(path.join(bin,'ssh'),['#!/bin/sh','for last; do :; done','exec sh -c "$last"',''].join('\n'),{mode:0o700});
  await withEnv('PATH',bin+':'+process.env.PATH,async()=>{
   assert.deepEqual(await exec(ssh,['sh','-c','echo no >&2; exit 1']),{code:1,stdout:'',stderr:'no\n'});
   fs.writeFileSync(path.join(bin,'ssh'),['#!/bin/sh','echo "ssh: connect to host cpu2 port 22: Connection refused" >&2','exit 255',''].join('\n'),{mode:0o700});
   await assert.rejects(exec(ssh,['true']),/Connection refused/);
  });
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('/wt with a description names the branch with Claude haiku on the binding machine, creates the worktree beside the repository through Herdr without changing focus, starts the agent in its root pane like any topic, names the branch and path in its first reply and prompts the description',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',content:'/wt 给登录页加验证码\n第二行'});
  const t=f.store.data.topics[0],target=f.repo.target('feat/add-login');
  assert.deepEqual(f.naming,[{argv:namingArgs(f.repo.main),input:namingPrompt('给登录页加验证码\n第二行'),timeoutMs:30000,shell:true}]);
  assert.deepEqual(f.execs,[['m',...gitArgs(f.repo.main,'rev-parse','--path-format=absolute','--git-dir','--git-common-dir')],['m',...namingArgs(f.repo.main)],['m','test','-e',{path:target}],
   ['m',...gitArgs(f.repo.main,'show-ref','--verify','--quiet','refs/heads/feat/add-login')],['m',...gitArgs(f.repo.main,'fetch','--quiet','origin','+refs/heads/feat/add-login:refs/remotes/origin/feat/add-login')],
   ['m',...gitArgs(f.repo.main,'show-ref','--verify','--quiet','refs/remotes/origin/feat/add-login')]]);
  assert.deepEqual(f.h.calls,[['worktree','create','--cwd',f.repo.main,'--branch','feat/add-login','--path',target,'--no-focus'],['agent','start',t.agentName,'--kind','claude','--pane','w1:p1','--timeout','60000','--','--permission-mode','default'],
   ['pane','remote-answers','w1:p1','on'],['agent','prompt','w1:p1','给登录页加验证码\n第二行']]);
  assert.deepEqual(f.h.timeouts.slice(0,2),[120000,70000]);assert.deepEqual([...new Set(f.h.machines)],['m']);
  assert.equal(git(target,'rev-parse','--abbrev-ref','HEAD'),'feat/add-login');assert.equal(git(target,'rev-parse','HEAD'),git(f.repo.main,'rev-parse','HEAD'));
  const worktree={branch:'feat/add-login',path:target,root:f.repo.main};
  assert.deepEqual([t.state,t.workspaceId,t.tabId,t.paneId,t.title,t.worktree],['ready','w1','w1:t1','w1:p1','给登录页加验证码 第二行',worktree]);assert.match(t.agentName,/^feishu-[0-9a-f]{8}$/);
  assert.deepEqual(new Store(f.dir).data.topics[0].worktree,worktree);assert.equal(f.b.workspaceId,undefined);
  assert.deepEqual(f.replies,[['a','oc_1','om_1',intro('feat/add-login',target)]]);
  assert.deepEqual(f.reacted.map(r=>r[1]),['om_1']);assert.deepEqual(cotLog(f)[0],['create','om_1']);
 }finally{f.close();}
});
test('a /wt topic places Bridge\'s skills in its new worktree, once Herdr created it and right before its agent starts',async()=>{
 const f=wtFixture({binding:{kind:'codex'}});try{
  await f.send({messageId:'om_1',content:'/wt 给登录页加验证码'});
  assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)).slice(0,2),[['worktree','create'],['agent','start']]);assert.deepEqual(f.placed,[['m',f.repo.target('feat/add-login'),'codex',1]]);
 }finally{f.close();}
});
test('/wt -b with a local branch uses it as it is, without naming or fetching; without a description the agent is asked to continue on the branch and the topic is named after it',async()=>{
 const f=wtFixture();try{
  git(f.repo.main,'branch','feat/local');git(f.repo.main,'branch','fix/crash');
  await f.send({messageId:'om_1',content:'/wt -b feat/local'});await f.send({messageId:'om_2',content:'/wt -b fix/crash  接着做\n完'});
  const [one,two]=f.store.data.topics;
  assert.deepEqual(f.naming,[]);assert.ok(!f.execs.some(c=>c.includes('fetch')));
  assert.deepEqual(f.h.calls.filter(c=>c[0]==='worktree'),[['worktree','create','--cwd',f.repo.main,'--branch','feat/local','--path',f.repo.target('feat/local'),'--no-focus'],['worktree','create','--cwd',f.repo.main,'--branch','fix/crash','--path',f.repo.target('fix/crash'),'--no-focus']]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c.slice(2)),[[one.paneId,'Continue work on branch feat/local'],[two.paneId,'接着做\n完']]);
  assert.deepEqual([one.title,two.title,one.worktree.branch,two.worktree.branch],['feat/local','接着做 完','feat/local','fix/crash']);
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',intro('feat/local',f.repo.target('feat/local'))],['om_2',intro('fix/crash',f.repo.target('fix/crash'))]]);
 }finally{f.close();}
});
test('/wt -b with a branch that only origin has fetches it and creates a local branch that tracks it, which the first reply says; a branch that neither has, or an invalid name, fails before anything is created',async()=>{
 const f=wtFixture();try{
  f.repo.origin('feat/remote');await f.send({messageId:'om_1',content:'/wt -b feat/remote 接着做'});
  const target=f.repo.target('feat/remote');
  assert.equal(git(f.repo.main,'rev-parse','--abbrev-ref','feat/remote@{upstream}'),'origin/feat/remote');assert.equal(git(target,'rev-parse','--abbrev-ref','HEAD'),'feat/remote');
  assert.deepEqual(f.replies.map(r=>r[3]),[intro('feat/remote',target,'已从 origin/feat/remote 建立跟踪它的本地分支')]);assert.equal(f.store.data.topics[0].state,'ready');
  f.replies.length=0;f.h.calls.length=0;
  await f.send({messageId:'om_2',content:'/wt -b feat/missing x'});await f.send({messageId:'om_3',content:'/wt -b bad..name x'});
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_2',noticeOf('启动失败：本地和 origin 都没有分支 feat/missing\n没有创建任何东西')],['om_3',noticeOf('启动失败：分支名无效：bad..name\n没有创建任何东西')]]);
  assert.deepEqual(f.store.data.topics.slice(1).map(t=>[t.state,t.worktree]),[['failed',{}],['failed',{}]]);assert.deepEqual(f.h.calls,[]);
  assert.equal(fs.existsSync(f.repo.target('feat/missing')),false);assert.notEqual(gitIn(f.repo.main,'show-ref','--verify','--quiet','refs/heads/feat/missing').status,0);
 }finally{f.close();}
});
test('a naming that fails falls back to a random worktree/ branch and the first reply says why: claude exits with an error, prints no usable BRANCH= line, cannot run or does not answer in time',async()=>{
 const cases=[[{code:1,stderr:'Not logged in\n'},'claude 退出码 1：Not logged in'],[{stdout:'BRANCH=Feature/Add Login\n'},'输出里没有可用的 BRANCH= 行：BRANCH=Feature/Add Login'],
  [Error('spawn sh ENOENT'),'无法运行 claude：spawn sh ENOENT'],[Object.assign(Error('连接超时，请检查 SSH 与 Herdr 状态'),{timedOut:true}),'30 秒内没有返回']];
 for(const [claude,reason] of cases){
  const f=wtFixture();try{
   f.h.claude=claude;await f.send({messageId:'om_1',content:'/wt 任务描述'});
   const t=f.store.data.topics[0],branch=t.worktree.branch;
   assert.match(branch,randomName,reason);assert.equal(t.state,'ready',reason);assert.deepEqual(f.h.calls[0].slice(4,8),['--branch',branch,'--path',f.repo.target(branch)],reason);
   assert.deepEqual(f.replies.map(r=>r[3]),[intro(branch,f.repo.target(branch),`起名失败（${reason}），改用随机分支名`)],reason);
  }finally{f.close();}
 }
});
test('/wt in a binding whose directory is outside Git fails the topic with the reason in its thread before anything is created; later messages in its thread get a notice and start nothing',async()=>{
 const f=wtFixture();try{
  const plain=path.join(f.repo.root,'plain');fs.mkdirSync(plain);f.b.cwd=plain;
  await f.send({messageId:'om_1',content:'/wt x'});
  const t=f.store.data.topics[0];
  assert.deepEqual([t.state,t.error,t.worktree],['failed',`${plain} 不在 Git 仓库中`,{}]);assert.deepEqual([f.h.calls,f.naming,f.execs.length],[[],[],1]);
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',noticeOf(`启动失败：${plain} 不在 Git 仓库中\n没有创建任何东西`)]]);
  await f.send({messageId:'om_2',rootId:'om_1',content:'再试一次'});
  assert.deepEqual(f.replies.at(-1).slice(2),['om_1',notRetried]);assert.deepEqual([f.h.calls,f.execs.length],[[],1]);assert.deepEqual(t.messageIds,['om_1','om_2']);
 }finally{f.close();}
});
test('/wt in a binding whose directory is in a linked worktree creates the new worktree from the main checkout and beside it, with the HEAD of the linked worktree as base',async()=>{
 const f=wtFixture();try{
  const linked=path.join(f.repo.root,'linked');git(f.repo.main,'worktree','add','-q','-b','side',linked);
  fs.writeFileSync(path.join(linked,'a.txt'),'x');git(linked,'add','a.txt');git(linked,'commit','-q','-m','side');fs.mkdirSync(path.join(linked,'sub'));
  f.b.cwd=path.join(linked,'sub');const head=git(linked,'rev-parse','HEAD'),target=f.repo.target('feat/add-login');
  await f.send({messageId:'om_1',content:'/wt from the side'});
  assert.deepEqual(f.h.calls[0],['worktree','create','--cwd',f.repo.main,'--branch','feat/add-login','--path',target,'--base',head,'--no-focus']);
  assert.equal(git(target,'rev-parse','HEAD'),head);assert.deepEqual(f.store.data.topics[0].worktree,{branch:'feat/add-login',path:target,root:f.repo.main});
  assert.deepEqual(f.replies.map(r=>r[3]),[intro('feat/add-login',target,`绑定目录在 linked worktree 里，新分支基于它的 HEAD ${head.slice(0,12)}`)]);assert.deepEqual(f.naming[0].argv,namingArgs(f.repo.main));
 }finally{f.close();}
});
test('/wt whose worktree directory exists already fails before anything is created and names the directory',async()=>{
 const f=wtFixture();try{
  const target=f.repo.target('feat/add-login');fs.mkdirSync(target,{recursive:true});
  await f.send({messageId:'om_1',content:'/wt x'});
  assert.deepEqual(f.replies.map(r=>r[3]),[noticeOf(`启动失败：目录已存在：${target}，不会覆盖它；换一个分支，或者先处理这个目录\n没有创建任何东西`)]);
  assert.deepEqual([f.store.data.topics[0].state,f.h.calls],['failed',[]]);assert.notEqual(gitIn(f.repo.main,'show-ref','--verify','--quiet','refs/heads/feat/add-login').status,0);
 }finally{f.close();}
});
test('in a binding that requires the mention, /wt without it is ignored like any message; with it it opens a worktree topic',async()=>{
 const f=wtFixture({binding:{requireMention:true}});try{
  await f.send({messageId:'om_1',content:'/wt x'});
  assert.deepEqual([f.store.data.topics,f.execs,f.h.calls,f.replies,f.reacted],[[],[],[],[],[]]);
  await f.send({messageId:'om_2',content:'/wt x',mentionedBot:true});
  assert.deepEqual([f.store.data.topics[0].state,f.store.data.topics[0].worktree.branch],['ready','feat/add-login']);
 }finally{f.close();}
});
test('/wt without a description or a branch, or -b without a branch, gets the usage in its thread and opens no topic; /wt in a thread and other text that starts with /wt are messages like any other',async()=>{
 const f=wtFixture();try{
  for(const [id,content] of [['om_1','/wt'],['om_2',' /wt  '],['om_3','/wt -b']])await f.send({messageId:id,content});
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',wtUsage],['om_2',wtUsage],['om_3',wtUsage]]);assert.deepEqual([f.store.data.topics,f.execs,f.h.calls,f.reacted],[[],[],[],[]]);
  await f.send({messageId:'om_4',content:'/wtx 普通消息'});await f.send({messageId:'om_5',rootId:'om_4',content:'/wt 话题里的消息'});
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['/wtx 普通消息','/wt 话题里的消息']);assert.equal(f.store.data.topics[0].worktree,undefined);assert.deepEqual(f.execs,[]);
 }finally{f.close();}
});
test('the images and files of a /wt topic go under its worktree, those of the /wt message too, which the naming leaves out; a /wt with attachments but no text is not named',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',rawContentType:'post',content:'/wt 看看这个报错 ![image](img_b)',resources:[{type:'image',fileKey:'img_b'}]});
  const t=f.store.data.topics[0],target=f.repo.target('feat/add-login'),root=`${target}/.herdr-bridge`,dir=`${root}/${t.id}`;
  assert.equal(f.naming[0].input,namingPrompt('看看这个报错'));
  assert.deepEqual(f.stored,[['m',root,t.id,'om_1-1.png','data:img_b']]);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),[`看看这个报错 [图片 1：${dir}/om_1-1.png]`]);assert.deepEqual([t.title,t.attachmentDir],['看看这个报错',dir]);
  await f.send({messageId:'om_2',rootId:'om_1',...imageOf('img_c')});
  assert.deepEqual(f.stored.at(-1).slice(0,4),['m',root,t.id,'om_2-1.png']);assert.equal(f.h.calls.filter(c=>c[1]==='prompt').at(-1)[3],`[图片 1：${dir}/om_2-1.png]`);
  await f.send({messageId:'om_3',rawContentType:'post',content:'/wt ![image](img_d)',resources:[{type:'image',fileKey:'img_d'}]});
  const other=f.store.data.topics[1],branch=other.worktree.branch;
  assert.equal(f.naming.length,1);assert.match(branch,randomName);assert.equal(other.title,'图片');
  assert.deepEqual(f.replies.at(-1)[3],intro(branch,f.repo.target(branch),'起名失败（任务描述里没有文字），改用随机分支名'));
  assert.equal(f.h.calls.filter(c=>c[1]==='prompt').at(-1)[3],`[图片 1：${f.repo.target(branch)}/.herdr-bridge/${other.id}/om_3-1.png]`);
 }finally{f.close();}
});
test('a /wt topic whose agent cannot start fails with the reason and what exists in a card that offers removing the worktree; nothing is rolled back and later messages start nothing; a worktree that Herdr could not create leaves a plain notice',async()=>{
 const f=wtFixture();try{
  f.h.on['agent start']=()=>{throw coded('agent_start_failed','agent process exited before becoming interactive');};
  await f.send({messageId:'om_1',content:'/wt x'});
  const t=f.store.data.topics[0],target=f.repo.target('feat/add-login');
  const text=`启动失败：agent process exited before becoming interactive（agent_start_failed）\n已经创建、保持原样（没有回滚）的有：\n- worktree ${target}（分支 feat/add-login）\n- workspace w1，pane w1:p1`;
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[['om_1',intro('feat/add-login',target)],['om_1',{card:removalCardOf('启动失败',text,'feat/add-login',target,{render:1})}]]);
  assert.deepEqual([t.state,t.worktree.card],['failed',{messageId:'om_bot_2',heading:'启动失败',text}]);assert.ok(fs.existsSync(target));assert.ok(f.h.workspaces.some(w=>w.checkout===target));
  f.h.calls.length=0;await f.send({messageId:'om_2',rootId:'om_1',content:'再试'});
  assert.deepEqual(f.h.calls,[]);assert.deepEqual(f.replies.at(-1)[3],notRetried);
  // The button works on this card too.
  f.topics.click(allowed,removeClick('om_bot_2',1));await Promise.all(f.topics.answering.values());assert.equal(fs.existsSync(target),false);
  f.h.claude={stdout:'BRANCH=fix/other'};f.h.on['worktree create']=()=>{throw coded('worktree_create_failed','fatal: invalid reference: HEAD');};
  await f.send({messageId:'om_3',content:'/wt y'});
  assert.deepEqual(f.replies.at(-1).slice(2),['om_3',noticeOf('启动失败：创建 worktree 失败（worktree_create_failed：fatal: invalid reference: HEAD）\n没有创建任何东西')]);
  assert.deepEqual(f.store.data.topics[1].worktree,{branch:'fix/other',path:f.repo.target('fix/other'),root:f.repo.main});
  // A worktree that Herdr created but opened no workspace for is offered for removal, which git does.
  f.h.claude={stdout:'BRANCH=fix/open'};f.h.on['worktree create']=(args,run)=>{run(args);f.h.workspaces.pop();throw coded('worktree_open_failed','created worktree but failed to open workspace: no space');};
  await f.send({messageId:'om_4',content:'/wt z'});const open=f.repo.target('fix/open');
  const failedOpen=`启动失败：创建 worktree 失败（worktree_open_failed：created worktree but failed to open workspace: no space）\n已经创建、保持原样（没有回滚）的有：\n- worktree ${open}（分支 fix/open），Herdr 没有为它打开 workspace`;
  assert.deepEqual(f.replies.at(-1).slice(2),['om_4',{card:removalCardOf('启动失败',failedOpen,'fix/open',open,{render:3})}]);assert.ok(fs.existsSync(open));
  f.topics.click(allowed,removeClick(f.store.data.topics[2].worktree.card.messageId,3));await Promise.all(f.topics.answering.values());
  assert.equal(fs.existsSync(open),false);assert.deepEqual(f.execs.at(-1),['m',...gitArgs(f.repo.main,'worktree','remove',open)]);
 }finally{f.close();}
});
test('a /wt topic whose agent is gone ends with a card that keeps the worktree and offers removing it; a click by an allowed person removes a clean worktree through Herdr, which closes its workspace, keeps the branch and marks the card removed, also after a Bridge restart',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',content:'/wt x'});const target=f.repo.target('feat/add-login');
  f.h.agents=[];await f.topics.sync(f.m,[]);
  const t=f.store.data.topics[0];
  assert.equal(t.state,'closed');assert.deepEqual(f.replies.at(-1).slice(2),['om_1',{card:removalCardOf('话题已结束',endedText,'feat/add-login',target,{render:1})}]);
  assert.deepEqual(t.worktree,{branch:'feat/add-login',path:target,root:f.repo.main,card:{messageId:'om_bot_2',heading:'话题已结束',text:endedText}});assert.ok(fs.existsSync(target));
  // What the agent left under .herdr-bridge, which ignores itself, is no change.
  fs.mkdirSync(path.join(target,'.herdr-bridge','x'),{recursive:true});fs.writeFileSync(path.join(target,'.herdr-bridge','.gitignore'),'*\n');fs.writeFileSync(path.join(target,'.herdr-bridge','x','a.png'),'png');
  const {topics}=f.restart();f.h.calls.length=0;f.execs.length=0;
  assert.deepEqual(topics.click(allowed,removeClick('om_bot_2',1)),{toast:{type:'info',content:'正在删除 worktree'}});
  await Promise.all(topics.answering.values());
  assert.deepEqual(f.h.calls,[['worktree','list','--cwd',f.repo.main],['worktree','remove','--workspace','w1']]);
  assert.deepEqual(f.execs,[['m','test','-e',{path:target}],['m',...gitArgs(target,'-c','core.quotePath=false','status','--porcelain','--untracked-files=all')]]);
  assert.equal(fs.existsSync(target),false);assert.equal(git(f.repo.main,'rev-parse','--verify','feat/add-login'),git(f.repo.main,'rev-parse','main'));assert.equal(f.h.workspaces.some(w=>w.checkout),false);
  assert.deepEqual(f.updated.at(-1),['a','om_bot_2',removalCardOf('话题已结束',endedText,'feat/add-login',target,{removed:'已删除 worktree，分支 feat/add-login 保留'})]);
  assert.equal(new Store(f.dir).data.topics[0].worktree.removed,true);
  assert.deepEqual(topics.click(allowed,removeClick('om_bot_2',1)),{toast:{type:'info',content:'worktree 已删除'}});assert.deepEqual(topics.click(allowed,removeClick('om_other',1)),{toast:{type:'info',content:'这张卡片已失效'}});
 }finally{f.close();}
});
test('the 删除 worktree button refuses a worktree with changes that are not committed and lists them, removes it with git once Herdr no longer has it open, and counts a worktree that is gone as removed',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',content:'/wt x'});const target=f.repo.target('feat/add-login'),settle=()=>Promise.all(f.topics.answering.values());
  f.h.agents=[];await f.topics.sync(f.m,[]);
  fs.writeFileSync(path.join(target,'new.txt'),'x');fs.writeFileSync(path.join(target,'说明.md'),'x');f.h.calls.length=0;
  f.topics.click(allowed,removeClick('om_bot_2',1));await settle();
  assert.ok(fs.existsSync(target));assert.deepEqual(f.h.calls,[]);assert.equal(f.store.data.topics[0].worktree.removed,undefined);
  assert.deepEqual(f.updated.at(-1)[2],removalCardOf('话题已结束',endedText,'feat/add-login',target,{render:2,refused:'worktree 里有未提交的改动，没有删除：\n?? new.txt\n?? 说明.md'}));
  // Committed work stays on the branch.
  git(target,'add','.');git(target,'commit','-q','-m','work');f.h.workspaces=f.h.workspaces.filter(w=>!w.checkout);f.execs.length=0;
  f.topics.click(allowed,removeClick('om_bot_2',2));await settle();
  assert.deepEqual(f.h.calls,[['worktree','list','--cwd',f.repo.main]]);assert.deepEqual(f.execs.at(-1),['m',...gitArgs(f.repo.main,'worktree','remove',target)]);
  assert.equal(fs.existsSync(target),false);assert.equal(git(f.repo.main,'log','-1','--format=%s','feat/add-login'),'work');
  assert.deepEqual(f.updated.at(-1)[2],removalCardOf('话题已结束',endedText,'feat/add-login',target,{removed:'已删除 worktree，分支 feat/add-login 保留'}));
 }finally{f.close();}
 const g=wtFixture();try{
  await g.send({messageId:'om_1',content:'/wt x'});const target=g.repo.target('feat/add-login');
  g.h.agents=[];await g.topics.sync(g.m,[]);fs.rmSync(target,{recursive:true});g.h.calls.length=0;
  g.topics.click(allowed,removeClick('om_bot_2',1));await Promise.all(g.topics.answering.values());
  assert.deepEqual(g.h.calls,[]);assert.deepEqual(g.updated.at(-1)[2],removalCardOf('话题已结束',endedText,'feat/add-login',target,{removed:'worktree 已不在，按已删除处理'}));
  assert.equal(g.store.data.topics[0].worktree.removed,true);
 }finally{g.close();}
});
test('the 删除 worktree button does nothing for a person outside the allowlist of the app',async()=>{
 const f=wtFixture(),p=platformFixture({channelFactory:()=>({on(){}}),onCardAction:(...args)=>f.topics.click(...args)});try{
  await f.send({messageId:'om_1',content:'/wt x'});const target=f.repo.target('feat/add-login');
  f.h.agents=[];await f.topics.sync(f.m,[]);f.h.calls.length=0;f.execs.length=0;const updates=f.updated.length;
  assert.deepEqual(p.platforms.cardAction(allowed,removeClick('om_bot_2',1,'ou_other')),{toast:{type:'error',content:'你不在这个应用的允许名单中，不能处理这个请求'}});
  assert.equal(f.topics.answering.size,0);assert.deepEqual([f.h.calls,f.execs,f.updated.length],[[],[],updates]);assert.ok(fs.existsSync(target));
  assert.deepEqual(p.platforms.cardAction(allowed,removeClick('om_bot_2',1)),{toast:{type:'info',content:'正在删除 worktree'}});
  await Promise.all(f.topics.answering.values());assert.equal(fs.existsSync(target),false);
 }finally{p.close();f.close();}
});
test('removing the binding of a /wt topic keeps its worktree and its workspace, as any topic keeps its tab',async()=>{
 const f=wtFixture();try{
  await f.send({messageId:'om_1',content:'/wt x'});const target=f.repo.target('feat/add-login');f.h.calls.length=0;
  await f.topics.unbind('b');
  assert.deepEqual(f.h.calls,[['pane','remote-answers','w1:p1','off']]);assert.ok(fs.existsSync(target));assert.ok(f.h.workspaces.some(w=>w.checkout===target));assert.deepEqual(f.store.data.topics,[]);
 }finally{f.close();}
});
const at=iso=>Date.parse(iso);
// Upcoming run times of a cron expression in time zone tz after the ISO time from, as wall times there.
const runsOf=(expression,tz,from,n)=>upcoming(parseCron(expression),tz,at(from),n).map(t=>when(t,tz));
test('a cron expression has five fields of numbers, ranges, steps, lists and English names; anything else is refused, naming the field',()=>{
 for(const [expression,error] of [['',/5 个字段/],['* * * *',/5 个字段/],['* * * * * *',/5 个字段/],['@daily',/5 个字段/],['60 * * * *',/分钟/],['* 24 * * *',/小时/],['* * 0 * *',/日期/],['* * 32 * *',/日期/],['* * * 13 *',/月份/],
  ['* * * * 8',/星期/],['*/0 * * * *',/分钟/],['5-1 * * * *',/分钟/],['1,,2 * * * *',/分钟/],['-1 * * * *',/分钟/],['1.5 * * * *',/分钟/],['* * * * fri-mon',/星期/],['* * * foo *',/月份/],['* * * * monday',/星期/],['? * * * *',/分钟/],['* * L * *',/日期/],['* * * * 1#2',/星期/]])
  assert.throws(()=>parseCron(expression),error,expression);
 // Lists, ranges with steps, a start with a step, and names in any case; 7 is Sunday like 0.
 assert.deepEqual(runsOf(' 0,30  9-17/4 * JAN,nov * ','Asia/Shanghai','2026-11-06T10:00:00+08:00',4),['2026-11-06 13:00','2026-11-06 13:30','2026-11-06 17:00','2026-11-06 17:30']);
 assert.deepEqual(runsOf('5/20 10 * * *','Asia/Shanghai','2026-11-06T10:00:00+08:00',4),['2026-11-06 10:05','2026-11-06 10:25','2026-11-06 10:45','2026-11-07 10:05']);
 assert.deepEqual(runsOf('0 12 * * 7','Asia/Shanghai','2026-11-06T10:00:00+08:00',1),runsOf('0 12 * * sun','Asia/Shanghai','2026-11-06T10:00:00+08:00',1));
 assert.deepEqual(runsOf('0 12 * * 0','Asia/Shanghai','2026-11-06T10:00:00+08:00',1),['2026-11-08 12:00']);
});
test('the runs of an expression are whole minutes of the wall clock of its time zone, strictly after the given time; day of month and day of week count either one when both are restricted, as in cron',()=>{
 const sh='Asia/Shanghai',friday='2026-11-06T10:00:00+08:00';
 assert.deepEqual(runsOf('30 9 * * 1-5',sh,friday,3),['2026-11-09 09:30','2026-11-10 09:30','2026-11-11 09:30']);
 assert.deepEqual(runsOf('0 18 * * MON-FRI',sh,friday,2),['2026-11-06 18:00','2026-11-09 18:00']);
 // A run at the given minute is not after it; one later in the minute is.
 assert.deepEqual(runsOf('*/5 * * * *',sh,friday,2),['2026-11-06 10:05','2026-11-06 10:10']);
 assert.deepEqual(runsOf('*/5 * * * *',sh,'2026-11-06T10:02:30+08:00',1),['2026-11-06 10:05']);
 assert.equal(next(parseCron('0 9 * * *'),'UTC',at(friday)),at('2026-11-06T09:00:00Z'));assert.equal(next(parseCron('0 9 * * *'),sh,at(friday)),at('2026-11-07T09:00:00+08:00'));
 // The 1st or a Monday; with a * in day of month, only Mondays on the 1st, 11th, 21st or 31st.
 assert.deepEqual(runsOf('0 0 1 * 1',sh,'2026-11-24T12:00:00+08:00',3),['2026-11-30 00:00','2026-12-01 00:00','2026-12-07 00:00']);
 assert.deepEqual(runsOf('0 0 */10 * 1',sh,friday,2),['2026-12-21 00:00','2027-01-11 00:00']);
 // February 29 comes years later; February 31 never does.
 assert.deepEqual(runsOf('0 0 29 2 *',sh,friday,2),['2028-02-29 00:00','2032-02-29 00:00']);
 assert.deepEqual(runsOf('0 0 31 2 *',sh,friday,3),[]);assert.equal(next(parseCron('0 0 31 2 *'),sh,at(friday)),null);
 // The latest run strictly before a time.
 assert.equal(previous(parseCron('*/5 * * * *'),sh,at('2026-11-06T10:05:00+08:00')),at('2026-11-06T10:00:00+08:00'));
 assert.equal(previous(parseCron('*/5 * * * *'),sh,at('2026-11-06T10:05:00.001+08:00')),at('2026-11-06T10:05:00+08:00'));
 assert.equal(previous(parseCron('30 9 * * 1-5'),sh,at('2026-11-09T09:00:00+08:00')),at('2026-11-06T09:30:00+08:00'));
 assert.equal(previous(parseCron('0 0 31 2 *'),sh,at(friday)),null);
});
test('a wall time that a daylight saving change skips has no run that day, and one that it repeats runs once, at its first occurrence',()=>{
 const ny='America/New_York',daily=parseCron('30 2 * * *'),night=parseCron('30 1 * * *');
 // 2026-03-08 02:30 does not exist in New York.
 assert.deepEqual(runsOf('30 2 * * *',ny,'2026-03-07T03:00:00-05:00',2),['2026-03-09 02:30','2026-03-10 02:30']);assert.equal(next(daily,ny,at('2026-03-07T03:00:00-05:00')),at('2026-03-09T02:30:00-04:00'));
 // 2026-11-01 01:30 happens at 05:30Z and again at 06:30Z.
 assert.equal(next(night,ny,at('2026-11-01T00:00:00-04:00')),at('2026-11-01T05:30:00Z'));
 assert.equal(next(night,ny,at('2026-11-01T05:30:00Z')),at('2026-11-02T06:30:00Z'));assert.equal(next(night,ny,at('2026-11-01T06:15:00Z')),at('2026-11-02T06:30:00Z'));
 assert.equal(previous(night,ny,at('2026-11-01T07:00:00Z')),at('2026-11-01T05:30:00Z'));
 // 2026-10-25 01:30 happens in London at 00:30Z and again at 01:30Z.
 assert.equal(next(night,'Europe/London',at('2026-10-24T12:00:00Z')),at('2026-10-25T00:30:00Z'));assert.equal(next(night,'Europe/London',at('2026-10-25T00:30:00Z')),at('2026-10-26T01:30:00Z'));
});
test('a time zone is an IANA name that Intl knows, kept in its canonical form; times are shown as wall times there',()=>{
 assert.equal(zone('asia/shanghai'),'Asia/Shanghai');assert.equal(zone('UTC'),'UTC');
 for(const tz of ['','Mars/Base',undefined,8])assert.throws(()=>zone(tz),/时区/,String(tz));
 assert.equal(when(at('2026-11-06T02:00:00Z'),'Asia/Shanghai'),'2026-11-06 10:00');assert.equal(when(at('2026-11-06T02:00:00Z'),'UTC'),'2026-11-06 02:00');
 // With the day of the week of that wall date: 2026-11-08 is a Sunday in Shanghai and still a Saturday in UTC.
 assert.equal(when(at('2026-11-07T16:30:00Z'),'Asia/Shanghai',{weekday:true}),'2026-11-08 周日 00:30');assert.equal(when(at('2026-11-07T16:30:00Z'),'UTC',{weekday:true}),'2026-11-07 周六 16:30');
});
test('an expression reads in plain words: the days, then the times of day or how often; what has no short form is listed field by field',()=>{
 for(const [expression,words] of [
  ['30 9 * * 1-5','每周一至周五 09:30'],['0 9 * * *','每天 09:00'],['0 9,18 * * *','每天 09:00、18:00'],['0 18 * * MON-FRI','每周一至周五 18:00'],
  ['0 9 * * 1,3,5','每周一、周三、周五 09:00'],['0 10 * * 6,0','每周六、周日 10:00'],['0 10 * * 7','每周日 10:00'],
  ['0 0 1 * *','每月 1 日 00:00'],['0 9 1,15 * *','每月 1、15 日 09:00'],['0 9 1-10 * *','每月 1 至 10 日 09:00'],['0 0 1 1 *','每年 1 月的 1 日 00:00'],['0 0 29 2 *','每年 2 月的 29 日 00:00'],
  ['0,30 9-17/4 * JAN,nov *','每年 1、11 月的每天 09:00、09:30、13:00、13:30、17:00、17:30'],['5/20 10 * * *','每天 10:05、10:25、10:45'],
  // Day of month and day of week both restricted: either one, unless one of them starts with *, which makes it both.
  ['0 9 1 * 1','每月 1 日和每周一 09:00'],['0 0 */10 * 1','每月 1、11、21、31 日中的周一 00:00'],['0 0 1-31 * 1','每天 00:00'],
  ['*/5 * * * *','每 5 分钟'],['2/5 * * * *','每 5 分钟（每小时第 2 分钟起）'],['*/15 9-17 * * 1-5','每周一至周五 09:00 至 17:45 每 15 分钟'],
  ['0 * * * *','每小时整点'],['30 * * * *','每小时第 30 分钟'],['0 */2 * * *','每 2 小时，从 00:00 起'],['30 1/6 * * *','每天 01:30、07:30、13:30、19:30'],
  ['0 9-17 * * *','每天 09:00 至 17:00 每小时一次'],['0 */5 * * *','每天 00:00、05:00、10:00、15:00、20:00'],['0 1,2,3,5,8,13,21 * * *','每天 1 至 3、5、8、13、21 点的第 0 分钟'],['0,20,40 8,12,16,20 * * *','每天 8、12、16、20 点的第 0、20、40 分钟'],
 ])assert.equal(phrase(parseCron(expression)),words,expression);
});
// Schedules over the topics of a topic fixture (see topicFixture), with the clock of both at f.clock.now, which f.at(iso) sets. f.posted
// records every message the bot posts into a chat outside a thread as [app id, chat id, content], which resolves to the next om_post_<n>;
// with f.postFails set it rejects with that error instead.
function scheduleFixture(options={}){
 const clock={now:at('2026-11-06T08:00:00+08:00')},f=topicFixture({...options,now:()=>clock.now}),posted=[];let n=0;
 const schedules=new Schedules(f.store,{topics:f.topics,app:id=>{if(id!==allowed.id)throw Error('应用不存在');return allowed;},
  send:async(a,chatId,content)=>{posted.push([a.id,chatId,content]);await null;if(f.postFails)throw f.postFails;return 'om_post_'+ ++n;},reply:(...args)=>f.topics.reply(...args),now:()=>clock.now});
 return Object.assign(f,{schedules,posted,clock,at:iso=>{clock.now=at(iso);}});
}
// The card of run n of schedule s, due at wall time time.
const runNotice=(s,n,time)=>{const text=`定时任务 ${s.id.slice(0,8)} · 第 ${n} 次运行 · ${time}\n${s.task}`;return notice(text,text.replace(/\s+/g,' '));};
const daily={bindingId:'b',mode:'new',cron:'0 9 * * *',timeZone:'Asia/Shanghai',task:'总结昨天的提交'};
const scheduleLogs=f=>f.store.data.logs.filter(l=>l.kind==='定时任务').map(l=>[l.level,l.message]);
test('a schedule is added on a binding with a cron expression, a time zone and a task, to open a new topic at each run or to prompt one topic of the binding; what is invalid is refused, and list, runs, update, pause, resume and remove work on the stored schedules',async()=>{
 const f=scheduleFixture();try{
  await f.send({messageId:'om_1',content:'one'});const t=f.store.data.topics[0];f.at('2026-11-06T10:00:00+08:00');const now=at('2026-11-06T10:00:00+08:00');
  const s=f.schedules.add({bindingId:'b',mode:'new',cron:' 30  9 * * 1-5 ',timeZone:'asia/shanghai',task:' 总结昨天的提交\n',createdBy:{topicId:t.id,openId:'ou_user',name:'x'}});
  assert.deepEqual(s,{id:s.id,bindingId:'b',mode:'new',cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交',paused:false,createdBy:{topicId:t.id,openId:'ou_user'},createdAt:now,handledUntil:now,count:0,runs:[]});
  assert.deepEqual(new Store(f.dir).data.schedules,[s]);s.task='changed';assert.equal(f.store.data.schedules[0].task,'总结昨天的提交');
  const into=f.schedules.add({bindingId:'b',mode:'into',topicId:t.id,cron:'0 18 * * *',timeZone:'UTC',task:'看一下',createdBy:{}});
  assert.deepEqual([into.mode,into.topicId,into.createdBy],['into',t.id,{}]);
  for(const [fields,error] of [[{bindingId:'x'},/会话绑定不存在/],[{mode:'loop'},/模式无效/],[{mode:'into'},/话题不存在/],[{mode:'into',topicId:'missing'},/话题不存在/],[{cron:'* * *'},/5 个字段/],[{cron:'0 0 31 2 *'},/不会再运行/],
   [{timeZone:'Mars/Base'},/时区无效/],[{timeZone:undefined},/时区无效/],[{task:'  '},/任务文字/],[{task:'x'.repeat(16001)},/任务文字/],[{task:3},/任务文字/]])
   assert.throws(()=>f.schedules.add({...daily,...fields}),error,JSON.stringify(fields).slice(0,60));
  assert.equal(f.store.data.schedules.length,2);
  // A topic of another binding cannot be prompted.
  f.store.data.bindings.push({...route,id:'b2',chatId:'oc_2'});assert.throws(()=>f.schedules.add({...daily,bindingId:'b2',mode:'into',topicId:t.id}),/话题不存在/);
  const {runs,...listed}=s;assert.deepEqual(f.schedules.list(),[{...listed,task:'总结昨天的提交',next:at('2026-11-09T09:30:00+08:00')},{...(({runs,...x})=>x)(into),next:at('2026-11-06T18:00:00Z')}]);
  assert.deepEqual(f.schedules.list('b2'),[]);assert.deepEqual(f.schedules.runs(s.id),[]);
  // An update checks what changes like add; the times after it count from now.
  f.at('2026-11-06T11:00:00+08:00');
  assert.throws(()=>f.schedules.update(s.id,{cron:'61 * * * *'}),/分钟/);assert.throws(()=>f.schedules.update(s.id,{task:''}),/任务文字/);assert.equal(f.store.data.schedules[0].cron,'30 9 * * 1-5');
  const updated=f.schedules.update(s.id,{cron:'0 18 * * *',mode:'into',bindingId:'b2'});
  assert.deepEqual([updated.cron,updated.timeZone,updated.task,updated.mode,updated.bindingId,updated.handledUntil],['0 18 * * *','Asia/Shanghai','总结昨天的提交','new','b',at('2026-11-06T11:00:00+08:00')]);
  assert.equal(f.schedules.update(s.id,{task:'新的任务',timeZone:'UTC'}).task,'新的任务');assert.equal(new Store(f.dir).data.schedules[0].timeZone,'UTC');
  assert.deepEqual([f.schedules.pause(s.id).paused,f.schedules.list()[0].next],[true,null]);
  f.at('2026-11-06T12:00:00+08:00');const resumed=f.schedules.resume(s.id);assert.deepEqual([resumed.paused,resumed.handledUntil],[false,at('2026-11-06T12:00:00+08:00')]);
  f.schedules.remove(into.id);assert.deepEqual(f.store.data.schedules.map(x=>x.id),[s.id]);assert.deepEqual(new Store(f.dir).data.schedules.map(x=>x.id),[s.id]);
  for(const call of [()=>f.schedules.runs('x'),()=>f.schedules.update('x',{}),()=>f.schedules.pause('x'),()=>f.schedules.resume('x'),()=>f.schedules.remove('x')])assert.throws(call,/定时任务不存在/);
  assert.deepEqual(scheduleLogs(f).map(l=>l[1].replace(/[0-9a-f]{8}/g,'<id>')),['个人助手：已添加定时任务 <id>（30 9 * * 1-5，Asia/Shanghai，每次开新话题）','个人助手：已添加定时任务 <id>（0 18 * * *，UTC，发进话题）',
   '个人助手：定时任务 <id> 已修改（0 18 * * *，Asia/Shanghai）','个人助手：定时任务 <id> 已修改（0 18 * * *，UTC）','个人助手：定时任务 <id> 已暂停','个人助手：定时任务 <id> 已恢复','个人助手：定时任务 <id> 已删除']);
 }finally{f.close();}
});
test('at its time a schedule in mode new posts the card of the run into the chat of its binding, opens a topic under it with the task as the first prompt and records the run; it does nothing before its time and runs a time once',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T08:58:00+08:00');const s=f.schedules.add(daily);
  await f.schedules.tick();assert.deepEqual([f.posted,f.h.calls,f.store.data.topics],[[],[],[]]);
  f.at('2026-11-06T09:00:05+08:00');await Promise.all([f.schedules.tick(),f.schedules.tick()]);await f.schedules.tick();
  const [t]=f.store.data.topics;
  assert.deepEqual(f.posted,[['a','oc_1',runNotice(s,1,'2026-11-06 09:00')]]);
  assert.deepEqual([t.rootId,t.title,t.state,t.scheduled,t.messageIds,t.createdAt],['om_post_1','总结昨天的提交','ready',{id:s.id,n:1},['om_post_1'],at('2026-11-06T09:00:05+08:00')]);
  assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)),[['workspace','list'],['workspace','create'],['tab','rename'],['agent','start'],['pane','remote-answers'],['agent','prompt']]);
  assert.deepEqual(f.h.calls.at(-1),['agent','prompt','w1:p1','总结昨天的提交']);assert.deepEqual([f.reacted,f.replies],[[],[]]);assert.deepEqual(cotLog(f)[0],['create','om_post_1']);
  const stored=new Store(f.dir).data.schedules[0];
  assert.deepEqual(stored.runs,[{due:at('2026-11-06T09:00:00+08:00'),at:at('2026-11-06T09:00:05+08:00'),outcome:'started',n:1,topicId:t.id}]);assert.deepEqual([stored.count,stored.handledUntil],[1,at('2026-11-06T09:00:00+08:00')]);
  // The next day: the idle agent of the first run lets the second open its own topic.
  f.at('2026-11-07T09:00:01+08:00');f.h.calls.length=0;await f.schedules.tick();
  assert.deepEqual(f.store.data.topics.map(x=>[x.rootId,x.scheduled.n,x.state]),[['om_post_1',1,'ready'],['om_post_2',2,'ready']]);assert.deepEqual(f.posted[1],['a','oc_1',runNotice(s,2,'2026-11-07 09:00')]);
  assert.deepEqual(f.h.calls.map(c=>c.slice(0,2)),[['agent','list'],['workspace','list'],['tab','create'],['agent','start'],['pane','remote-answers'],['agent','prompt']]);
  assert.deepEqual(f.schedules.runs(s.id).map(r=>[r.outcome,r.n]),[['started',1],['started',2]]);assert.deepEqual(scheduleLogs(f).length,1);
 }finally{f.close();}
});
test('a schedule in mode new skips a time while the agent of its previous run works or waits for a confirmation, records why and counts only the runs that started',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'*/5 * * * *'});
  f.at('2026-11-06T10:05:00+08:00');await f.schedules.tick();
  for(const [status,time] of [['working','10:10'],['blocked','10:15']]){
   f.h.agents[0].agent_status=status;f.at(`2026-11-06T${time}:00+08:00`);await f.schedules.tick();
  }
  assert.equal(f.posted.length,1);assert.equal(f.store.data.topics.length,1);
  f.h.agents[0].agent_status='idle';f.at('2026-11-06T10:20:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.posted.map(p=>p[2]),[runNotice(s,1,'2026-11-06 10:05'),runNotice(s,2,'2026-11-06 10:20')]);
  assert.deepEqual(f.schedules.runs(s.id).map(({due,outcome,n,reason})=>[when(due,'Asia/Shanghai'),outcome,n,reason]),
   [['2026-11-06 10:05','started',1,undefined],['2026-11-06 10:10','skipped',undefined,'上次还没结束，跳过'],['2026-11-06 10:15','skipped',undefined,'上次还没结束，跳过'],['2026-11-06 10:20','started',2,undefined]]);
 }finally{f.close();}
});
test('at its time a schedule in mode into posts the card of the run into the thread of its topic and gives the task to the agent there as a message of a person would, in the topic queue, with the COT under the card and no reaction; it skips a time while the agent works or waits for a confirmation',async()=>{
 const f=scheduleFixture();try{
  await f.send({messageId:'om_1',content:'one'});const t=f.store.data.topics[0];delete t.cot;f.h.calls.length=0;f.api.length=0;f.reacted.length=0;
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,mode:'into',topicId:t.id,cron:'*/5 * * * *',task:'回复当前时间'});
  f.at('2026-11-06T10:05:00+08:00');
  // A message of a person that is still in the queue goes first.
  f.h.on['agent prompt']=async(args,run)=>{await later(20);return run(args);};const sent=f.send({messageId:'om_2',rootId:'om_1',content:'先做这个'});
  await f.schedules.tick();await sent;
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='prompt').map(c=>c[3]),['先做这个','回复当前时间']);
  assert.deepEqual(f.replies,[['a','oc_1','om_1',runNotice(s,1,'2026-11-06 10:05')]]);assert.deepEqual(f.reacted.map(r=>r[1]),['om_2']);
  assert.deepEqual(cotLog(f).filter(c=>c[0]==='create'),[['create','om_2']]);
  assert.deepEqual(f.schedules.runs(s.id),[{due:at('2026-11-06T10:05:00+08:00'),at:at('2026-11-06T10:05:00+08:00'),outcome:'started',n:1,topicId:t.id}]);assert.equal(f.store.data.topics.length,1);
  // Without an open COT, the COT of the run's turn answers its card.
  delete t.cot;f.at('2026-11-06T10:10:00+08:00');f.h.calls.length=0;f.replies.length=0;f.api.length=0;await f.schedules.tick();
  assert.deepEqual(f.h.calls,[['agent','list'],['agent','list'],['agent','prompt','w1:p1','回复当前时间']]);assert.deepEqual(cotLog(f)[0],['create','om_bot_2']);assert.equal(t.cot.origin,'om_bot_2');
  for(const [status,time] of [['working','10:15'],['blocked','10:20']]){f.h.agents[0].agent_status=status;f.at(`2026-11-06T${time}:00+08:00`);await f.schedules.tick();}
  assert.equal(f.h.calls.filter(c=>c[1]==='prompt').length,1);assert.equal(f.replies.length,1);
  assert.deepEqual(f.schedules.runs(s.id).map(r=>[r.outcome,r.n,r.reason]),[['started',1,undefined],['started',2,undefined],['skipped',undefined,'上次还没结束，跳过'],['skipped',undefined,'上次还没结束，跳过']]);
 }finally{f.close();}
});
test('a schedule in mode into whose topic has ended skips the time and pauses, with a notice in the thread: its agent is gone, the topic was closed before, or the topic went with its binding, which leaves no thread to tell',async()=>{
 const f=scheduleFixture();try{
  for(const id of ['om_1','om_2','om_3'])await f.send({messageId:id,content:id});
  const [gone,closed,unbound]=f.store.data.topics;f.at('2026-11-06T10:00:00+08:00');
  const [a,b]=[gone,closed].map(t=>f.schedules.add({...daily,mode:'into',topicId:t.id,cron:'*/5 * * * *'}));
  f.h.agents=f.h.agents.filter(x=>x.pane_id!=='w1:p1');closed.state='closed';f.replies.length=0;f.h.calls.length=0;
  f.at('2026-11-06T10:05:00+08:00');await f.schedules.tick();
  const paused=s=>notice(`定时任务 ${s.id.slice(0,8)} 已暂停：这个话题的会话已结束，定时任务不会在这里另起一个 Agent`),thread=root=>f.replies.filter(r=>r[2]===root).map(r=>r[3]);
  assert.deepEqual([thread('om_1'),thread('om_2'),f.replies.length],[[notice('该话题的会话已结束，请发起新话题'),paused(a)],[paused(b)],3]);
  assert.deepEqual([gone.state,closed.state],['closed','closed']);assert.deepEqual(f.h.calls,[['agent','list']]);
  assert.deepEqual([a,b].map(s=>f.schedules.runs(s.id).map(r=>[r.outcome,r.reason])),[[['skipped','话题已结束，定时任务已暂停']],[['skipped','话题已结束，定时任务已暂停']]]);
  assert.deepEqual(new Store(f.dir).data.schedules.map(s=>s.paused),[true,true]);
  // Removing the binding drops its topics; the schedule keeps its binding id and pauses at its next time, without a thread to tell.
  const c=f.schedules.add({...daily,mode:'into',topicId:unbound.id,cron:'*/5 * * * *'});await f.topics.unbind('b');f.replies.length=0;
  f.at('2026-11-06T10:10:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.replies,[]);assert.deepEqual(f.schedules.runs(c.id).map(r=>[r.outcome,r.reason]),[['skipped','话题已结束，定时任务已暂停']]);assert.equal(f.store.data.schedules[2].paused,true);
  // Paused schedules do not run.
  f.at('2026-11-06T10:15:00+08:00');await f.schedules.tick();assert.deepEqual(f.store.data.schedules.map(s=>f.schedules.runs(s.id).length),[1,1,1]);
  assert.deepEqual(scheduleLogs(f).filter(l=>/暂停/.test(l[1])).map(l=>l[1].replace(/[0-9a-f]{8}/g,'<id>')),['个人助手：定时任务 <id> 的话题已结束，已暂停','个人助手：定时任务 <id> 的话题已结束，已暂停','个人助手：定时任务 <id> 的话题已结束，已暂停']);
 }finally{f.close();}
});
test('a schedule in mode new whose binding was removed skips the time and pauses',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T08:00:00+08:00');const s=f.schedules.add(daily);f.store.data.bindings=[];
  f.at('2026-11-06T09:00:00+08:00');await f.schedules.tick();
  assert.deepEqual([f.posted,f.h.calls],[[],[]]);assert.deepEqual(f.schedules.runs(s.id).map(r=>[r.outcome,r.reason]),[['skipped','绑定已移除，定时任务已暂停']]);assert.equal(f.store.data.schedules[0].paused,true);
 }finally{f.close();}
});
test('after Bridge was down, a schedule runs only its latest missed time, and only when that is at most 2 hours late; the earlier times are recorded as missed, once',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T08:30:00+08:00');const hourly=f.schedules.add({...daily,cron:'0 * * * *'}),s=f.schedules.add(daily);
  // Down from 08:30 to 11:00: 09:00 and 10:00 were missed, 11:00 is on time.
  f.at('2026-11-06T11:00:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.schedules.runs(hourly.id).map(({due,last,outcome,reason})=>[when(due,'Asia/Shanghai'),last&&when(last,'Asia/Shanghai'),outcome,reason]),[['2026-11-06 09:00','2026-11-06 10:00','missed','Bridge 停机，错过'],['2026-11-06 11:00',undefined,'started',undefined]]);
  // The daily one is exactly 2 hours late, and runs.
  assert.deepEqual(f.schedules.runs(s.id).map(r=>[when(r.due,'Asia/Shanghai'),r.outcome]),[['2026-11-06 09:00','started']]);
  // Down from 11:00 to 11:30 two days later: the latest 09:00 is 2.5 hours late, and every time since is missed; ticking again records nothing.
  f.at('2026-11-08T11:30:00+08:00');await f.schedules.tick();await f.schedules.tick();
  assert.deepEqual(f.schedules.runs(s.id).slice(1).map(({due,last,outcome})=>[when(due,'Asia/Shanghai'),when(last,'Asia/Shanghai'),outcome]),[['2026-11-07 09:00','2026-11-08 09:00','missed']]);
  assert.deepEqual(f.schedules.runs(hourly.id).slice(2).map(({due,last,outcome})=>[when(due,'Asia/Shanghai'),last&&when(last,'Asia/Shanghai'),outcome]),[['2026-11-06 12:00','2026-11-08 10:00','missed'],['2026-11-08 11:00',undefined,'started']]);
  assert.equal(f.posted.length,3);
  // One missed time alone has no last.
  f.at('2026-11-09T11:01:00+08:00');await f.schedules.tick();assert.deepEqual(f.schedules.runs(s.id).at(-1),{due:at('2026-11-09T09:00:00+08:00'),at:at('2026-11-09T11:01:00+08:00'),outcome:'missed',reason:'Bridge 停机，错过'});
 }finally{f.close();}
});
test('a paused schedule does not run, and resuming it counts its times from then on without making up for the pause',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'*/5 * * * *'});f.schedules.pause(s.id);
  f.at('2026-11-06T10:20:00+08:00');await f.schedules.tick();f.at('2026-11-06T10:21:00+08:00');f.schedules.resume(s.id);await f.schedules.tick();
  assert.deepEqual([f.posted,f.schedules.runs(s.id)],[[],[]]);
  f.at('2026-11-06T10:25:00+08:00');await f.schedules.tick();assert.deepEqual(f.schedules.runs(s.id).map(r=>[when(r.due,'Asia/Shanghai'),r.outcome]),[['2026-11-06 10:25','started']]);
 }finally{f.close();}
});
test('a schedule in mode new keeps the topics of its latest 3 runs: older ones end and the panes of their agents close, except one in which a person wrote within a day and one that has ended, whose pane Bridge no longer knows',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'*/5 * * * *'});
  const runAt=async time=>{f.at(time);await f.schedules.tick();};
  for(const time of ['10:05','10:10','10:15'])await runAt(`2026-11-06T${time}:00+08:00`);
  // A person writes in the first run's topic.
  f.at('2026-11-06T10:16:00+08:00');await f.send({messageId:'om_u1',rootId:'om_post_1',content:'追问'});
  await runAt('2026-11-06T10:20:00+08:00');const topic=n=>f.store.data.topics.find(t=>t.scheduled.n===n);
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='close'),[]);assert.deepEqual(f.store.data.topics.map(t=>t.state),Array(4).fill('ready'));
  // Run 5: the second run's topic goes; the first stays for the person.
  f.replies.length=0;await runAt('2026-11-06T10:25:00+08:00');
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='close'),[['pane','close',topic(2).paneId]]);assert.deepEqual(f.store.data.topics.map(t=>[t.scheduled.n,t.state]),[[1,'ready'],[2,'closed'],[3,'ready'],[4,'ready'],[5,'ready']]);
  const retired=`这个话题来自定时任务 ${s.id.slice(0,8)}，定时任务只保留最近 3 次运行的话题，Agent 已关闭`;
  assert.deepEqual(f.replies.map(r=>r.slice(2)),[[topic(2).rootId,notice(retired)]]);
  // The agent of the third run exits; a day after the person wrote, run 6 retires the first and leaves the third, which has ended.
  f.h.agents=f.h.agents.filter(a=>a.pane_id!==topic(3).paneId);await f.topics.sync(f.m,f.h.agents);assert.equal(topic(3).state,'closed');
  f.h.calls.length=0;await runAt('2026-11-07T10:16:00+08:00');
  assert.deepEqual(f.h.calls.filter(c=>c[1]==='close'),[['pane','close',topic(1).paneId]]);
  assert.deepEqual(f.store.data.topics.map(t=>[t.scheduled.n,t.state]),[[1,'closed'],[2,'closed'],[3,'closed'],[4,'ready'],[5,'ready'],[6,'ready']]);
 }finally{f.close();}
});
test('a run that cannot post its card or start its agent is recorded as failed and logged; the next time runs again',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'*/5 * * * *'});
  f.postFails=Error('飞书未连接');f.at('2026-11-06T10:05:00+08:00');await f.schedules.tick();
  assert.deepEqual([f.store.data.topics,f.h.calls],[[],[]]);
  f.postFails=null;f.h.on['agent start']=()=>{throw coded('agent_pane_busy','agent target pane w1:p1 is not an available shell');};f.at('2026-11-06T10:10:00+08:00');await f.schedules.tick();
  assert.equal(f.store.data.topics[0].state,'failed');assert.deepEqual(f.replies.map(r=>r[3]),[notice('启动失败，请在 Bridge 管理台查看原因')]);
  f.at('2026-11-06T10:15:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.schedules.runs(s.id).map(r=>[r.outcome,r.n,r.reason]),[['failed',undefined,'未能在群里发出这次运行的消息'],['failed',1,'Agent 启动失败'],['started',2,undefined]]);
  assert.deepEqual(scheduleLogs(f).slice(1).map(l=>[l[0],l[1].replace(/[0-9a-f]{8}/g,'<id>')]),[['error','个人助手：定时任务 <id> 未能发出运行的消息，飞书未连接']]);
 }finally{f.close();}
});
test('a stored schedule whose time cannot be read is paused with a log line, and the others still run',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const broken=f.schedules.add(daily),s=f.schedules.add({...daily,cron:'*/5 * * * *'});f.store.data.schedules[0].timeZone='Mars/Base';
  f.at('2026-11-06T10:05:00+08:00');await f.schedules.tick();
  assert.deepEqual(f.store.data.schedules.map(x=>x.paused),[true,false]);assert.deepEqual(f.schedules.runs(s.id).map(r=>r.outcome),['started']);
  assert.match(scheduleLogs(f).at(-1)[1],new RegExp(`^个人助手：定时任务 ${broken.id.slice(0,8)} 的时间无法计算，已暂停：`));assert.equal(scheduleLogs(f).at(-1)[0],'error');
 }finally{f.close();}
});
test('a time that waits behind a slow run of its schedule does not run once the schedule is paused or removed meanwhile',async()=>{
 for(const change of ['pause','remove']){
  const f=scheduleFixture();try{
   f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'* * * * *'});
   let release;f.h.on['agent start']=(args,run)=>new Promise(r=>{release=()=>r(run(args));});
   f.at('2026-11-06T10:01:00+08:00');const first=f.schedules.tick();await later(10);
   f.at('2026-11-06T10:02:00+08:00');const second=f.schedules.tick();await later(10);
   const runs=f.schedules.runs(s.id);f.schedules[change](s.id);release();await Promise.all([first,second]);
   assert.deepEqual([runs.map(r=>[when(r.due,'Asia/Shanghai'),r.outcome]),f.posted.length,f.store.data.topics.length],[[['2026-11-06 10:01','started']],1,1],change);
  }finally{f.close();}
 }
});
test('the run record of a schedule keeps its latest 20 runs',async()=>{
 const f=scheduleFixture();try{
  f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add({...daily,cron:'* * * * *'});
  for(let i=1;i<=25;i++){f.h.on['workspace list']=()=>{throw Error('down');};f.at(new Date(at('2026-11-06T10:00:00+08:00')+i*60000).toISOString());await f.schedules.tick();}
  const runs=f.schedules.runs(s.id);assert.equal(runs.length,20);assert.deepEqual([runs[0].n,runs.at(-1).n],[6,25]);
 }finally{f.close();}
});
test('the timer of the schedules checks them every interval from start until stop; starting twice keeps one timer',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-schedules-'));try{
  const schedules=new Schedules(new Store(dir),{every:5});let ticks=0;schedules.tick=()=>{ticks++;};
  schedules.start();schedules.start();await later(40);schedules.stop();const seen=ticks;assert.ok(seen>=2&&seen<=10,String(seen));
  await later(30);assert.equal(ticks,seen);
 }finally{fs.rmSync(dir,{recursive:true});}
});
// The agent schedules over a schedule fixture (see scheduleFixture), with its clock. f.call(op,fields,t) is a request of the agent of topic t
// (the first topic by default) on its machine, cpu2; f.click(id,choice,openId) clicks 确认 or 取消 on the card of proposal id, and
// f.drawn() waits for the cards being redrawn. f.open(messageId) opens a ready topic.
function agentFixture(options){
 const f=scheduleFixture(options);
 const deps={topics:f.topics,schedules:f.schedules,app:id=>{if(id!==allowed.id)throw Error('应用不存在');return allowed;},reply:(...args)=>f.topics.reply(...args),updateCard:(...args)=>f.topics.updateCard(...args),now:()=>f.clock.now};
 const agents=new AgentSchedules(f.store,deps);
 return Object.assign(f,{agents,deps,
  call:(op,fields={},t=f.store.data.topics[0])=>agents.call(op,{machine:'cpu2',pane:t.paneId,...fields}),
  click:(id,choice,openId='ou_user',a=agents)=>a.click(allowed,{messageId:'om_any',chatId:'oc_1',operator:{openId},action:{tag:'button',value:{schedule:choice,proposal:id}}}),
  drawn:()=>Promise.all(agents.drawing.values()),
  open:async messageId=>{await f.send({messageId,content:'topic '+messageId});return f.store.data.topics.find(t=>t.rootId===messageId);}});
}
const weekdays930={cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交',mode:'new'};
// The card of a confirmation with its two buttons for proposal id.
const confirmButtons=id=>({tag:'column_set',horizontal_spacing:'8px',columns:[['确认','primary','confirm'],['取消','default','cancel']].map(([content,type,choice])=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content},type,behaviors:[{type:'callback',value:{schedule:choice,proposal:id}}]}]}))});
const nextWeekdays=['2026-11-09 周一 09:30','2026-11-10 周二 09:30','2026-11-11 周三 09:30','2026-11-12 周四 09:30','2026-11-13 周五 09:30'];
const aboutWeekdays=(task='总结昨天的提交')=>[plainText('时间：每周一至周五 09:30（Asia/Shanghai，cron：30 9 * * 1-5）'),plainText('接下来 5 次运行：\n'+nextWeekdays.join('\n')),plainText('任务：\n'+task)];
const newTopicMode=plainText('模式：每次开新话题。每次运行时机器人在群里发一条消息，在它下面开一个新话题，交给一个新的 Agent'),intoThisMode=plainText('模式：发进这个话题。每次运行把任务发给这个话题里的 Agent，它记得之前的对话');
const boundTo=plainText('绑定：个人助手（cpu2 · ~/work · Claude）');
test('an agent is known by its machine and its pane: a ready topic there whose agent is still linked; any other pane, machine or topic is refused, and a topic whose agent is gone ends',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');
  assert.deepEqual(await f.call('list'),{binding:{id:'b',name:'个人助手'},topicId:t.id,schedules:[]});
  assert.deepEqual((await f.agents.call('list',{machine:'m',pane:t.paneId})).topicId,t.id);
  const notTopic=/这个 pane 里的 Agent 不属于任何进行中的飞书话题/;
  for(const [request,error] of [[{machine:'cpu2'},/缺少 pane/],[{machine:'cpu2',pane:''},/缺少 pane/],[{machine:'cpu2',pane:'w1:p9'},notTopic],[{machine:'cpu9',pane:t.paneId},/Bridge 没有连接名为 cpu9 的机器/],
   [{pane:t.paneId},/Bridge 没有连接本机 session default 的 Herdr/]])
   await assert.rejects(f.agents.call('list',request),error,JSON.stringify(request));
  await assert.rejects(f.call('loop'),/未知的操作：loop/);
  // A disabled machine is not connected.
  f.m.enabled=false;await assert.rejects(f.call('list'),/Bridge 没有连接名为 cpu2 的机器/);f.m.enabled=true;
  // The agent no longer reports remote answers: the topic ends, and the agent is refused.
  delete f.h.agents[0].remote_answers;f.replies.length=0;
  await assert.rejects(f.call('list'),notTopic);assert.equal(t.state,'closed');assert.deepEqual(f.replies.map(r=>r[3]),[notice('该话题的会话已结束，请发起新话题')]);
  await assert.rejects(f.call('list'),notTopic);
 }finally{f.close();}
 // A local machine needs no name: it is the one of the agent's Herdr session.
 const g=agentFixture({machine:{type:'local',session:'default'}});try{
  const t=await g.open('om_1');
  assert.equal((await g.agents.call('list',{pane:t.paneId})).topicId,t.id);assert.equal((await g.agents.call('list',{pane:t.paneId,session:'default'})).topicId,t.id);
  await assert.rejects(g.agents.call('list',{pane:t.paneId,session:'work'}),/Bridge 没有连接本机 session work 的 Herdr/);
 }finally{g.close();}
});
test('list, runs, pause, resume and remove act at once on the schedules of the binding of the agent\'s topic, named by their id or its first characters; another binding\'s schedules do not exist for it',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1'),other=await f.open('om_2');f.at('2026-11-06T10:00:00+08:00');
  f.store.data.bindings.push({...route,id:'b2',chatId:'oc_2'});
  const s=f.schedules.add({...daily,cron:'30 9 * * 1-5'}),into=f.schedules.add({...daily,mode:'into',topicId:other.id,cron:'0 18 * * *'}),foreign=f.schedules.add({...daily,bindingId:'b2'});
  const entry=(x,more)=>{const {runs,...rest}=x;return {...rest,...more};};
  const listed=await f.call('list');
  assert.deepEqual(listed,{binding:{id:'b',name:'个人助手'},topicId:t.id,schedules:[
   entry(s,{phrase:'每周一至周五 09:30',next:at('2026-11-09T09:30:00+08:00')}),entry(into,{phrase:'每天 18:00',next:at('2026-11-06T18:00:00+08:00'),here:false,topicTitle:other.title})]});
  assert.deepEqual((await f.call('list',{},other)).schedules.map(x=>x.here),[undefined,true]);
  assert.deepEqual(await f.call('runs',{id:s.id.slice(0,8)}),{schedule:listed.schedules[0],runs:[]});
  const paused=await f.call('pause',{id:s.id.slice(0,4)});assert.deepEqual([paused.schedule.id,paused.schedule.paused,paused.schedule.next],[s.id,true,null]);assert.equal(f.store.data.schedules[0].paused,true);
  f.at('2026-11-10T10:00:00+08:00');const resumed=await f.call('resume',{id:s.id});
  assert.deepEqual([resumed.schedule.paused,resumed.schedule.next],[false,at('2026-11-11T09:30:00+08:00')]);
  assert.deepEqual(await f.call('remove',{id:into.id}),{schedule:{...entry(into,{phrase:'每天 18:00',next:at('2026-11-10T18:00:00+08:00'),here:false,topicTitle:other.title})}});
  assert.deepEqual(f.store.data.schedules.map(x=>x.id),[s.id,foreign.id]);
  for(const op of ['runs','pause','resume','remove','update']){
   await assert.rejects(f.call(op,{id:foreign.id,task:'x'}),/定时任务不存在/,op);await assert.rejects(f.call(op,{id:'nope'}),/定时任务不存在/,op);await assert.rejects(f.call(op,{}),/缺少定时任务 ID/,op);
  }
  assert.equal(f.store.data.schedules[1].paused,false);
  // Ids that share their first characters need more of them.
  const twin=f.schedules.add(daily);f.store.data.schedules.at(-1).id=s.id.slice(0,4)+twin.id.slice(4);
  await assert.rejects(f.call('pause',{id:s.id.slice(0,4)}),new RegExp(`有多个定时任务的 ID 以 ${s.id.slice(0,4)} 开头`));
  assert.equal((await f.call('pause',{id:s.id.slice(0,8)})).schedule.id,s.id);
 }finally{f.close();}
});
test('an agent submits a schedule as a card in its topic\'s thread that shows it in plain words with its next runs, the task, the mode and the binding; only 确认 adds it, and the card then shows the outcome without buttons',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');f.replies.length=0;
  const r=await f.call('add',{...weekdays930,task:' 总结昨天的提交\n'}),id=t.proposal.id;
  assert.deepEqual(r,{proposal:{id,kind:'add',expiresAt:at('2026-11-06T10:30:00+08:00'),timeZone:'Asia/Shanghai',phrase:'每周一至周五 09:30',next:nextWeekdays.map(x=>at(x.replace(/ 周. /,'T')+':00+08:00'))}});
  assert.deepEqual(f.replies,[['a','oc_1','om_1',{card:cardOf('确认定时任务','blue',[plainText('这个话题里的 Agent 提交了一个定时任务，核对无误后点「确认」才会生效。'),...aboutWeekdays(),newTopicMode,boundTo,
   plainText('到 2026-11-06 周五 10:30 前有效，过期没有确认就不会生效'),confirmButtons(id)])}]]);
  // The proposal is on disk with the topic; nothing is added yet.
  assert.deepEqual(new Store(f.dir).data.topics[0].proposal,{id,kind:'add',fields:{mode:'new',cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交'},messageId:'om_bot_1',expiresAt:at('2026-11-06T10:30:00+08:00')});
  assert.deepEqual(f.schedules.list(),[]);
  f.at('2026-11-06T10:05:00+08:00');assert.deepEqual(f.click(id,'confirm'),{toast:{type:'success',content:'定时任务已生效'}});await f.drawn();
  const [s]=f.store.data.schedules;
  assert.deepEqual([s.bindingId,s.mode,s.cron,s.timeZone,s.task,s.createdBy,s.handledUntil,s.paused],['b','new','30 9 * * 1-5','Asia/Shanghai','总结昨天的提交',{topicId:t.id,openId:'ou_user'},at('2026-11-06T10:05:00+08:00'),false]);
  assert.equal('proposal' in t,false);assert.equal('proposal' in new Store(f.dir).data.topics[0],false);
  assert.deepEqual(f.updated,[['a','om_bot_1',cardOf('定时任务已生效 · '+s.id.slice(0,8),'green',[...aboutWeekdays(),newTopicMode,boundTo,{tag:'markdown',content:'已确认 · <at id=ou_user></at>'}])]]);
  // A second click finds nothing to confirm.
  assert.deepEqual(f.click(id,'confirm'),{toast:{type:'info',content:'这张卡片已失效'}});assert.equal(f.store.data.schedules.length,1);
  assert.deepEqual(scheduleLogs(f).map(l=>l[1].replace(/[0-9a-f]{8}/g,'<id>')),['个人助手：已发出定时任务的确认卡片','个人助手：已添加定时任务 <id>（30 9 * * 1-5，Asia/Shanghai，每次开新话题）']);
 }finally{f.close();}
});
test('取消 drops a submitted schedule, a mode into schedule goes into the agent\'s own topic, and a card whose topic has ended by then adds nothing; a click without a proposal behind it does nothing',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');
  await f.call('add',weekdays930);const first=t.proposal;
  assert.deepEqual(f.click(first.id,'cancel','ou_other'),{toast:{type:'info',content:'已取消'}});await f.drawn();
  assert.deepEqual(f.store.data.schedules,[]);assert.deepEqual(f.updated.at(-1),['a',first.messageId,cardOf('定时任务已取消','grey',[aboutWeekdays()[0],aboutWeekdays()[2],newTopicMode,boundTo,{tag:'markdown',content:'已取消 · <at id=ou_other></at>'}])]);
  // Mode into: this topic.
  await f.call('add',{...weekdays930,mode:'into'});const into=t.proposal;
  assert.deepEqual(f.replies.at(-1)[3].card.body.elements.slice(4,6),[intoThisMode,boundTo]);
  f.click(into.id,'confirm');await f.drawn();
  assert.deepEqual(f.store.data.schedules.map(s=>[s.mode,s.topicId]),[['into',t.id]]);assert.equal(f.updated.at(-1)[2].body.elements[3].text.content,intoThisMode.text.content);
  // The topic ends while its card waits: confirming adds nothing and the card says why.
  await f.call('add',{...weekdays930,mode:'into',task:'再看一次'});const late=t.proposal;
  await f.topics.end(allowed,t,'结束');
  assert.deepEqual(f.click(late.id,'confirm'),{toast:{type:'error',content:'没有生效：这个话题的会话已结束，定时任务不能发进来'}});await f.drawn();
  assert.equal(f.store.data.schedules.length,1);
  assert.deepEqual(f.updated.at(-1),['a',late.messageId,cardOf('定时任务没有生效','red',[aboutWeekdays()[0],plainText('任务：\n再看一次'),intoThisMode,boundTo,plainText('没有生效：这个话题的会话已结束，定时任务不能发进来')])]);
  // Mode new does not need the topic.
  const n=await f.open('om_2');await f.call('add',weekdays930,n);const later=n.proposal;await f.topics.end(allowed,n,'结束');
  f.click(later.id,'confirm');await f.drawn();assert.deepEqual(f.store.data.schedules.map(s=>s.mode),['into','new']);
  for(const [value,label] of [[{schedule:'confirm',proposal:'gone'},'gone'],[{schedule:'later',proposal:late.id},'choice'],[{},'empty']])
   assert.deepEqual(f.agents.click(allowed,{messageId:'om_x',chatId:'oc_1',operator:{openId:'ou_user'},action:{tag:'button',value}}),{toast:{type:'info',content:'这张卡片已失效'}},label);
  // Another app does not reach the topic's card.
  const o=await f.open('om_3');await f.call('add',weekdays930,o);
  assert.deepEqual(f.agents.click({...allowed,id:'a2'},{messageId:'om_x',chatId:'oc_1',operator:{openId:'ou_user'},action:{tag:'button',value:{schedule:'confirm',proposal:o.proposal.id}}}),{toast:{type:'info',content:'这张卡片已失效'}});
  assert.ok(o.proposal);
 }finally{f.close();}
});
test('a topic has one card waiting at a time: another submission is refused until the card is clicked or expires after 30 minutes, when the card shows that it expired; other topics have their own',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1'),u=await f.open('om_2');f.at('2026-11-06T10:00:00+08:00');const s=f.schedules.add(daily);
  await f.call('add',weekdays930);const first=t.proposal;
  const busy=/这个话题已有一张等待确认的定时任务卡片，到 2026-11-06 周五 10:30 过期。请主人先在卡片上点确认或取消，再重新提交/;
  await assert.rejects(f.call('add',{...weekdays930,task:'另一个'}),busy);await assert.rejects(f.call('update',{id:s.id,task:'另一个'}),busy);
  await f.call('add',weekdays930,u);assert.ok(u.proposal);
  // The timer draws cards that expired; one that has not expired stays.
  f.at('2026-11-06T10:29:59+08:00');await f.agents.expire();assert.equal(t.proposal,first);
  f.at('2026-11-06T10:30:00+08:00');await f.agents.expire();
  assert.equal('proposal' in t,false);assert.equal('proposal' in u,false);
  assert.deepEqual(f.updated.find(x=>x[1]===first.messageId),['a',first.messageId,cardOf('定时任务的确认已过期','grey',[aboutWeekdays()[0],aboutWeekdays()[2],newTopicMode,boundTo,plainText('过期前没有确认，没有生效')])]);
  assert.deepEqual(f.click(first.id,'confirm'),{toast:{type:'info',content:'这张卡片已失效'}});
  await f.call('add',weekdays930);const second=t.proposal;
  // A click after the card expired, before the timer saw it, adds nothing; a submission then replaces the expired card.
  f.at('2026-11-06T11:00:00+08:00');assert.deepEqual(f.click(second.id,'confirm'),{toast:{type:'info',content:'这张卡片已过期，定时任务没有生效'}});await f.drawn();
  assert.equal(f.updated.at(-1)[2].header.title.content,'定时任务的确认已过期');
  await f.call('add',weekdays930);const third=t.proposal;f.at('2026-11-06T11:31:00+08:00');f.updated.length=0;
  await f.call('add',{...weekdays930,task:'新的'});await f.drawn();
  assert.deepEqual(f.updated.map(x=>[x[1],x[2].header.title.content]),[[third.messageId,'定时任务的确认已过期']]);assert.equal(t.proposal.fields.task,'新的');
  assert.deepEqual(f.schedules.list().map(x=>x.id),[s.id]);
 }finally{f.close();}
});
test('a submission that is invalid, too long for its card or whose card cannot be posted is refused, and leaves nothing waiting',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');f.replies.length=0;
  for(const [fields,error] of [[{mode:'loop'},/模式无效/],[{mode:undefined},/模式无效/],[{cron:'61 * * * *'},/分钟/],[{cron:'0 0 31 2 *'},/不会再运行/],[{timeZone:'Mars/Base'},/时区无效/],[{timeZone:undefined},/时区无效/],[{task:' '},/任务文字/],
   // Serialized twice a quote takes 4 bytes: 8000 of them make a card over 30 KB.
   [{task:'"'.repeat(8000)},/任务文字太长，确认卡片放不下/]])
   await assert.rejects(f.call('add',{...weekdays930,...fields}),error,JSON.stringify(fields).slice(0,40));
  assert.deepEqual(f.replies,[]);assert.equal('proposal' in t,false);
  f.topics.reply=async()=>{throw Error('飞书未连接');};
  await assert.rejects(f.call('add',weekdays930),/确认卡片没有发出去，请稍后重试/);assert.equal('proposal' in t,false);assert.equal('proposal' in new Store(f.dir).data.topics[0],false);
  assert.deepEqual(scheduleLogs(f).at(-1),['error','个人助手：确认卡片未发出，飞书未连接']);
 }finally{f.close();}
});
test('an agent changes the time or the task of a schedule through a card that shows what it was; confirming changes it unless it was removed meanwhile',async()=>{
 const f=agentFixture();try{
  const t=await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');
  const s=f.schedules.add({...daily,cron:'0 9 * * *'});f.replies.length=0;
  await assert.rejects(f.call('update',{id:s.id}),/没有要修改的内容/);
  const r=await f.call('update',{id:s.id.slice(0,8),cron:'30 9 * * 1-5'}),p=t.proposal,short=s.id.slice(0,8);
  assert.deepEqual([r.proposal.kind,r.proposal.scheduleId,p.scheduleId,p.before,p.fields],['update',s.id,s.id,{cron:'0 9 * * *',timeZone:'Asia/Shanghai',task:'总结昨天的提交'},{mode:'new',cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交'}]);
  assert.deepEqual(f.replies[0][3].card,cardOf('确认修改定时任务 · '+short,'blue',[plainText(`这个话题里的 Agent 提交了对定时任务 ${short} 的修改，核对无误后点「确认」才会生效。`),
   plainText('时间：每周一至周五 09:30（Asia/Shanghai，cron：30 9 * * 1-5）\n原来的时间：每天 09:00（Asia/Shanghai，cron：0 9 * * *）'),...aboutWeekdays().slice(1),newTopicMode,boundTo,plainText('到 2026-11-06 周五 10:30 前有效，过期没有确认就不会生效'),confirmButtons(p.id)]));
  f.at('2026-11-06T10:01:00+08:00');assert.deepEqual(f.click(p.id,'confirm'),{toast:{type:'success',content:'定时任务已修改'}});await f.drawn();
  assert.deepEqual([f.store.data.schedules[0].cron,f.store.data.schedules[0].handledUntil],['30 9 * * 1-5',at('2026-11-06T10:01:00+08:00')]);
  assert.equal(f.updated[0][2].header.title.content,'定时任务已修改 · '+short);
  // A task alone: the card marks the task as changed and keeps the time as it was.
  await f.call('update',{id:short,task:'新的任务'});
  assert.deepEqual(f.replies.at(-1)[3].card.body.elements.slice(1,4),[aboutWeekdays()[0],aboutWeekdays()[1],plainText('任务（已修改）：\n新的任务')]);
  f.schedules.remove(s.id);
  assert.deepEqual(f.click(t.proposal.id,'confirm'),{toast:{type:'error',content:'没有生效：定时任务不存在'}});await f.drawn();
  assert.equal(f.updated.at(-1)[2].header.title.content,'修改没有生效 · '+short);assert.deepEqual(f.store.data.schedules,[]);
 }finally{f.close();}
});
test('a click that comes before the post of its card has resolved draws the card it came from',async()=>{
 const f=agentFixture();try{
  await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');let posted;f.topics.reply=()=>new Promise(r=>{posted=r;});
  const sent=f.call('add',weekdays930);for(let i=0;i<50&&!posted;i++)await later(5);
  assert.deepEqual(f.click(f.store.data.topics[0].proposal.id,'confirm'),{toast:{type:'success',content:'定时任务已生效'}});await f.drawn();
  posted('om_card');await sent;
  assert.deepEqual(f.updated.map(u=>[u[1],u[2].header.title.content]),[['om_any','定时任务已生效 · '+f.store.data.schedules[0].id.slice(0,8)]]);
 }finally{f.close();}
});
test('a card waiting for its click survives a restart of Bridge: the click is answered from the state file',async()=>{
 const f=agentFixture();try{
  await f.open('om_1');f.at('2026-11-06T10:00:00+08:00');await f.call('add',weekdays930);const id=f.store.data.topics[0].proposal.id;
  const {store,topics}=f.restart(),schedules=new Schedules(store,{topics,app:f.deps.app,send:async()=>'om_post',reply:f.deps.reply,now:f.deps.now});
  const agents=new AgentSchedules(store,{...f.deps,topics,schedules});
  assert.deepEqual(f.click(id,'confirm','ou_user',agents),{toast:{type:'success',content:'定时任务已生效'}});await Promise.all(agents.drawing.values());
  assert.equal(store.data.schedules.length,1);assert.equal(new Store(f.dir).data.schedules.length,1);
 }finally{f.close();}
});
test('the timer of the agent schedules checks for expired cards every interval from start until stop; starting twice keeps one timer',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-agent-schedules-'));try{
  const agents=new AgentSchedules(new Store(dir),{every:5});let checks=0;agents.expire=()=>{checks++;};
  agents.start();agents.start();await later(40);agents.stop();const seen=checks;assert.ok(seen>=2&&seen<=10,String(seen));
  await later(30);assert.equal(checks,seen);
 }finally{fs.rmSync(dir,{recursive:true});}
});
// A Bridge that answers the requests of bridge-schedule on agent.sock in a state directory of its own: answer(op,body) returns [status,
// data]. f.requests records each as [method, path, content type, body].
async function fakeBridge(answer){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-agent-')),socket=path.join(dir,'agent.sock'),requests=[];
 const server=http.createServer(async(req,res)=>{
  let s='';for await(const c of req)s+=c;const body=JSON.parse(s);requests.push([req.method,req.url,req.headers['content-type'],body]);
  const [code,data]=await answer(req.url.replace('/schedules/',''),body);res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));
 });
 await new Promise(r=>server.listen(socket,r));
 return {dir,socket,requests,close:()=>new Promise(r=>server.close(()=>{fs.rmSync(dir,{recursive:true});r();}))};
}
// Runs bridge-schedule with args in env (its state directory that of bridge, its pane w1:p1) and resolves to {code, out, err}; stdin, when
// given, is what it reads.
async function schedule(bridge,args,{env={},stdin}={}){
 let out='',err='';
 const code=await runCommand(args,{env:{BRIDGE_STATE:bridge.dir,HERDR_PANE_ID:'w1:p1',...env},stdin:stdin==null?Readable.from([]):Readable.from([Buffer.from(stdin)]),stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},timeZone:'Asia/Shanghai'});
 return {code,out,err};
}
const sid=n=>`${n}0000000-0000-4000-8000-00000000000${n}`.slice(0,36);
test('bridge-schedule reads its operation, the id and options in any order, with a value after the option or after =; anything else is a usage error',()=>{
 assert.deepEqual(parseCommand(['add','--cron','30 9 * * 1-5','--mode=new','--task','--看起来像选项','--tz','UTC','--json']),{op:'add',json:true,cron:'30 9 * * 1-5',mode:'new',task:'--看起来像选项',timeZone:'UTC'});
 assert.deepEqual(parseCommand(['--machine','cpu2','pause','1a2b3c4d','--pane','w1:p2','--session=work']),{op:'pause',id:'1a2b3c4d',json:false,machine:'cpu2',pane:'w1:p2',session:'work'});
 assert.deepEqual(parseCommand(['--help']),{json:false,help:true});
 for(const [args,error] of [[['add','--cron'],/--cron 缺少值/],[['list','--loop'],/未知的参数：--loop/],[['pause','a','b'],/多余的参数：b/]])
  assert.throws(()=>parseCommand(args),error,args.join(' '));
});
test('bridge-schedule sends its request to Bridge\'s agent socket with the pane of its agent and the time zone of its machine, and prints what Bridge answers for the agent to read, or the answer itself with --json',async()=>{
 const due=iso=>at(iso);
 const list={binding:{id:'b',name:'个人助手'},topicId:'t1',schedules:[
  {id:sid(1),bindingId:'b',mode:'new',cron:'30 9 * * 1-5',timeZone:'Asia/Shanghai',task:'总结昨天的提交\n第二行',paused:false,next:due('2026-11-09T09:30:00+08:00'),phrase:'每周一至周五 09:30'},
  {id:sid(2),bindingId:'b',mode:'into',topicId:'t1',here:true,topicTitle:'看看',cron:'0 18 * * *',timeZone:'Asia/Shanghai',task:'看一下',paused:true,next:null,phrase:'每天 18:00'},
  {id:sid(3),bindingId:'b',mode:'into',topicId:'t2',here:false,topicTitle:'另一个话题',cron:'0 8 * * *',timeZone:'UTC',task:'x'.repeat(300),paused:false,next:null,phrase:'每天 08:00'}]};
 const [first]=list.schedules,runs={schedule:first,runs:[
  {due:due('2026-11-06T09:30:00+08:00'),at:due('2026-11-06T09:30:05+08:00'),outcome:'started',n:1,topicId:'t3'},
  {due:due('2026-11-09T09:30:00+08:00'),at:due('2026-11-09T10:15:00+08:00'),outcome:'started',n:2,topicId:'t4'},
  {due:due('2026-11-10T09:30:00+08:00'),at:due('2026-11-10T09:30:00+08:00'),outcome:'skipped',reason:'上次还没结束，跳过'},
  {due:due('2026-11-11T09:30:00+08:00'),last:due('2026-11-12T09:30:00+08:00'),at:due('2026-11-12T12:00:00+08:00'),outcome:'missed',reason:'Bridge 停机，错过'},
  {due:due('2026-11-13T09:30:00+08:00'),at:due('2026-11-13T09:30:00+08:00'),outcome:'failed',n:3,topicId:'t5',reason:'Agent 启动失败'}]};
 const proposal=(kind,more)=>({proposal:{id:'p1',kind,...more,expiresAt:due('2026-11-06T10:30:00+08:00'),timeZone:'Asia/Shanghai',phrase:'每周一至周五 09:30',next:[due('2026-11-09T09:30:00+08:00'),due('2026-11-10T09:30:00+08:00')]}});
 const answers={list:list,runs,pause:{schedule:{...first,paused:true,next:null}},resume:{schedule:first},remove:{schedule:first},add:proposal('add'),update:proposal('update',{scheduleId:sid(1)})};
 const bridge=await fakeBridge(op=>[200,answers[op]]);try{
  const text={
   list:['绑定「个人助手」上有 3 个定时任务：',
    `${sid(1).slice(0,8)} · 每次开新话题 · 每周一至周五 09:30（Asia/Shanghai，cron：30 9 * * 1-5）`,'  下次运行：2026-11-09 周一 09:30','  任务：总结昨天的提交 第二行',
    `${sid(2).slice(0,8)} · 发进这个话题 · 每天 18:00（Asia/Shanghai，cron：0 18 * * *） · 已暂停`,'  任务：看一下',
    `${sid(3).slice(0,8)} · 发进话题「另一个话题」 · 每天 08:00（UTC，cron：0 8 * * *）`,'  下次运行：不会再运行',`  任务：${'x'.repeat(199)}…`],
   runs:[`定时任务 ${sid(1).slice(0,8)}（每周一至周五 09:30，Asia/Shanghai）最近 5 次运行：`,'2026-11-06 周五 09:30 · 已运行 · 第 1 次','2026-11-09 周一 09:30 · 已运行 · 第 2 次 · 补跑于 2026-11-09 周一 10:15',
    '2026-11-10 周二 09:30 · 跳过：上次还没结束，跳过','2026-11-11 周三 09:30 至 2026-11-12 周四 09:30 · 错过：Bridge 停机，错过','2026-11-13 周五 09:30 · 失败：Agent 启动失败 · 第 3 次'],
   pause:[`已暂停定时任务 ${sid(1).slice(0,8)}（每周一至周五 09:30）。恢复之前不会运行，暂停期间的时间恢复后也不补跑。`],
   resume:[`已恢复定时任务 ${sid(1).slice(0,8)}，下次运行：2026-11-09 周一 09:30。`],
   remove:[`已删除定时任务 ${sid(1).slice(0,8)}（每周一至周五 09:30）。它开过的话题保留。`],
   add:['已在这个话题里发了确认卡片：每周一至周五 09:30（Asia/Shanghai），下次运行 2026-11-09 周一 09:30。主人在卡片上点「确认」后才生效；到 2026-11-06 周五 10:30 还没有确认就作废。'],
   update:[`已在这个话题里发了修改定时任务 ${sid(1).slice(0,8)} 的确认卡片：每周一至周五 09:30（Asia/Shanghai），下次运行 2026-11-09 周一 09:30。主人在卡片上点「确认」后才生效；到 2026-11-06 周五 10:30 还没有确认就作废。`]};
  const args={list:['list'],runs:['runs','1a2b'],pause:['pause','1a2b'],resume:['resume','1a2b'],remove:['remove','1a2b'],add:['add','--cron','30 9 * * 1-5','--mode','new','--task','总结'],update:['update','1a2b','--task','新的']};
  for(const op of Object.keys(text)){
   assert.deepEqual(await schedule(bridge,args[op]),{code:0,out:text[op].join('\n')+'\n',err:''},op);
   assert.deepEqual(await schedule(bridge,[...args[op],'--json']),{code:0,out:JSON.stringify(answers[op],null,2)+'\n',err:''},op);
  }
  // Each request: the operation in the path, JSON, the agent's pane and Herdr session; a new schedule without --tz takes the machine's time zone.
  assert.deepEqual(bridge.requests.filter((r,i)=>i%2===0).map(r=>[r[0],r[1],r[2]]),Object.keys(text).map(op=>['POST','/schedules/'+op,'application/json']));
  assert.deepEqual(bridge.requests.map(r=>r[3]).filter((r,i)=>i%2===0),[{pane:'w1:p1'},{pane:'w1:p1',id:'1a2b'},{pane:'w1:p1',id:'1a2b'},{pane:'w1:p1',id:'1a2b'},{pane:'w1:p1',id:'1a2b'},
   {pane:'w1:p1',cron:'30 9 * * 1-5',mode:'new',task:'总结',timeZone:'Asia/Shanghai'},{pane:'w1:p1',id:'1a2b',task:'新的'}]);
  bridge.requests.length=0;
  await schedule(bridge,['list','--machine','cpu2','--pane','w2:p3'],{env:{HERDR_SESSION:'work'}});await schedule(bridge,['add','--tz','UTC','--cron','0 9 * * *','--mode','into','--task','t']);
  assert.deepEqual(bridge.requests.map(r=>r[3]),[{machine:'cpu2',pane:'w2:p3',session:'work'},{pane:'w1:p1',timeZone:'UTC',cron:'0 9 * * *',mode:'into',task:'t'}]);
  // With --stdin the arguments come NUL-separated on stdin, before those on the command line, which take precedence.
  bridge.requests.length=0;
  assert.equal((await schedule(bridge,['--stdin','--machine','pinned'],{env:{HERDR_PANE_ID:''},stdin:['--machine','claimed','--pane','w9:p9','add','--cron','0 9 * * *','--mode','new','--task',"带 '引号'\n和换行",''].join('\0')})).code,0);
  assert.deepEqual(bridge.requests.map(r=>r[3]),[{machine:'pinned',pane:'w9:p9',cron:'0 9 * * *',mode:'new',task:"带 '引号'\n和换行",timeZone:'Asia/Shanghai'}]);
 }finally{await bridge.close();}
});
test('bridge-schedule prints what Bridge refused and exits 1, a usage error with the usage and exits 2, and says so when no Bridge listens on its machine',async()=>{
 const bridge=await fakeBridge(()=>[400,{error:'定时任务不存在'}]);try{
  assert.deepEqual(await schedule(bridge,['pause','x']),{code:1,out:'',err:'bridge-schedule: 定时任务不存在\n'});
  for(const args of [[],['loop'],['list','--loop']]){const r=await schedule(bridge,args);assert.equal(r.code,2,args.join(' '));assert.match(r.err,/用法：\n  bridge-schedule add --cron/);}
  const help=await schedule(bridge,['--help']);assert.equal(help.code,0);assert.match(help.out,/^用法：/);assert.deepEqual(bridge.requests.map(r=>r[1]),['/schedules/pause']);
  const gone={dir:path.join(bridge.dir,'none')},r=await schedule(gone,['list']);
  assert.deepEqual(r,{code:1,out:'',err:`bridge-schedule: 连不上 Bridge（${path.join(gone.dir,'agent.sock')}）：Bridge 没有运行，或者这台机器不是 Bridge 所在的机器\n`});
  // A socket it may not open, as in the sandbox of an agent that forbids connections.
  fs.chmodSync(bridge.socket,0);
  if(process.getuid?.()!==0)assert.deepEqual(await schedule(bridge,['list']),{code:1,out:'',err:`bridge-schedule: 没有权限连接 Bridge（${bridge.socket}）：如果命令运行在 Agent 的沙箱里，需要在沙箱外运行这条命令\n`});
 }finally{await bridge.close();}
});
// Runs program with args in env without blocking, so that a fake Bridge of this process can answer it; resolves to {status, stdout, stderr}.
function spawned(program,args,env){
 return new Promise((resolve,reject)=>{const p=spawn(program,args,{env});let stdout='',stderr='';p.stdout.on('data',d=>{stdout+=d;});p.stderr.on('data',d=>{stderr+=d;});p.on('error',reject);p.on('close',status=>resolve({status,stdout,stderr}));});
}
test('on a machine that Bridge reaches over SSH, bridge-schedule-ssh runs bridge-schedule on the Bridge host over ssh, with this machine\'s name, its agent\'s pane and the arguments on stdin, never on the remote command line',async()=>{
 const bridge=await fakeBridge((op,body)=>body.id==='gone'?[400,{error:'定时任务不存在'}]:[200,{binding:{id:'b',name:'个人助手'},topicId:'t',schedules:[]}]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-ssh-agent-')),bin=path.join(dir,'bin'),home=path.join(dir,'bridge home'),args=path.join(dir,'args');
 try{
  // A fake ssh records its arguments and runs the remote command in its home, with what it reads on stdin; there bridge-schedule is installed.
  fs.mkdirSync(bin);fs.mkdirSync(path.join(home,'.local','bin'),{recursive:true});
  fs.writeFileSync(path.join(bin,'ssh'),['#!/bin/sh',`printf '%s\\n' "$@" >> ${quote(args)}`,'for last; do :; done',`cd ${quote(home)} && HOME=${quote(home)} exec sh -c "$last"`,''].join('\n'),{mode:0o700});
  fs.writeFileSync(path.join(home,'.local','bin','bridge-schedule'),['#!/bin/sh',`BRIDGE_STATE=${quote(bridge.dir)} exec ${quote(process.execPath)} ${quote(path.join(path.dirname(fileURLToPath(import.meta.url)),'bin','bridge-schedule.mjs'))} "$@"`,''].join('\n'),{mode:0o700});
  const wrapper=path.join(path.dirname(fileURLToPath(import.meta.url)),'bin','bridge-schedule-ssh'),task="带 '单引号' \"双引号\" $(id) `id` \\ 和\n换行";
  const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_')&&!k.startsWith('BRIDGE_'))),PATH:bin+':'+process.env.PATH,BRIDGE_HOST:'bridge-host',BRIDGE_MACHINE:'cpu2',HERDR_PANE_ID:'w3:p2'};
  const r=await spawned(wrapper,['add','--cron','0 9 * * *','--mode','new','--task',task,'--tz','UTC','--json'],env);
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{binding:{id:'b',name:'个人助手'},topicId:'t',schedules:[]});
  assert.deepEqual(bridge.requests.map(x=>x[3]),[{machine:'cpu2',pane:'w3:p2',cron:'0 9 * * *',mode:'new',task,timeZone:'UTC'}]);
  const sent=fs.readFileSync(args,'utf8');assert.ok(!sent.includes('单引号'));assert.deepEqual(sent.trim().split('\n').slice(-2),['bridge-host','.local/bin/bridge-schedule --stdin']);
  assert.match(sent,/BatchMode=yes/);
  // What Bridge refuses comes back with its exit status; without the host or the machine name nothing runs.
  const refused=await spawned(wrapper,['pause','gone'],env);assert.deepEqual([refused.status,refused.stdout,refused.stderr],[1,'','bridge-schedule: 定时任务不存在\n']);
  bridge.requests.length=0;fs.writeFileSync(args,'');
  const missing=await spawned(wrapper,['list'],{...env,BRIDGE_HOST:''});
  assert.equal(missing.status,2);assert.match(missing.stderr,/BRIDGE_HOST 和 BRIDGE_MACHINE/);assert.equal(fs.readFileSync(args,'utf8'),'');
 }finally{fs.rmSync(dir,{recursive:true});await bridge.close();}
});
test('the bridge-schedule skill that Bridge places has a name and a description and names every operation of the command',()=>{
 const skill=fs.readFileSync(path.join(bundledSkills,'bridge-schedule','SKILL.md'),'utf8');
 const [,front,body]=/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(skill)||[];
 assert.match(front,/^name: bridge-schedule\ndescription: \S.+$/);
 // The instructions name the operations of the command as it takes them.
 for(const line of usage.split('\n').filter(l=>l.startsWith('  bridge-schedule ')))assert.ok(body.includes(line.trim().split(' ').slice(0,2).join(' ')),line);
});
const minutes=n=>n*60000;
function pendingFixture({bridgeUrl='http://bridge.example:8080',onBound}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-pending-')),store=new Store(dir),replies=[],bound=[],clock={now:1000};
 store.data.apps=[{...allowed}];store.data.machines=[{id:'m',name:'cpu2'}];store.save();
 const lookup=(collection,error)=>id=>{const x=store.data[collection].find(y=>y.id===id);if(!x)throw Error(error);return x;};
 const pending=new PendingChats(store,{reply:async(a,chatId,rootId,content)=>{replies.push([a.id,chatId,rootId,content]);},onBound:onBound||((...args)=>{bound.push(args);}),
  app:lookup('apps','应用不存在'),machine:lookup('machines','机器连接不存在'),bridgeUrl,now:()=>clock.now});
 return {dir,store,replies,bound,clock,pending,close(){fs.rmSync(dir,{recursive:true});}};
}
const firstDm={...inbound,chatType:'p2p',messageId:'om_first',content:'first private prompt'};
const form={name:'飞书私聊',machineId:'m',cwd:'~/work',kind:'claude',requireMention:true};
test('an unbound chat gets a pending record kept in memory only and one reply in the thread of its message with the binding link',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,firstDm);
  const [chat]=f.pending.list();assert.match(chat.token,/^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(chat,{token:chat.token,appId:'a',chatId:'oc_1',chatType:'p2p',createdAt:1000,expiresAt:1000+minutes(30)});
  // The link shows its URL and opens it.
  assert.deepEqual(f.replies,[['a','oc_1','om_first',{card:untitledOf('这个聊天还没有连接到 Herdr，打开链接完成绑定：',[plainText('这个聊天还没有连接到 Herdr，打开链接完成绑定：'),{tag:'markdown',content:`<a href='http://bridge.example:8080/?bind=${chat.token}'></a>`}])}]]);
  assert.ok(!fs.readFileSync(path.join(f.dir,'state.json'),'utf8').includes('first private prompt'));assert.ok(!fs.readFileSync(path.join(f.dir,'state.json'),'utf8').includes(chat.token));
  await f.pending.open(allowed,{...firstDm,chatId:'oc_group',chatType:'group',messageId:'om_group'});assert.deepEqual(f.pending.list().map(c=>[c.chatId,c.chatType]),[['oc_1','p2p'],['oc_group','group']]);
 }finally{f.close();}
});
test('a chat with a live record gets no second reply and keeps its first message; once expired it gets a new token',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,firstDm);const [{token}]=f.pending.list();
  f.clock.now+=minutes(29);await f.pending.open(allowed,{...firstDm,messageId:'om_second',content:'second'});
  assert.equal(f.replies.length,1);assert.deepEqual(f.pending.list().map(c=>c.token),[token]);
  f.clock.now+=minutes(1);assert.deepEqual(f.pending.list(),[]);
  await f.pending.open(allowed,{...firstDm,messageId:'om_third',content:'third'});
  const [chat]=f.pending.list();assert.notEqual(chat.token,token);assert.equal(chat.createdAt,1000+minutes(30));assert.equal(f.replies.length,2);assert.equal(f.replies[1][2],'om_third');
  f.pending.bind({...form,token:chat.token});assert.equal(f.bound[0][2].messageId,'om_third');
 }finally{f.close();}
});
test('without BRIDGE_URL the reply points to the console instead of a link; a failed reply is logged',async()=>{
 const f=pendingFixture({bridgeUrl:''});try{
  await f.pending.open(allowed,firstDm);assert.deepEqual(f.replies.map(r=>r[3]),[notice('这个聊天还没有连接到 Herdr，请在 Bridge 管理台「会话绑定」中完成绑定。')]);
  f.pending.reply=async()=>{throw Error('飞书未连接');};await f.pending.open(allowed,{...firstDm,chatId:'oc_2'});
  assert.equal(f.pending.list().length,2);assert.equal(f.store.data.logs.at(-1).level,'error');assert.match(f.store.data.logs.at(-1).message,/飞书未连接/);
 }finally{f.close();}
});
test('BRIDGE_URL must be an http(s) origin; a trailing slash is dropped',()=>{
 for(const [v,origin] of [['http://bridge.example:8080/','http://bridge.example:8080'],['https://bridge.example','https://bridge.example'],['',''],[undefined,'']])assert.equal(consoleUrl(v),origin);
 for(const v of ['http://bridge.example/admin','http://bridge.example/?x=1','http://bridge.example/#a','ftp://bridge.example','bridge.example:8080','http://user:pw@bridge.example','not a url'])assert.throws(()=>consoleUrl(v),/BRIDGE_URL/,v);
});
test('binding a pending chat takes app and chat from the record, spends the token and hands the first message over without waiting',async()=>{
 const f=pendingFixture({onBound:(...args)=>{f.bound.push(args);return new Promise(()=>{});}});try{
  await f.pending.open(allowed,firstDm);await f.pending.open(allowed,{...firstDm,chatId:'oc_2',messageId:'om_other'});const [{token},other]=f.pending.list();
  const binding=f.pending.bind({...form,token,appId:'forged',chatId:'oc_forged'});
  const {id,...rest}=binding;assert.deepEqual(rest,{name:'飞书私聊',appId:'a',machineId:'m',chatId:'oc_1',cwd:'~/work',kind:'claude',permissionMode:'default',requireMention:false,enabled:true});
  assert.deepEqual(new Store(f.dir).data.bindings,[binding]);assert.deepEqual(f.bound,[[f.store.data.apps[0],binding,firstDm]]);
  assert.deepEqual(f.pending.list().map(c=>c.token),[other.token]);
  assert.throws(()=>f.pending.bind({...form,token}),/^Error: 绑定链接已失效，请在飞书里重新发消息$/);
  for(const bad of [{token:'unknown'},{token:undefined},{}])assert.throws(()=>f.pending.bind({...form,...bad}),/绑定链接已失效/);
  // An invalid form or an unknown machine keeps the token for another try.
  assert.throws(()=>f.pending.bind({...form,token:other.token,cwd:'relative'}),/工作目录/);assert.throws(()=>f.pending.bind({...form,token:other.token,machineId:'gone'}),/机器连接不存在/);
  assert.deepEqual(f.pending.list().map(c=>c.token),[other.token]);assert.equal(f.store.data.bindings.length,1);
 }finally{f.close();}
});
test('a group binding keeps the mention choice and the permission mode chosen; a chat whose app was removed cannot be bound',async()=>{
 const f=pendingFixture();try{
  await f.pending.open(allowed,{...firstDm,chatType:'group',chatId:'oc_group'});
  const binding=f.pending.bind({...form,permissionMode:'auto',token:f.pending.list()[0].token});assert.deepEqual([binding.requireMention,binding.permissionMode],[true,'auto']);
  await f.pending.open(allowed,{...firstDm,chatType:'group',chatId:'oc_group2',messageId:'om_g2'});f.store.data.apps=[];
  assert.throws(()=>f.pending.bind({...form,token:f.pending.list()[0].token}),/应用不存在/);
 }finally{f.close();}
});
test('binding a pending chat opens the first topic with its first message only when that message can be forwarded: an image does, only the mention or a sticker does not',async()=>{
 for(const [message,opens] of [[{...firstDm,messageId:'om_image',...imageOf('img_1')},true],[{...firstDm,messageId:'om_mention',chatType:'group',chatId:'oc_group',content:'',mentionedBot:true},false],[{...firstDm,messageId:'om_sticker',...sticker},false]]){
  const f=pendingFixture();try{
   await f.pending.open(allowed,message);assert.deepEqual(f.replies.map(r=>r[2]),[message.messageId]);
   const binding=f.pending.bind({...form,token:f.pending.list()[0].token});
   assert.deepEqual(f.store.data.bindings,[binding],message.messageId);assert.deepEqual(f.bound,opens?[[f.store.data.apps[0],binding,message]]:[],message.messageId);assert.deepEqual(f.pending.list(),[]);
  }finally{f.close();}
 }
});

const png=Buffer.from('89504e470d0a1a0a0000','hex');
// The app's slash commands as Feishu lists them, by default the bridge's own with their descriptions.
const slashPath='/open-apis/application/v7/app_slash_commands',described=text=>({default_value:text,i18n:{zh_cn:text}});
const registered=[{command_id:'c-adopt',command:'adopt',description:described('接管正在运行的 Agent')},{command_id:'c-release',command:'release',description:described('结束接管')},{command_id:'c-stop',command:'stop',description:described('停止 Agent 当前这一轮')},
 {command_id:'c-wt',command:'wt',description:described('在新的 Git worktree 里开一个话题')}];
// A connected channel whose bot info comes from info() and whose slash command calls are answered by commands(request); every avatar
// download is answered by avatar(url).
function botFixture({info,avatar,commands=()=>({code:0,msg:'success',data:{items:registered}})}={}){
 const requests=[],downloads=[];
 const channel={on(){},connect:async()=>{},disconnect:async()=>{},getConnectionStatus:()=>({state:'connected'}),rawClient:{request:async o=>{requests.push(o);return o.url==='/open-apis/bot/v3/info'?info():commands(o);}}};
 const f=platformFixture({channelFactory:()=>channel,fetch:async(url,options)=>{downloads.push(String(url));assert.ok(options.signal);return avatar(String(url));}});
 const a={id:'app-1',name:'注册时的名称',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:['ou_user'],enabled:true};f.store.data.apps=[a];f.store.save();
 return {...f,a,requests,downloads,file:path.join(f.dir,'avatars','app-1')};
}
const botInfo=(bot={})=>()=>({code:0,bot:{app_name:'飞书机器人',open_id:'ou_bot',avatar_url:'https://cdn.example/avatar.png',...bot}});
test('connecting and verifying take the name and open_id from Feishu and store the https avatar',async()=>{
 const f=botFixture({info:botInfo(),avatar:()=>new Response(png,{headers:{'content-type':'image/png'}})});try{
  await f.platforms.start(f.a);
  assert.deepEqual(f.requests,[{url:'/open-apis/bot/v3/info',method:'GET'},{method:'GET',url:slashPath}]);assert.deepEqual(f.downloads,['https://cdn.example/avatar.png']);
  assert.equal(f.a.name,'飞书机器人');assert.equal(f.a.botOpenId,'ou_bot');assert.equal('botName' in f.a,false);assert.ok(f.a.verifiedAt>0);
  assert.deepEqual(fs.readFileSync(f.file),png);assert.equal(fs.statSync(f.file).mode&0o777,0o600);assert.equal(f.a.avatar.type,'image/png');assert.ok(f.a.avatar.updatedAt>0);
  assert.deepEqual(new Store(f.dir).data.apps[0].avatar,f.a.avatar);assert.equal(f.platforms.status(f.a).connection,'connected');
  const avatar=await f.platforms.avatar('app-1');assert.deepEqual([avatar.type,avatar.body],['image/png',png]);
  f.requests.length=0;const jpeg=Buffer.from('ffd8ffe0','hex');
  f.platforms.fetch=async()=>new Response(jpeg,{headers:{'content-type':'image/jpeg; charset=binary'}});f.platforms.channel(f.a).rawClient.request=async o=>{f.requests.push(o);return {code:0,data:{bot:{app_name:'改名后的机器人',open_id:'ou_bot',avatar_url:'https://cdn.example/new.jpg'}}};};
  assert.deepEqual(await f.platforms.verify(f.a),{verified:true,name:'改名后的机器人'});
  assert.deepEqual(f.requests,[{url:'/open-apis/bot/v3/info',method:'GET'}]);assert.equal(f.a.name,'改名后的机器人');assert.deepEqual(fs.readFileSync(f.file),jpeg);assert.equal(f.a.avatar.type,'image/jpeg');
 }finally{f.close();}
});
test('an avatar that is not https, over 1 MB or not an image is not stored; the old avatar and the connection stay',async()=>{
 const cases=[['http://cdn.example/a.png',()=>new Response(png,{headers:{'content-type':'image/png'}}),0],
  ['https://cdn.example/big.png',()=>new Response(Buffer.alloc(1024*1024+1),{headers:{'content-type':'image/png'}}),1],
  ['https://cdn.example/page',()=>new Response('<html>',{headers:{'content-type':'text/html'}}),1],
  ['https://cdn.example/missing',()=>new Response('no',{status:404,headers:{'content-type':'image/png'}}),1]];
 for(const [url,avatar,downloads] of cases){
  const f=botFixture({info:botInfo({avatar_url:url}),avatar});try{
   fs.mkdirSync(path.dirname(f.file));fs.writeFileSync(f.file,'old');const old={type:'image/png',updatedAt:1};f.a.avatar=old;
   await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected',url);
   assert.equal(f.downloads.length,downloads,url);assert.equal(fs.readFileSync(f.file,'utf8'),'old',url);assert.deepEqual(f.a.avatar,old,url);assert.equal(f.a.name,'飞书机器人');
   assert.equal(f.store.data.logs.at(-1).level,'error',url);
   await f.platforms.verify(f.a);assert.equal(fs.readFileSync(f.file,'utf8'),'old',url);
  }finally{f.close();}
 }
});
test('an svg avatar is rejected because it can carry script; the old avatar stays',async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
 for(const type of ['image/svg+xml','image/svg+xml; charset=utf-8','IMAGE/SVG+XML']){
  const f=botFixture({info:botInfo({avatar_url:'https://cdn.example/avatar.svg'}),avatar:()=>new Response(svg,{headers:{'content-type':type}})});try{
   fs.mkdirSync(path.dirname(f.file));fs.writeFileSync(f.file,'old');const old={type:'image/png',updatedAt:1};f.a.avatar=old;
   await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected',type);
   assert.equal(f.downloads.length,1,type);assert.equal(fs.readFileSync(f.file,'utf8'),'old',type);assert.deepEqual(f.a.avatar,old,type);
   assert.equal(f.store.data.logs.at(-1).level,'error',type);assert.match(f.store.data.logs.at(-1).message,/头像/,type);
   const served=await f.platforms.avatar('app-1');assert.deepEqual([served.type,served.body.toString()],['image/png','old'],type);
  }finally{f.close();}
 }
});
test('a failed bot info request is only logged after connecting but fails a credential check',async()=>{
 const f=botFixture({info:()=>({code:99991663,msg:'invalid'}),avatar:()=>assert.fail('no download')});try{
  await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected');assert.equal(f.a.name,'注册时的名称');assert.equal(f.store.data.logs.at(-1).level,'error');
  await assert.rejects(f.platforms.verify(f.a),/应用凭证验证失败/);assert.equal(await f.platforms.avatar('app-1'),null);assert.equal(await f.platforms.avatar('../state.json'),null);
 }finally{f.close();}
});
test('connecting offers the commands in the slash command panel of the app: a missing one is created and one with another description updated; commands of the app are never deleted',async()=>{
 const items=[registered[0],{...registered[1],description:described('旧的说明')},{command_id:'c-deploy',command:'deploy',description:described('部署')}];
 const f=botFixture({info:botInfo({avatar_url:''}),avatar:()=>assert.fail('no download'),commands:o=>o.method==='GET'?{code:0,data:{items}}:{code:0,data:{command_id:'c-new'}}});try{
  await f.platforms.start(f.a);
  assert.deepEqual(f.requests.slice(1),[{method:'GET',url:slashPath},{method:'PATCH',url:slashPath+'/c-release',data:{command:'release',description:described('结束接管')}},{method:'POST',url:slashPath,data:{command:'stop',description:described('停止 Agent 当前这一轮')}},
   {method:'POST',url:slashPath,data:{command:'wt',description:described('在新的 Git worktree 里开一个话题')}}]);
  assert.deepEqual(f.store.data.logs.filter(l=>l.kind==='斜杠命令').map(l=>[l.level,l.message]),[['info','飞书机器人：已注册斜杠命令 /release、/stop、/wt']]);
 }finally{f.close();}
});
test('without the slash command scopes, or when Feishu refuses a command, connecting logs one line and the app stays connected; every connection tries again',async()=>{
 const denied=code=>()=>{throw Object.assign(Error('Request failed with status code 400'),{response:{status:400,data:{code,msg:'Access denied. One of the following scopes is required'}}});};
 const scopes='飞书机器人：未能注册斜杠命令，应用缺少权限 application:app_slash_command:read / write；命令仍可手动输入';
 for(const [commands,message,calls] of [[denied(99991672),scopes,1],[o=>o.method==='GET'?{code:0,data:{items:[]}}:denied(99991640)(),scopes,2],
  [()=>({code:40000000,msg:'command already exists'}),'飞书机器人：未能注册斜杠命令，飞书接口错误 40000000：command already exists',1]]){
  const f=botFixture({info:botInfo({avatar_url:''}),avatar:()=>assert.fail('no download'),commands});try{
   const logs=()=>f.store.data.logs.filter(l=>l.kind==='斜杠命令').map(l=>[l.level,l.message]);
   await f.platforms.start(f.a);assert.equal(f.platforms.status(f.a).connection,'connected',message);
   assert.deepEqual(logs(),[['error',message]]);assert.equal(f.requests.length-1,calls,message);
   await f.platforms.stop(f.a.id);await f.platforms.start(f.a);assert.equal(logs().length,2,message);
  }finally{f.close();}
 }
});
test('an OpenAPI call through the connected channel resolves to the data of a response with code 0, or to a body without that envelope; it rejects with Feishu\'s code otherwise, also for an HTTP error status',async()=>{
 const f=platformFixture(),answers=[],seen=[];try{
  await assert.rejects(f.platforms.request(allowed,{method:'GET',url:'/x'}),/飞书未连接/);
  f.platforms.runtime.set('a',{channel:{getConnectionStatus:()=>({state:'connected'}),rawClient:{request:async o=>{seen.push(o);return answers.shift()();}}}});
  answers.push(()=>({code:0,msg:'success',data:{cot_id:'1'}}),()=>({cot_id:'2',message_id:'om_2'}),()=>({code:230001,msg:'bad request'}),
   ()=>{throw Object.assign(Error('Request failed with status code 400'),{response:{status:400,data:{code:99991672,msg:'denied'}}});},()=>{throw Error('timeout of 10000ms exceeded');});
  const call={method:'POST',url:'/open-apis/im/v1/message_cot',params:{receive_id_type:'chat_id'},data:{receive_id:'oc_1'}};
  assert.deepEqual(await f.platforms.request(allowed,call),{cot_id:'1'});assert.deepEqual(seen,[call]);
  assert.deepEqual(await f.platforms.request(allowed,call),{cot_id:'2',message_id:'om_2'});
  await assert.rejects(f.platforms.request(allowed,call),e=>e.code===230001&&e.message==='飞书接口错误 230001：bad request');
  await assert.rejects(f.platforms.request(allowed,call),e=>e.code===99991672&&e.message==='飞书接口错误 99991672：denied');
  await assert.rejects(f.platforms.request(allowed,call),/^Error: timeout of 10000ms exceeded$/);
 }finally{f.close();}
});
test('removing an app deletes its avatar',async()=>{
 const f=botFixture({info:botInfo(),avatar:()=>new Response(png,{headers:{'content-type':'image/png'}})});try{
  await f.platforms.start(f.a);assert.ok(fs.existsSync(f.file));
  await f.platforms.remove('app-1');assert.equal(fs.existsSync(f.file),false);assert.deepEqual(new Store(f.dir).data.apps,[]);assert.equal(f.platforms.runtime.has('app-1'),false);
  await assert.rejects(f.platforms.remove('../state.json'),/应用不存在/);assert.ok(fs.existsSync(path.join(f.dir,'state.json')));
 }finally{f.close();}
});

test('official onboarding automatically connects after persisting credentials',async()=>{
 let connected=false;
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_auto',client_secret:'private',user_info:{open_id:'ou_owner'}};},{connect:async a=>{assert.equal(new Store(f.store.dir).data.apps[0].appId,'cli_auto');assert.equal(f.registrations.status().status,'connecting');a.enabled=true;f.store.save();connected=true;}});
 try{f.registrations.start({});await f.registrations.current.done;assert.ok(connected);assert.equal(f.registrations.status().status,'completed');assert.equal(f.store.data.apps[0].enabled,true);}finally{f.close();}
});
test('existing app selection keeps its identity, bindings and allowlist',async()=>{
 const app=normalizeApp({name:'existing',appId:'cli_existing',appSecret:'saved',allowedUsers:['ou_existing']});let target;
 const f=registrationFixture(async o=>{assert.equal(o.createOnly,false);ready(o);return {client_id:app.appId,client_secret:'sdk',user_info:{open_id:'ou_other'}};},{connect:async a=>{target=a;}});
 try{f.store.data.apps.push(app);f.store.data.bindings.push({appId:app.id});f.registrations.start({});await f.registrations.current.done;assert.equal(f.store.data.apps.length,1);assert.equal(target,app);assert.deepEqual(app.allowedUsers,['ou_existing']);assert.equal(f.registrations.status().appId,app.id);assert.equal(f.store.data.bindings[0].appId,app.id);}finally{f.close();}
});
test('connection failure retains the added app for retry without showing false success',async()=>{
 const f=registrationFixture(async o=>{ready(o);return {client_id:'cli_failed',client_secret:'private',user_info:{open_id:'ou_owner'}};},{connect:async()=>{throw Error('private response');}});
 try{f.registrations.start({});await f.registrations.current.done;assert.equal(f.registrations.status().status,'connection_error');assert.equal(f.store.data.apps.length,1);assert.equal(f.registrations.status().appId,f.store.data.apps[0].id);assert.ok(!JSON.stringify(f.registrations.status()).includes('private'));}finally{f.close();}
});

test('channel startup and shutdown do not revive a cancelled connection',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-lifecycle-'));let resolve,options;const handlers={};let closes=0;
 const channel={on:(name,fn)=>handlers[name]=fn,connect:()=>new Promise(r=>resolve=r),disconnect:async()=>{},rawWsClient:{close:()=>closes++},getConnectionStatus:()=>({state:'connected'})};
 const store=new Store(dir),messages=[],p=new Platforms(store,{onMessage:(...args)=>messages.push(args),channelFactory:o=>{options=o;return channel;}}),a={id:'a',name:'bot',appId:'cli_test',appSecret:'private',allowedUsers:['ou_owner'],domain:'feishu',enabled:true};
 try{store.data.bindings=[route];const pending=p.start(a);const rejected=assert.rejects(pending,/连接失败/);assert.equal(options.safety.batch.text.delayMs,0);await p.stop(a.id);resolve();await rejected;assert.ok(closes>=2);assert.equal(p.runtime.has(a.id),false);handlers.message({...inbound,senderId:'ou_owner'});assert.deepEqual(messages,[]);}finally{fs.rmSync(dir,{recursive:true});}
});
test('the server lists pending chats, saves bindings only through a link token, changes only the permission mode of a Claude binding, serves app avatars and reports topics without message ids, reactions, request cards, COT, the card of a worktree or a schedule waiting for confirmation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),herdr=path.join(dir,'herdr'),agents=[{agent:'claude',pane_id:'w1:p1',agent_status:'idle',agent_session:{value:'s-1'}}];
 fs.mkdirSync(path.join(state,'avatars'),{recursive:true});fs.writeFileSync(path.join(state,'initialized'),'1');fs.writeFileSync(path.join(state,'avatars','app-avatar'),png);fs.writeFileSync(path.join(state,'avatars','app-gone'),png);
 const topic={bindingId:'b-old',appId:'x',chatId:'oc_9',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',agentName:'feishu-1',title:'t',error:'',messageIds:['om_1'],reactions:[{messageId:'om_1',reactionId:'r_1',stateSeq:1}],cards:[{requestId:1,messageId:'om_card',title:'权限确认 · Bash'}],cot:{cotId:'c1',messageId:'om_cot',origin:'om_1',stateSeq:1,toolSeq:0,waiting:false},proposal:{id:'p1',kind:'add',fields:{mode:'new',cron:'0 9 * * *',timeZone:'UTC',task:'x'},messageId:'om_p',expiresAt:1},createdAt:1};
 const worktree={branch:'feat/x',path:'/src/r-worktrees/feat-x',root:'/src/r'};
 const app={name:'bot',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:[],enabled:false};
 const claude={id:'b-claude',name:'助手',appId:'x',machineId:'m',chatId:'oc_8',cwd:'~/work',kind:'claude',requireMention:false,enabled:true},codex={...claude,id:'b-codex',chatId:'oc_7',kind:'codex'},agy={...claude,id:'b-agy',chatId:'oc_6',kind:'agy'};
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({apps:[{...app,id:'app-avatar',avatar:{type:'image/png',updatedAt:5}},{...app,id:'app-plain',appId:'cli_plain'},{...app,id:'app-gone',appId:'cli_gone',avatar:{type:'image/png',updatedAt:5}}],
  bindings:[{id:'b-old',appId:'x',machineId:'m',chatId:'oc_9'},claude,codex,agy],topics:[{...topic,id:'t1',state:'starting'},{...topic,id:'t2',bindingId:'b-keep',state:'ready',worktree:{...worktree,card:{messageId:'om_wt',heading:'话题已结束',text:'x'}}}]}));
 fs.writeFileSync(herdr,`#!/bin/sh\nif [ "$3" = agent ]; then echo '${JSON.stringify({result:{agents}})}'; else echo '{"result":{"panes":[{"pane_id":"w1:p1"}]}}'; fi\n`,{mode:0o700});
 const port=await new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port));});});
 const server=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:state,PORT:String(port),BIND:'127.0.0.1',BRIDGE_URL:'http://127.0.0.1:'+port+'/'},stdio:['ignore','pipe','inherit']});
 try{
  await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('listening'))resolve();});server.on('exit',()=>reject(Error('server exited')));});
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim();
  const api=async(p,body)=>{const r=await fetch(`http://127.0.0.1:${port}/api/${p}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key},body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const machineId=(await api('machines/save',{name:'fake',type:'local',binary:herdr,enabled:true})).body.id;
  const input={token:'forged',name:'route',appId:'app-plain',machineId,chatId:'oc_1',cwd:'~/work',kind:'claude',requireMention:true};
  assert.deepEqual(await api('bindings/save',input),{status:400,body:{error:'绑定链接已失效，请在飞书里重新发消息'}});
  const s=(await api('state')).body;assert.deepEqual(Object.keys(s).sort(),['apps','bindings','host','logs','machines','pendingChats','registration','topics','version']);
  assert.deepEqual(s.pendingChats,[]);assert.deepEqual(s.bindings.map(b=>b.id),['b-old','b-claude','b-codex','b-agy']);assert.deepEqual(s.apps[0].avatar,{type:'image/png',updatedAt:5});
  const {messageIds,reactions,cards,cot,proposal,...listed}={...topic,id:'t1',state:'failed',error:'Bridge 重启时 Agent 启动未完成'};assert.deepEqual(s.topics[0],listed);for(const key of ['messageIds','reactions','cards','cot','proposal'])assert.equal(key in s.topics[1],false,key);
  assert.deepEqual(s.topics[1].worktree,worktree);
  // Other fields sent along are ignored; a refused change keeps the saved bindings as they are.
  assert.deepEqual(await api('bindings/permission-mode',{id:'b-claude',permissionMode:'auto',name:'改名',cwd:'/etc',kind:'codex'}),{status:200,body:{ok:true}});
  for(const [body,error] of [[{id:'b-claude',permissionMode:'bypassPermissions'},'权限模式无效'],[{id:'b-codex',permissionMode:'auto'},'只有 Claude 绑定可以设置权限模式'],[{id:'b-agy',permissionMode:'auto'},'只有 Claude 绑定可以设置权限模式'],[{id:'unknown',permissionMode:'auto'},'会话绑定不存在']])assert.deepEqual(await api('bindings/permission-mode',body),{status:400,body:{error}},body.id);
  const changed=(await api('state')).body;assert.deepEqual(changed.bindings.slice(1),[{...claude,permissionMode:'auto'},codex,agy]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8')).bindings.slice(1),[{...claude,permissionMode:'auto'},codex,agy]);
  assert.deepEqual(changed.logs.filter(l=>l.kind==='会话绑定').map(l=>l.message),['助手：权限模式改为 auto，之后新开的话题生效']);
  assert.equal((await api('bindings/remove',{id:'b-old'})).status,200);assert.deepEqual((await api('state')).body.topics.map(t=>t.id),['t2']);
  const avatar=async(id,headers={authorization:'Bearer '+key})=>fetch(`http://127.0.0.1:${port}/api/apps/avatar?id=${encodeURIComponent(id)}`,{headers});
  const image=await avatar('app-avatar');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('cache-control'),'private, max-age=300');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await avatar('app-avatar',{})).status,401);for(const id of ['app-plain','unknown','../state.json'])assert.equal((await avatar(id)).status,404,id);
  assert.equal((await api('apps/remove',{id:'app-gone'})).status,200);assert.equal(fs.existsSync(path.join(state,'avatars','app-gone')),false);assert.ok(fs.existsSync(path.join(state,'avatars','app-avatar')));
  assert.equal((await api('apps/remove',{id:'../avatars/app-avatar'})).status,400);assert.ok(fs.existsSync(path.join(state,'avatars','app-avatar')));
  const [m]=(await api('state')).body.machines;assert.equal(m.state,'connected');assert.deepEqual(m.agents,agents);assert.deepEqual(m.panes,[{pane_id:'w1:p1'}]);
  assert.deepEqual(Object.keys(m).sort(),['agents','binary','checkedAt','enabled','host','id','name','panes','port','session','state','type']);
  assert.equal((await api('machines/install',{id:machineId})).status,404);
 }finally{server.kill();if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(dir,{recursive:true});}
});
test('the server hands every refreshed agent list to the topics, which forward new replies, remove the reactions of ended turns and send cards for new requests; the topic\'s agent reaches it with bridge-schedule; removing the binding turns off remote answers for its topic and removes its attachment directory',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'state'),herdr=path.join(dir,'herdr'),calls=path.join(dir,'calls'),attachments=path.join(dir,'work','.herdr-bridge','t');
 const agent={agent:'claude',name:'feishu-1',pane_id:'w1:p1',agent_status:'idle',state_change_seq:2,reply_seq:1,request_ids:[1],remote_answers:true};
 fs.mkdirSync(state);fs.writeFileSync(path.join(state,'initialized'),'1');
 fs.writeFileSync(path.join(state,'state.json'),JSON.stringify({machines:[{id:'m',name:'fake',type:'local',session:'default',binary:herdr,enabled:true}],
  apps:[{id:'app',name:'bot',appId:'cli_test',appSecret:'secret',domain:'feishu',allowedUsers:[],enabled:false}],bindings:[{id:'b',name:'助手',appId:'app',machineId:'m',chatId:'oc_1',cwd:'~/work',kind:'claude',requireMention:false,enabled:true}],
  topics:[{id:'t',bindingId:'b',appId:'app',chatId:'oc_1',rootId:'om_1',machineId:'m',workspaceId:'w1',tabId:'w1:t1',paneId:'w1:p1',agentName:'feishu-1',title:'t',state:'ready',error:'',messageIds:['om_1'],
   reactions:[{messageId:'om_1',reactionId:'r_1',stateSeq:1}],attachmentDir:attachments,createdAt:1}]}));
 fs.mkdirSync(attachments,{recursive:true});fs.writeFileSync(path.join(attachments,'om_1-1.png'),'png');
 fs.writeFileSync(herdr,['#!/bin/sh',`echo "$*" >> ${quote(calls)}`,'case "$3 $4" in',
  ` 'agent list') echo ${quote(JSON.stringify({result:{type:'agent_list',agents:[agent]}}))};;`,
  ` 'agent replies') echo ${quote(JSON.stringify({result:{type:'agent_replies',agent,replies:[{seq:1,text:'hi'}]}}))};;`,
  ` 'agent requests') echo ${quote(JSON.stringify({result:{type:'agent_requests',agent,requests:[bash]}}))};;`,
  ` *) echo '{"result":{"panes":[]}}';;`,'esac',''].join('\n'),{mode:0o700});
 const port=await new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port));});});
 const server=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:state,PORT:String(port),BIND:'127.0.0.1'},stdio:['ignore','pipe','inherit']});
 try{
  await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('listening'))resolve();});server.on('exit',()=>reject(Error('server exited')));});
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim(),api=async p=>(await fetch(`http://127.0.0.1:${port}/api/${p}`,{headers:{authorization:'Bearer '+key}})).json();
  // The app is not connected, so the forward, the removal and the card fail and are logged; no Feishu request is made.
  let s;for(let i=0;i<100;i++){s=await api('state');if(s.logs.some(l=>l.kind==='请求卡片'))break;await later(50);}
  assert.equal(s.topics[0].replySeq,1);assert.deepEqual(s.logs.filter(l=>['回复转发','消息表情','请求卡片'].includes(l.kind)).map(l=>[l.level,l.message]),[['error','助手：feishu-1 的回复未发出，飞书未连接'],['error','feishu-1：未能取消表情，飞书未连接'],['error','feishu-1：请求 #1 的卡片未发出，飞书未连接']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'state.json'),'utf8')).topics[0].reactions,[]);
  assert.deepEqual(fs.readFileSync(calls,'utf8').split('\n').filter(l=>l.includes('replies')||l.includes('requests')),['--session default agent replies w1:p1 --after 0','--session default agent requests w1:p1']);
  // The agent of the topic reaches Bridge with bridge-schedule on the socket in the state directory, which only Bridge's user can open.
  assert.equal(fs.statSync(path.join(state,'agent.sock')).mode&0o777,0o600);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_')&&!k.startsWith('BRIDGE_')));
  const cli=(...args)=>spawned(process.execPath,[path.join(path.dirname(fileURLToPath(import.meta.url)),'bin','bridge-schedule.mjs'),...args],{...env,BRIDGE_STATE:state,HERDR_PANE_ID:'w1:p1'});
  assert.deepEqual(await cli('list'),{status:0,stdout:'绑定「助手」上没有定时任务。\n',stderr:''});
  // The app is not connected, so the card cannot be posted; another pane is no topic's agent.
  assert.deepEqual(await cli('add','--cron','0 9 * * *','--mode','new','--task','x'),{status:1,stdout:'',stderr:'bridge-schedule: 确认卡片没有发出去，请稍后重试\n'});
  assert.deepEqual(await cli('list','--pane','w1:p9'),{status:1,stdout:'',stderr:'bridge-schedule: 这个 pane 里的 Agent 不属于任何进行中的飞书话题：bridge-schedule 只能由飞书话题里的 Agent 运行\n'});
  const removed=await fetch(`http://127.0.0.1:${port}/api/bindings/remove`,{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify({id:'b'})});assert.equal(removed.status,200);
  const off=()=>fs.readFileSync(calls,'utf8').split('\n').filter(l=>l.includes('remote-answers'));for(let i=0;i<100&&!off().length;i++)await later(50);
  assert.deepEqual(off(),['--session default pane remote-answers w1:p1 off']);assert.deepEqual((await api('state')).topics,[]);
  for(let i=0;i<100&&fs.existsSync(attachments);i++)await later(50);assert.equal(fs.existsSync(attachments),false);assert.ok(fs.existsSync(path.dirname(attachments)));
 }finally{server.kill();if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(dir,{recursive:true});}
});
test('the server runs without the agent socket when it cannot open it, such as in a state directory too long for a socket path, and logs why',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-')),state=path.join(dir,'s'.repeat(120));fs.mkdirSync(state);fs.writeFileSync(path.join(state,'initialized'),'1');
 const port=await new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port));});});
 const server=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:state,PORT:String(port),BIND:'127.0.0.1'},stdio:['ignore','pipe','inherit']});
 try{
  await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('listening'))resolve();});server.on('exit',()=>reject(Error('server exited')));});
  const key=fs.readFileSync(path.join(state,'access-key'),'utf8').trim(),api=async()=>(await fetch(`http://127.0.0.1:${port}/api/state`,{headers:{authorization:'Bearer '+key}})).json();
  let s;for(let i=0;i<100;i++){s=await api();if(s.logs.some(l=>l.kind==='定时任务'))break;await later(50);}
  assert.deepEqual(s.logs.filter(l=>l.kind==='定时任务').map(l=>[l.level,l.message.split('，')[0]]),[['error','Agent 的请求接口没有打开']]);assert.equal(server.exitCode,null);
 }finally{server.kill();if(server.exitCode===null&&server.signalCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(dir,{recursive:true});}
});
test('the server refuses to start with a BRIDGE_URL that is not an http(s) origin',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-server-'));try{
  const server=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:{...process.env,BRIDGE_STATE:dir,PORT:'0',BIND:'127.0.0.1',BRIDGE_URL:'http://bridge.example/admin'},stdio:['ignore','pipe','pipe']});
  let err='';server.stderr.on('data',d=>{err+=d;});const timer=setTimeout(()=>server.kill(),5000);const code=await new Promise(r=>server.once('exit',r));clearTimeout(timer);
  assert.notEqual(code,0);assert.match(err,/BRIDGE_URL/);assert.equal(fs.existsSync(path.join(dir,'access-key')),false);
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('SDK cache isolates apps and honors namespaces and absolute expiry',async()=>{const a=channelCache(),b=channelCache();await a.set('same','seen',Date.now()+60000,{namespace:'dedup'});assert.equal(await a.get('same',{namespace:'dedup'}),'seen');assert.equal(await b.get('same',{namespace:'dedup'}),undefined);assert.equal(await a.get('same',{namespace:'token'}),undefined);await a.set('expired','old',Date.now()-1);assert.equal(await a.get('expired'),undefined);});

test('static files map the two pages, the theme script and hashed assets and reject every other path',()=>{
 const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'web','dist'),html='text/html; charset=utf-8';
 assert.deepEqual(staticFile('/'),{file:path.join(dist,'index.html'),type:html,immutable:false});assert.deepEqual(staticFile('/connect'),{file:path.join(dist,'connect.html'),type:html,immutable:false});
 assert.deepEqual(staticFile('/theme.js'),{file:path.join(dist,'theme.js'),type:'text/javascript; charset=utf-8',immutable:false});
 for(const [name,type] of [['index-AbC_1.js','text/javascript; charset=utf-8'],['index-x.css','text/css; charset=utf-8'],['mark.svg','image/svg+xml'],['qr.png','image/png'],['font.woff2','font/woff2']])assert.deepEqual(staticFile('/assets/'+name),{file:path.join(dist,'assets',name),type,immutable:true});
 for(const p of ['/index.html','/connect.html','/connect/','/app.js','/style.css','/assets/','/assets/x.map','/assets/x.html','/assets/x.json','/assets/x.JS','/assets/..','/assets/.js','/assets/../server.mjs','/assets/..%2Fserver.mjs','/assets/sub/x.js','/assets/x.js/','/api/state','/health'])assert.equal(staticFile(p),null,p);
});
test('static responses: pages return 503 before the build, missing assets 404, hashed assets are immutable',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-web-')),dist=path.join(root,'dist');
 const send=async p=>{const r={};await sendStatic({writeHead(code,headers){r.code=code;r.headers=headers;},end(body){r.body=String(body??'');}},staticFile(p,dist));return r;};
 try{
  for(const p of ['/','/connect']){const r=await send(p);assert.equal(r.code,503);assert.equal(r.body,'前端尚未构建，运行 npm run build');}
  assert.equal((await send('/assets/index-a.js')).code,404);
  fs.mkdirSync(path.join(dist,'assets'),{recursive:true});fs.writeFileSync(path.join(dist,'index.html'),'<!doctype html>');fs.writeFileSync(path.join(dist,'assets','index-a.js'),'export{}');
  const page=await send('/');assert.equal(page.code,200);assert.equal(page.body,'<!doctype html>');assert.equal(page.headers['Content-Type'],'text/html; charset=utf-8');assert.equal(page.headers['Cache-Control'],'no-cache');
  const asset=await send('/assets/index-a.js');assert.equal(asset.code,200);assert.equal(asset.body,'export{}');assert.equal(asset.headers['Cache-Control'],'public, max-age=31536000, immutable');
  assert.equal((await send('/assets/index-b.js')).code,404);assert.equal((await send('/connect')).code,404);
  assert.equal((await send('/theme.js')).code,404);fs.writeFileSync(path.join(dist,'theme.js'),'(()=>{})();');
  const theme=await send('/theme.js');assert.equal(theme.code,200);assert.equal(theme.body,'(()=>{})();');assert.equal(theme.headers['Content-Type'],'text/javascript; charset=utf-8');assert.equal(theme.headers['Cache-Control'],'no-cache');
 }finally{fs.rmSync(root,{recursive:true});}
});
test('built admin pages load only files the server serves and stay within the CSP',()=>{
 const dist=path.join(path.dirname(fileURLToPath(import.meta.url)),'web','dist'),read=f=>fs.readFileSync(path.join(dist,f),'utf8'),assets=fs.readdirSync(path.join(dist,'assets'));
 for(const name of assets)assert.ok(staticFile('/assets/'+name),`dist/assets/${name} cannot be served`);
 for(const html of ['index.html','connect.html']){
  const page=read(html);assert.doesNotMatch(page,/\sstyle=|<style|<script(?![^>]*\ssrc=)|<[a-z][^>]*\son[a-z]+=/i,html+' has an inline style, script or event handler');
  const urls=[...page.matchAll(/\s(?:href|src)="([^"]*)"/g)].map(m=>m[1]).filter(u=>!u.startsWith('#')&&!u.startsWith('data:image/'));assert.ok(urls.some(u=>u.endsWith('.js'))&&urls.some(u=>u.endsWith('.css')),html+' loads no script or stylesheet');
  for(const url of urls){const asset=staticFile(url);assert.ok(asset&&fs.existsSync(asset.file),`${html} loads ${url}, which the server does not serve`);}
  // The theme script runs as a classic, blocking script ahead of the stylesheet and the app, so a stored theme is applied before first paint.
  const head=page.slice(0,page.indexOf('</head>')),theme=head.indexOf('<script src="/theme.js"></script>');
  assert.ok(theme>=0&&theme<head.search(/<link rel="stylesheet"|<script type="module"/),html+' does not run /theme.js before its stylesheet and app');
  assert.match(head,/<meta name="color-scheme" content="light dark">/,html+' does not offer both color schemes');
 }
 assert.doesNotMatch(read('theme.js'),/^\s*(?:import|export)\b/m,'theme.js must stay a classic script');
 for(const name of assets.filter(n=>n.endsWith('.css'))){const css=read('assets/'+name);assert.doesNotMatch(css,/@import/,name);for(const [,url] of css.matchAll(/url\(\s*['"]?([^'")\s]+)/g))assert.match(url,/^(?:data:image\/svg\+xml|\/assets\/)/,`${name} loads ${url}`);}
 for(const name of assets.filter(n=>n.endsWith('.js'))){const js=read('assets/'+name);for(const [,from,dynamic] of js.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)){const spec=from??dynamic,file=spec.replace(/^\.\//,'');assert.ok(/^[\w.-]+\.js$/.test(file)&&assets.includes(file),`${name} imports ${spec}`);}}
});
