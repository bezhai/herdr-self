// The commands a person sends to the bot, each as a whole message (see Topics.handle): /adopt as a root message offers the running agents to
// adopt, /release in an adopted topic lets go of its agent, and /stop in a ready topic, or as a root message, interrupts the agent's turn.
// Each has the description that Feishu's slash command panel shows. Feishu takes only names that match ^[a-z][a-z0-9_-]{0,31}$.
export const commands={adopt:'接管正在运行的 Agent',release:'结束接管',stop:'停止 Agent 当前这一轮'};
// Each command as sent, such as /adopt.
export const slash=Object.fromEntries(Object.keys(commands).map(c=>[c,'/'+c]));
const path='/open-apis/application/v7/app_slash_commands';
const describe=text=>({default_value:text,i18n:{zh_cn:text}});
// Offers the commands in the slash command panel of the app through request(options), which calls an OpenAPI and resolves to its data (see
// openApi in platform.mjs): a missing command is created and one with another description updated. Never deletes: the app may hold
// commands of its own. Resolves to the names created or updated; rejects with the first failure.
export async function registerCommands(request){
 const {items=[]}=await request({method:'GET',url:path})||{},changed=[];
 for(const [command,text] of Object.entries(commands)){
  const x=items.find(y=>y.command===command),description=describe(text);
  if(!x)await request({method:'POST',url:path,data:{command,description}});
  else if(x.description?.default_value!==text||x.description?.i18n?.zh_cn!==text)await request({method:'PATCH',url:`${path}/${encodeURIComponent(x.command_id)}`,data:{command,description}});
  else continue;
  changed.push(command);
 }
 return changed;
}
