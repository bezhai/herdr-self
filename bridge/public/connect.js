const get=id=>document.getElementById(id);
async function call(path,body){const r=await fetch('/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(r.status===401){location.replace('/');throw Error('请先登录');}if(!r.ok)throw Error('暂时无法打开飞书');return r.json();}
async function begin(){get('connect-loader').classList.remove('hidden');get('connect-retry').classList.add('hidden');get('connect-home').classList.add('hidden');get('connect-heading').textContent='正在打开飞书';get('connect-note').textContent='请稍候';
 try{let registration=await call('/apps/registration/start',{});const id=registration.id;
  for(let i=0;i<40;i++){
   if(registration.url&&registration.status==='pending'){const url=new URL(registration.url);if(url.protocol!=='https:'||!['open.feishu.cn','open.larkoffice.com','open.larksuite.com'].includes(url.hostname))throw Error('创建链接不可用');location.replace(url.href);return;}
   if(registration.id!==id||!['starting','pending'].includes(registration.status))throw Error('请返回管理台重试');
   await new Promise(r=>setTimeout(r,1000));registration=(await call('/state')).registration||{};
  }throw Error('连接超时，请重试');
 }catch(e){get('connect-loader').classList.add('hidden');get('connect-heading').textContent='未能打开飞书';get('connect-note').textContent=e.message;get('connect-retry').classList.remove('hidden');get('connect-home').classList.remove('hidden');}
}
get('connect-retry').onclick=begin;begin();
