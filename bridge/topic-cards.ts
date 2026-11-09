import {plain,clip,option} from './request-cards.ts';
import type {ButtonValue} from './request-cards.ts';
// The first card of a topic (see Topics.showCard): what the topic works with, and a dropdown each to start it again with another project or
// another agent configuration (see Topics.restart). It has no header, like the other status cards of Bridge.
export type Choice={id:string,name:string};
// project is the name of the project, or null for a topic that found none; branch is there only where the project's worktrees have one;
// projects and configs are the choices of the dropdowns, which leave out what the topic has.
export type StartView={project:string|null,branch?:string,config:string,projects:Choice[],configs:Choice[]};
const summaryLength=100;
const none='没有找到对应的项目，在一个空目录里开始。';
// A dropdown that calls back with the field it changes. Every drawing needs its own render number (see pending in request-cards.ts): the
// channel drops a click that repeats the card, person and value of an earlier one, and a person may go back to a project they left.
const menu=(field:NonNullable<ButtonValue['restart']>,placeholder:string,choices:Choice[],render:number)=>!choices.length?[]:[{tag:'select_static',width:'fill',
 placeholder:{tag:'plain_text',content:placeholder},options:choices.map(c=>option(c.name,c.id)),behaviors:[{type:'callback',value:{restart:field,render}}]}];
export function startCard(v:StartView,render:number){
 const text=v.project==null?`${none}\n${v.config}`:[v.project,...v.branch?['分支 '+v.branch]:[],v.config].join(' · ');
 return {schema:'2.0',config:{update_multi:true,summary:{content:clip(text.replace(/\s+/g,' '),summaryLength)}},
  body:{elements:[plain(text),...menu('project','换项目',v.projects,render),...menu('agentConfig','换 Agent 配置',v.configs,render)]}};
}
