import {run} from './herdr.mjs';
// Runs git in directory cwd for the repository functions of worktree-branch.mjs, which the plugin shares with Bridge: never prompts for
// credentials on the terminal, which a fetch of the task could otherwise do.
export const git=(cwd,args,options={})=>run('git',['-C',cwd,...args],{...options,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
