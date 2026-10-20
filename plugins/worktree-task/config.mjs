import fs from 'node:fs';import path from 'node:path';
import {herdr} from './herdr.mjs';
// The id in herdr-plugin.toml. The task script needs it outside plugin commands too, to find the plugin's config directory.
export const PLUGIN_ID='bezhai.worktree-task';
export const defaults={bypassPermissions:true,namingTimeoutMs:30000,agentStartTimeoutMs:60000,readyTimeoutMs:300000};
const positive=v=>Number.isInteger(v)&&v>0;
// What each key accepts. Herdr's agent start takes a timeout above its 3 s settle delay and up to 300 s.
const rules={bypassPermissions:[v=>typeof v==='boolean','true 或 false'],namingTimeoutMs:[positive,'正整数（毫秒）'],
 agentStartTimeoutMs:[v=>positive(v)&&v>3000&&v<=300000,'3000 到 300000 之间的整数（毫秒，不含 3000）'],readyTimeoutMs:[positive,'正整数（毫秒）']};
// The config directory: Herdr gives plugin commands HERDR_PLUGIN_CONFIG_DIR, and tells a shell where it is.
export const configDir=async()=>process.env.HERDR_PLUGIN_CONFIG_DIR||herdr(['plugin','config-dir',PLUGIN_ID],{text:true,timeoutMs:15000});
// Reads config.json of dir over the defaults; a missing file means the defaults. An unknown key or a wrong value is an error, so that a
// typo does not silently keep a default.
export function loadConfig(dir){
 const file=path.join(dir,'config.json');if(!fs.existsSync(file))return {...defaults};
 let c;try{c=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){throw Error(`${file} 不是有效的 JSON：${e.message}`);}
 if(!c||typeof c!=='object'||Array.isArray(c))throw Error(`${file} 应该是一个 JSON 对象`);
 for(const [k,v] of Object.entries(c)){
  if(!rules[k])throw Error(`${file} 里有未知的配置项 ${k}，可用的是 ${Object.keys(rules).join('、')}`);
  if(!rules[k][0](v))throw Error(`${file} 里 ${k} 应该是${rules[k][1]}`);
 }
 return {...defaults,...c};
}
