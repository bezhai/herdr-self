import type {OpenApi} from './platform.ts';
// The commands a person sends to the bot (see Topics.handle): /adopt as a root message offers the running agents to adopt, /release in an
// adopted topic lets go of its agent, and /stop in a ready topic, or as a root message, interrupts the agent's turn; each of these is a
// whole message. Each has the description that Feishu's slash command panel shows. Feishu takes only names that match ^[a-z][a-z0-9_-]{0,31}$.
export const commands={adopt:'接管正在运行的 Agent',release:'结束接管',stop:'停止 Agent 当前这一轮'};
// The commands that earlier versions offered and Bridge no longer has, with the description it gave each. The panel is shared with the app's
// own commands, so only a command with this name and this description counts as Bridge's to delete; the same name with another description
// is the app's own.
const retired={wt:'在新的 Git worktree 里开一个话题'};
// Each command as sent, such as /adopt.
export const slash=Object.fromEntries(Object.keys(commands).map(c=>[c,'/'+c])) as Record<keyof typeof commands,string>;
const path='/open-apis/application/v7/app_slash_commands';
const describe=(text:string)=>({default_value:text,i18n:{zh_cn:text}});
type Listed={command:string,command_id:string,description?:{default_value?:string,i18n?:{zh_cn?:string}}};
const described=(x:Listed,text:string)=>x.description?.default_value===text&&x.description?.i18n?.zh_cn===text;
// Offers the commands in the slash command panel of the app through request(options), which calls an OpenAPI and resolves to its data (see
// openApi in platform.ts): a missing command is created and one with another description updated, and a retired command that is listed
// with the description Bridge gave it is deleted. Every other command of the app stays. Resolves to the names registered (created or
// updated) and removed; rejects with the first failure.
export async function registerCommands(request:OpenApi){
 const {items=[]}:{items?:Listed[]}=await request({method:'GET',url:path})||{},registered:string[]=[],removed:string[]=[];
 for(const [command,text] of Object.entries(commands)){
  const x=items.find(y=>y.command===command),description=describe(text);
  if(!x)await request({method:'POST',url:path,data:{command,description}});
  else if(!described(x,text))await request({method:'PATCH',url:`${path}/${encodeURIComponent(x.command_id)}`,data:{command,description}});
  else continue;
  registered.push(command);
 }
 for(const [command,text] of Object.entries(retired)){
  const x=items.find(y=>y.command===command);
  if(!x||!described(x,text))continue;
  await request({method:'DELETE',url:`${path}/${encodeURIComponent(x.command_id)}`});removed.push(command);
 }
 return {registered,removed};
}
