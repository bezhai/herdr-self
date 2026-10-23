// butler's config: one env-style file of its own. It holds open-lark's read-only token, never open-lark's app.env,
// which also holds the full-power token and the database URL, and the credentials of butler's own Feishu app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readSchedule} from './schedule.mjs';

export const defaultConfigPath=()=>path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'butler','butler.env');
const home=p=>p.replace(/^~(?=\/|$)/,os.homedir());

export function parseEnv(text){
 const out={};
 for(const line of text.split('\n')){
  const m=/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);if(!m)continue;
  out[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');
 }
 return out;
}
function httpUrl(value,key){
 let url;try{url=new URL(value);}catch{throw Error(`${key} 不是有效地址：${value}`);}
 if(!/^https?:$/.test(url.protocol))throw Error(`${key} 必须是 http(s) 地址：${value}`);
 return value.replace(/\/$/,'');
}

// The bot's app (see bot-app.mjs), when one is configured: all three keys, or none.
const BOT_KEYS=['BUTLER_BOT_APP_ID','BUTLER_BOT_APP_SECRET','BUTLER_BOT_OWNER'];
function bot(v,file){
 if(!BOT_KEYS.some(k=>v[k]))return undefined;
 const missing=BOT_KEYS.filter(k=>!v[k]);if(missing.length)throw Error(`配置文件 ${file} 里机器人的配置不全，缺少 ${missing.join('、')}（butler bot create 会写好它们）`);
 const domain=v.BUTLER_BOT_DOMAIN||'feishu';if(!['feishu','lark'].includes(domain))throw Error(`BUTLER_BOT_DOMAIN 只能是 feishu 或 lark：${domain}`);
 return {appId:v.BUTLER_BOT_APP_ID,appSecret:v.BUTLER_BOT_APP_SECRET,owner:v.BUTLER_BOT_OWNER,domain};
}

export function loadConfig(file=process.env.BUTLER_CONFIG||defaultConfigPath()){
 let stat;
 try{stat=fs.statSync(file);}catch(e){if(e.code==='ENOENT')throw Error(`配置文件不存在：${file}（格式见 butler/README.md）`);throw e;}
 if(stat.mode&0o077)throw Error(`配置文件 ${file} 里有 open-lark 的只读 token 和机器人的密钥，权限必须是 600（现在是 ${(stat.mode&0o777).toString(8)}）：chmod 600 ${file}`);
 const v=parseEnv(fs.readFileSync(file,'utf8'));
 return {file,token:v.BUTLER_OPEN_LARK_TOKEN||undefined,bot:bot(v,file),
  schedule:readSchedule({days:v.BUTLER_DIGEST_DAYS||undefined,hours:v.BUTLER_DIGEST_HOURS||undefined,every:v.BUTLER_DIGEST_EVERY||undefined,
   offHoursNew:v.BUTLER_DIGEST_OFF_HOURS_NEW||undefined,offHoursGap:v.BUTLER_DIGEST_OFF_HOURS_GAP||undefined}),
  openLarkUrl:httpUrl(v.BUTLER_OPEN_LARK_URL||'http://127.0.0.1:8081','BUTLER_OPEN_LARK_URL'),
  linkBase:httpUrl(v.BUTLER_LINK_BASE||'http://127.0.0.1:3333','BUTLER_LINK_BASE'),
  dataDir:path.resolve(home(v.BUTLER_DATA_DIR||path.join(process.env.XDG_DATA_HOME||'~/.local/share','butler'))),
  // The processor's model: a saved herdr machine (its label), a directory there, and the local herdr executable.
  modelMachine:v.BUTLER_MODEL_MACHINE||undefined,modelCwd:v.BUTLER_MODEL_CWD||undefined,herdr:home(v.BUTLER_HERDR||'herdr')};
}
export function requireToken(config){
 if(!config.token)throw Error(`配置文件 ${config.file} 没有 BUTLER_OPEN_LARK_TOKEN（open-lark 的只读 token）`);
 return config.token;
}
export function requireModel(config){
 if(!config.modelMachine)throw Error(`配置文件 ${config.file} 没有 BUTLER_MODEL_MACHINE（herdr 里保存的模型机器的名称，见 butler/README.md）`);
 return config.modelMachine;
}
export const storeFile=config=>path.join(config.dataDir,'butler.db');
// Sets keys in the config file: a key already there is replaced where it is, a new one is added at the end, every
// other line stays. The file is replaced as a whole and is mode 600 from the start.
export function saveConfig(file,values){
 const lines=fs.readFileSync(file,'utf8').replace(/\n$/,'').split('\n'),done=new Set(),out=[];
 for(const line of lines){
  const key=/^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
  if(key===undefined||!Object.hasOwn(values,key)){out.push(line);continue;}
  if(!done.has(key)){out.push(`${key}=${values[key]}`);done.add(key);}
 }
 for(const [key,value] of Object.entries(values))if(!done.has(key))out.push(`${key}=${value}`);
 const tmp=path.join(path.dirname(file),`.${path.basename(file)}.${process.pid}.tmp`);
 fs.writeFileSync(tmp,`${out.join('\n')}\n`,{mode:0o600,flag:'wx'});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,file);
}
