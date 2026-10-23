// butler's config: one env-style file of its own. It holds only open-lark's read-only token, never open-lark's app.env,
// which also holds the full-power token and the database URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export function loadConfig(file=process.env.BUTLER_CONFIG||defaultConfigPath()){
 let stat;
 try{stat=fs.statSync(file);}catch(e){if(e.code==='ENOENT')throw Error(`配置文件不存在：${file}（格式见 butler/README.md）`);throw e;}
 if(stat.mode&0o077)throw Error(`配置文件 ${file} 里有 open-lark 的只读 token，权限必须是 600（现在是 ${(stat.mode&0o777).toString(8)}）：chmod 600 ${file}`);
 const v=parseEnv(fs.readFileSync(file,'utf8'));
 return {file,token:v.BUTLER_OPEN_LARK_TOKEN||undefined,
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
