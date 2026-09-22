const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={machines:[],apps:[],bindings:[],logs:[],deliveries:[]},page='platforms',busy=false,last='',inspect=null,timer,inspectHash='',registrationOpening=false,registrationPreviousId=null,registrationScanning=false;
const names={connected:'已连接',disabled:'已停用',idle:'未连接',error:'连接失败',failed:'连接失败',connecting:'连接中',reconnecting:'重连中',ready:'就绪',working:'执行中',blocked:'等待审批',offline:'未接入'};
const time=t=>new Date(t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function toast(t){$('toast').textContent=t;$('toast').classList.remove('hidden');clearTimeout(timer);timer=setTimeout(()=>$('toast').classList.add('hidden'),6500);}
async function api(p,b){const r=await fetch('/api'+p,{method:b===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(b!==undefined?{body:JSON.stringify(b)}:{})});const d=await r.json();if(r.status===401){document.querySelectorAll('dialog[open]').forEach(d=>d.close());inspect=null;$('login').classList.remove('hidden');$('app').classList.add('hidden');}if(!r.ok)throw Error(d.error||'请求失败');return d;}
const badge=(s,label)=>`<span class="badge ${['error','failed'].includes(s)?'error':['connected','ready'].includes(s)?'':'neutral'}">${esc(label||names[s]||s)}</span>`;
function button(action,id,label,type='secondary'){return `<button class="${type}" data-action="${action}" data-id="${id}">${label}</button>`;}
function empty(title,detail,action,label){return `<div class="empty-state"><span class="empty-icon">⇄</span><h3>${title}</h3><p>${detail}</p>${action?button(action,'',label,'primary'):''}</div>`;}
async function refresh(){if(busy)return;busy=true;try{state=await api('/state');$('app').classList.remove('hidden');$('login').classList.add('hidden');$('connection').textContent='Bridge 在线';$('online-dot').classList.remove('bad');render();if(inspect&&$('inspect-dialog').open)await inspectRefresh();}catch(e){$('connection').textContent='连接中断';$('online-dot').classList.add('bad');}finally{busy=false;}}
function render(){const signature=JSON.stringify({...state,machines:state.machines.map(({checkedAt,...m})=>m)});renderRegistration();if(signature===last)return;last=signature;
 $('bridge-host').textContent=state.host;
 $('platform-count').textContent=state.apps.length;$('machine-count').textContent=state.machines.length;$('binding-count').textContent=state.bindings.length;
 $('metric-machines').innerHTML=state.machines.filter(m=>m.enabled&&m.state==='connected').length+` <small>/ ${state.machines.length}</small>`;$('metric-platforms').innerHTML=state.apps.filter(a=>a.connection==='connected').length+` <small>/ ${state.apps.length}</small>`;$('metric-bindings').textContent=state.bindings.length;$('metric-agents').textContent=state.machines.reduce((n,m)=>n+(m.adapters?.length||0),0);
 $('platforms').innerHTML=state.apps.length?state.apps.map(a=>`<article class="card"><div class="card-head"><span class="card-icon">◈</span><div class="card-title"><strong>${esc(a.name)}</strong><p>${esc(a.appId)} · ${a.domain==='bytedance'?'字节内部':a.domain==='lark'?'Lark 国际版':'飞书开放平台'}</p></div>${badge(a.connection)}<div class="card-actions">${button('test-app',a.id,'验证凭证')}${button('toggle-app',a.id,a.enabled?'停用':'启用连接')}${!a.enabled?button('edit-app',a.id,'配置','text-button'):''}${!a.enabled?button('remove-app',a.id,'移除','text-button danger'):''}</div></div><div class="card-detail"><span>${a.verifiedAt?'凭证已验证'+(a.botName?' · '+esc(a.botName):''):'尚未验证凭证'}</span><span>${a.allowedUsers.length} 位授权用户 · ${state.bindings.filter(b=>b.appId===a.id).length} 个绑定</span></div>${a.error?`<div class="card-error">${esc(a.error)}</div>`:''}</article>`).join(''):empty('连接飞书','在飞书中创建或选择应用','add-app','添加飞书');
 $('machines').innerHTML=state.machines.map(m=>`<article class="card"><div class="card-head"><span class="card-icon">${m.type==='ssh'?'↗':'▤'}</span><div class="card-title"><strong>${esc(m.name)}</strong><p>${m.type==='ssh'?esc(m.host)+':'+m.port:'本机'} / ${esc(m.session)}</p></div>${badge(m.enabled?m.state||'connecting':'disabled')}<div class="card-actions">${button(m.enabled?'disconnect':'connect',m.id,m.enabled?'断开':'连接')}${button('refresh',m.id,'刷新')}${!m.enabled?button('edit-machine',m.id,'编辑','text-button'):''}${!m.enabled?button('remove-machine',m.id,'移除','text-button danger'):''}</div></div><div class="card-detail"><span>${m.panes?.length||0} 个终端 · ${m.agents?.length||0} 个 Agent · ${m.adapters?.length||0} 个已接入</span>${button('install',m.id,m.adapterInstalled?'更新 Claude 适配器':'安装 Claude 适配器','text-button')}</div>${m.error&&m.enabled?`<div class="card-error">${esc(m.error)}</div>`:''}${(m.agents||[]).map(a=>{const adapter=m.adapters?.find(x=>x.paneId===a.pane_id);return `<div class="agent-row"><span><strong>${esc(a.name||a.agent||'Agent')}</strong><small>${esc(a.pane_id)} · ${esc(a.cwd||'')}</small></span>${badge(adapter?'ready':'offline',adapter?'已接入': '需启动适配器')}${adapter?`<button class="text-button" data-action="inspect" data-id="${m.id}" data-adapter="${adapter.id}">查看连接 ↗</button>`:''}</div>`;}).join('')}</article>`).join('')||empty('接入第一台机器','支持 Bridge 本机与 SSH 连接。','add-machine','＋ 添加机器');
 $('bindings').innerHTML=state.bindings.map(b=>{const m=state.machines.find(m=>m.id===b.machineId),a=state.apps.find(a=>a.id===b.appId),adapter=m?.adapters?.find(x=>x.id===b.adapterId&&x.nativeId===b.nativeId);return `<tr><td><strong>${esc(b.name)}</strong><small>${esc(a?.name)}<br>${esc(b.chatId)}${b.rootId?'<br>话题 '+esc(b.rootId):''}</small></td><td>${esc(m?.name)}<small>${esc(b.paneId)} · ${esc(b.nativeId.slice(0,8))}</small></td><td>${b.requireMention?'@机器人':'全部消息'}</td><td>${b.replyInThread?'话题回复':'直接回复'}</td><td>${badge(adapter&&a?.connection==='connected'?'connected':'offline',adapter?(a?.connection==='connected'?'可用':'等待平台连接'):'等待原生会话')}</td><td>${button('remove-binding',b.id,'解除','text-button danger')}</td></tr>`;}).join('')||'<tr><td colspan="6" class="table-empty">暂无会话绑定</td></tr>';
 $('logs').innerHTML=state.logs.slice().reverse().map(l=>`<div class="log ${l.level}"><time>${time(l.at)}</time><b>${esc(l.kind)}</b><span>${esc(l.message)}</span></div>`).join('')||'<p class="fine">暂无事件。</p>';
 const deliveryNames={queued:'排队中',running:'执行中',completed:'已回复',delivery_unknown:'投递待核查',no_reply:'需要关注',dispatching:'投递中'};
 $('deliveries').innerHTML=state.deliveries.slice().reverse().map(d=>`<div class="log"><time>${time(d.createdAt)}</time><b>${deliveryNames[d.status]||d.status}</b><span>${esc(d.messageId)}${d.lastError?' · '+esc(d.lastError):''}</span></div>`).join('')||'<p class="fine">尚未接收平台消息。</p>';
}
const pageInfo={platforms:['平台连接','','平台连接','','＋ 添加飞书'],machines:['机器连接','','机器连接','','＋ 添加机器'],bindings:['会话绑定','','会话绑定','','＋ 新建绑定'],logs:['连接日志','','连接日志','','']};
function navigate(next){page=next;const n=pageInfo[page];$('crumb').textContent=n[0];$('eyebrow').textContent=n[1];$('title').textContent=n[2];$('description').textContent=n[3];$('add').textContent=n[4];$('add').classList.toggle('hidden',!n[4]);document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));document.querySelectorAll('.page').forEach(p=>p.classList.toggle('hidden',p.id!=='page-'+page));document.querySelector('.sidebar').classList.remove('open');}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>navigate(b.dataset.page));$('menu').onclick=()=>document.querySelector('.sidebar').classList.toggle('open');
$('add').onclick=()=>page==='platforms'?openRegistration():page==='machines'?openMachine():openBinding();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{$(b.dataset.close).close();if(b.dataset.close==='inspect-dialog')inspect=null;});
$('login-form').onsubmit=async e=>{e.preventDefault();try{await api('/login',{key:$('key').value});$('key').value='';$('login-error').textContent='';await refresh();}catch(e){$('login-error').textContent=e.message;}};$('logout').onclick=async()=>{await api('/logout',{});location.reload();};
function openMachine(m){$('machine-form').reset();$('machine-id').value=m?.id||'';$('machine-name').value=m?.name||'';$('machine-type').value=m?.type||'ssh';$('machine-host').value=m?.host||'';$('machine-session').value=m?.session||'default';$('machine-port').value=m?.port||22;$('machine-binary').value=m?.binary||'~/.local/bin/herdr';$('machine-error').textContent='';$('machine-dialog').showModal();}
function openApp(a){$('platform-form').reset();$('app-id-hidden').value=a?.id||'';$('app-name').value=a?.name||'';$('app-id').value=a?.appId||'';$('app-domain').value=a?.domain||'feishu';$('app-users').value=a?.allowedUsers.join('\n')||'';$('platform-error').textContent='';$('platform-dialog').showModal();}
function openBinding(){$('binding-form').reset();$('binding-app').innerHTML=state.apps.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('');$('binding-machine').innerHTML=state.machines.filter(m=>m.enabled&&m.state==='connected').map(m=>`<option value="${m.id}">${esc(m.name)} / ${esc(m.session)}</option>`).join('');bindingAgents();$('binding-error').textContent='';$('binding-dialog').showModal();}
function bindingAgents(){const m=state.machines.find(m=>m.id===$('binding-machine').value);$('binding-agent').innerHTML=(m?.adapters||[]).map(a=>`<option value="${a.id}">${esc(a.paneId)} · ${esc(a.nativeId?.slice(0,8)||'启动中')}</option>`).join('');$('binding-help').textContent=m?.adapters?.length?'绑定固定的原生会话身份；会话变化后需要重新绑定。':'暂无已接入会话。先在机器连接页安装适配器，再在 Herdr pane 中运行启动命令。';}
$('binding-machine').onchange=bindingAgents;
async function submit(form,err,path,body,dialog){const button=form.querySelector('button.primary');button.disabled=true;try{await api(path,body);$(dialog).close();await refresh();}catch(e){$(err).textContent=e.message;}finally{button.disabled=false;}}
$('machine-form').onsubmit=e=>{e.preventDefault();submit(e.target,'machine-error','/machines/save',{id:$('machine-id').value||undefined,name:$('machine-name').value,type:$('machine-type').value,host:$('machine-host').value,session:$('machine-session').value,port:$('machine-port').value,binary:$('machine-binary').value,enabled:true},'machine-dialog');};
$('platform-form').onsubmit=e=>{e.preventDefault();submit(e.target,'platform-error','/apps/save',{id:$('app-id-hidden').value||undefined,name:$('app-name').value,appId:$('app-id').value,appSecret:$('app-secret').value,domain:$('app-domain').value,allowedUsers:$('app-users').value.split(/[\s,]+/).filter(Boolean)},'platform-dialog').then(()=>{$('app-secret').value='';});};
$('binding-form').onsubmit=e=>{e.preventDefault();submit(e.target,'binding-error','/bindings/save',{name:$('binding-name').value,appId:$('binding-app').value,machineId:$('binding-machine').value,adapterId:$('binding-agent').value,chatId:$('binding-chat').value,rootId:$('binding-root').value,requireMention:$('binding-mention').checked,replyInThread:$('binding-thread').checked},'binding-dialog');};
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;const {action,id}=b.dataset;let m=state.machines.find(x=>x.id===id),a=state.apps.find(x=>x.id===id);
 if(action==='add-app')return openRegistration();if(action==='add-machine')return openMachine();if(action==='edit-machine')return openMachine(m);if(action==='edit-app')return openApp(a);
 if(action==='inspect'){inspect={machineId:id,adapterId:b.dataset.adapter};inspectHash='';$('inspect-dialog').showModal();await inspectRefresh();return;}
 b.disabled=true;try{if(action==='connect'||action==='refresh'){const r=await api('/machines/connect',{id});toast(r.state==='connected'?'机器已连接':'连接未成功，查看错误信息');}
 else if(action==='disconnect')await api('/machines/disconnect',{id});
 else if(action==='install'){await api('/machines/install',{id});toast('已安装。请在对应 Herdr pane 中运行 ~/.local/bin/herdr-bridge-claude');}
 else if(action==='remove-machine')await api('/machines/remove',{id});
 else if(action==='test-app'){await api('/apps/test',{id});toast('应用凭证验证通过');}
 else if(action==='toggle-app'){await api('/apps/toggle',{id,enabled:!a.enabled});toast(a.enabled?'应用已停用':'正在建立长连接');}
 else if(action==='remove-app')await api('/apps/remove',{id});
 else if(action==='remove-binding')await api('/bindings/remove',{id});
 await refresh();}catch(e){toast(e.message);}finally{b.disabled=false;}});
async function inspectRefresh(){if(!inspect)return;try{const s=await api('/adapters/inspect',inspect);const hash=JSON.stringify(s);if(hash===inspectHash)return;inspectHash=hash;inspect.target={...inspect,nativeId:s.nativeId,paneId:s.paneId};$('inspect-title').textContent='Claude · '+s.paneId;$('inspect-meta').textContent=(names[s.status]||s.status)+' · '+s.nativeId;$('inspect-events').innerHTML=s.events.filter(e=>['user','reply'].includes(e.kind)).slice(-15).map(e=>`<div class="inspect-message"><strong>${e.kind==='user'?'YOU':'CLAUDE'} · ${time(e.at)}</strong>${esc(e.data.text)}</div>`).join('')||'<p class="fine">该会话尚无 Bridge 消息。可发送一条消息验证连通性。</p>';$('inspect-form').querySelector('button').disabled=s.status!=='ready';$('inspect-approvals').innerHTML=s.permissions.map(p=>`<div class="approval"><strong>${esc(p.tool_name)} · ${esc(p.request_id)}</strong><pre>${esc(p.input_preview)}</pre>${p.status==='pending'?`<button class="secondary" data-request="${esc(p.request_id)}" data-verdict="deny">拒绝</button><button class="secondary" data-request="${esc(p.request_id)}" data-verdict="allow">允许这一次</button>`:'已提交，等待 Claude 处理'}</div>`).join('');$('inspect-approvals').querySelectorAll('[data-request]').forEach(b=>b.onclick=async()=>{$('inspect-approvals').querySelectorAll('button').forEach(x=>x.disabled=true);try{await api('/adapters/permission',{target:inspect.target,requestId:b.dataset.request,behavior:b.dataset.verdict});await inspectRefresh();}catch(e){toast(e.message);}});}catch(e){$('inspect-meta').textContent=e.message;}}
$('inspect-form').onsubmit=async e=>{e.preventDefault();try{await api('/adapters/message',{target:inspect.target,id:'web-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),text:$('inspect-text').value});$('inspect-text').value='';await inspectRefresh();}catch(e){toast(e.message);}};
refresh();setInterval(refresh,4000);


function openRegistration(){
 registrationOpening=true;registrationPreviousId=state.registration?.id;registrationScanning=false;
 $('registration-dialog').showModal();renderRegistration();
 const popup=window.open('/connect','_blank');if(!popup)location.assign('/connect');
}
function renderRegistration(){
 let r=state.registration;
 if(registrationOpening){
  if(r&&(r.id!==registrationPreviousId||['starting','pending','connecting'].includes(r.status)))registrationOpening=false;
  else r=null;
 }
 const status=r?.status||'starting',a=state.apps.find(a=>a.id===r?.appId),connected=a?.connection==='connected';
 const completed=connected||status==='completed',problem=['error','expired','denied','cancelled'].includes(status),setup=['connection_error','needs_owner'].includes(status)&&!connected;
 $('registration-title').textContent=completed?'飞书已连接':'在飞书中添加应用';
 $('registration-subtitle').textContent=completed?(a?.botName||a?.name||''): '新建或选择已有应用';
 $('registration-spinner').classList.toggle('hidden',completed||problem||setup||registrationScanning&&!!r?.qr);
 $('registration-result').classList.toggle('hidden',!completed&&!problem&&!setup);
 $('registration-result').textContent=completed?'✓':'!';$('registration-result').classList.toggle('success',completed);
 $('registration-qr-wrap').classList.toggle('hidden',!registrationScanning||!r?.qr||status!=='pending');
 if(registrationScanning&&r?.qr&&$('registration-qr').getAttribute('src')!==r.qr)$('registration-qr').src=r.qr;
 if(status!=='pending')$('registration-qr').removeAttribute('src');
 const messages={starting:'正在打开飞书…',pending:'等待飞书确认',connecting:'正在连接…',completed:'已准备就绪',expired:'二维码已过期',denied:'未完成授权',cancelled:'请重新添加',error:'暂时无法连接飞书',connection_error:'应用已添加，连接未成功',needs_owner:'请设置可操作用户'};
 $('registration-message').textContent=completed?'已准备就绪':messages[status]||'正在连接…';
 $('registration-link').classList.toggle('hidden',status!=='pending'||!r?.url);if(r?.url)$('registration-link').href=r.url;else $('registration-link').removeAttribute('href');
 $('registration-scan').classList.toggle('hidden',status!=='pending'||!r?.qr);$('registration-scan').textContent=registrationScanning?'收起二维码':'手机扫码';
 $('registration-retry').classList.toggle('hidden',!problem);$('registration-done').classList.toggle('hidden',!completed);$('registration-configure').classList.toggle('hidden',!setup);
 $('registration-manual').classList.toggle('hidden',completed);
}
$('registration-retry').onclick=openRegistration;
$('registration-done').onclick=()=>{$('registration-dialog').close();navigate('platforms');};
$('registration-configure').onclick=()=>{$('registration-dialog').close();const a=state.apps.find(a=>a.id===state.registration?.appId);if(a&&!a.enabled)openApp(a);else navigate('platforms');};
$('registration-scan').onclick=()=>{registrationScanning=!registrationScanning;renderRegistration();};
$('registration-manual').onclick=()=>{$('registration-dialog').close();openApp();};
setInterval(()=>{if($('registration-dialog').open)refresh();},1200);
