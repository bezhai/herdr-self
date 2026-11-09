// The PreToolUse hook that limits the Bash tool of a Claude to some commands (see allowedCommands of an agent configuration and launch.ts,
// which installs this file on the machine and puts it in the settings of the agent). Claude runs it as `node command-guard.ts <command>...`
// with the event as JSON on stdin; it answers on stdout that the tool call is allowed or denied, which holds in every permission mode and
// never asks anyone. A command is allowed when it is exactly one of the allowed commands, with or without arguments that have no character
// that a shell would read as more than a word: no ; & | ` $ < > ( ) \ and no line break, so that nothing can be chained, substituted
// or redirected. It is a single file that imports nothing, since launch.ts copies it alone.

const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Why command may not run, or null when it may. The separator is a space or a tab, not \s, which would also take the line break that
// ends a command.
export function denial(command:unknown,allowed:string[]){
 if(typeof command!=='string')return '只允许执行 '+allowed.join('、')+'：这条命令不是文本';
 const shape=allowed.length?new RegExp(`^(?:${allowed.map(escape).join('|')})(?:[ \\t]+[^;&|\`$<>()\\\\\\r\\n]*)?$`):null;
 return shape?.test(command)?null:'只允许执行 '+allowed.join('、')+'，并且命令里不能有 ; & | ` $ < > ( ) \\ 和换行：'+command.slice(0,200);
}
async function main(allowed:string[]){
 let text='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin)text+=chunk;
 let event;try{event=JSON.parse(text);}catch{console.error('hook 收到的事件不是 JSON');process.exit(2);}
 // The matcher of the settings only sends Bash here; any other tool goes on as if there were no hook.
 if(event?.tool_name!=='Bash')return;
 const reason=denial(event.tool_input?.command,allowed);
 console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:reason?'deny':'allow',permissionDecisionReason:reason??'在允许的命令内'}}));
}
if(import.meta.main)await main(process.argv.slice(2));
