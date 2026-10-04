import crypto from 'node:crypto';
// Feishu cards (JSON 2.0) for the requests an agent waits on, and the answers read back from their clicks (see Topics.click).
// Herdr's request shape is read only here: {id, kind:'permission'|'question', tool_name, description?, input_preview,
// decisions?:['allow'|'allow_always'|'deny'], questions?:[{question, header?, options?:[{label, description?}], multi_select?}]}.
// Herdr leaves out empty lists and false flags. Text from the agent is shown as plain text, never as markdown.
const decisions={allow:{label:'允许',type:'primary',done:'已允许',template:'green'},allow_always:{label:'总是允许',type:'default',done:'已总是允许',template:'green'},deny:{label:'拒绝',type:'danger',done:'已拒绝',template:'red'}};
const refused='用户在飞书中拒绝了这次操作';
export const title=r=>r.kind==='question'?'Agent 提问':'权限确认 · '+r.tool_name;
// What a card shows. Herdr counts request ids from 1 again after a restart, so an id alone can name another request.
export const check=r=>crypto.createHash('sha256').update(JSON.stringify([r.kind,r.tool_name,r.description,r.input_preview,r.decisions,r.questions])).digest('hex').slice(0,16);
// Building blocks shared with the adoption cards (see adoption.mjs).
export const plain=content=>({tag:'div',text:{tag:'plain_text',content}});
export const card=(heading,template,elements)=>({schema:'2.0',config:{update_multi:true},header:{title:{tag:'plain_text',content:heading},template},body:{elements}});
// open_id comes from the app's allowlist, which only holds ou_ ids.
export const by=(text,openId)=>({tag:'markdown',content:`${text} · <at id=${openId}></at>`});
const describe=r=>[...r.description?[plain(r.description)]:[],plain(r.input_preview)];
// What a submitted form holds for question i: the 其他 text, which takes precedence, and the indexes of the chosen options.
function choice(form,i){
 const other=typeof form?.['other'+i]==='string'?form['other'+i].trim():'';
 return {other,picked:[form?.['q'+i]??[]].flat().filter(x=>typeof x==='string'&&/^\d+$/.test(x)).map(Number)};
}
// Whether a form answers all n questions. Checked when the click arrives, before the request is read from Herdr.
export const answered=(n,form)=>Array.from({length:Number(n)||0},(_,i)=>choice(form,i)).every(c=>c.other||c.picked.length);
// A question without options has only the 其他 input.
function question(q,i,form){
 const c=choice(form,i),list=q.options||[],options=list.map((o,j)=>({text:{tag:'plain_text',content:o.label},value:String(j)}));
 const text=[(q.header?q.header+'：':'')+q.question,...list.filter(o=>o.description).map(o=>`· ${o.label}：${o.description}`)].join('\n');
 const select=!list.length?[]:q.multi_select?[{tag:'multi_select_static',name:'q'+i,width:'fill',placeholder:{tag:'plain_text',content:'选择一项或多项'},options,...c.picked.length?{selected_values:c.picked.map(String)}:{}}]
  :[{tag:'select_static',name:'q'+i,width:'fill',placeholder:{tag:'plain_text',content:'选择一项'},options,...c.picked.length?{initial_option:String(c.picked[0])}:{}}];
 return [plain(text),...select,{tag:'input',name:'other'+i,width:'fill',placeholder:{tag:'plain_text',content:'其他（填写后以此为准）'},...c.other?{default_value:c.other}:{}}];
}
// The card of a waiting request. Every drawing needs its own render number: the channel drops a click that repeats the card, person and
// button value of an earlier one. form holds the choices of a submission to keep when a question card is drawn again.
export function pending(r,render,form){
 const value={request:r.id,check:check(r),render};
 if(r.kind==='question')return card(title(r),'blue',[{tag:'form',name:'answers',elements:[...r.questions.flatMap((q,i)=>question(q,i,form)),
  {tag:'button',text:{tag:'plain_text',content:'提交'},type:'primary',form_action_type:'submit',name:'submit',behaviors:[{type:'callback',value:{...value,questions:r.questions.length}}]}]}]);
 const buttons=(r.decisions||[]).filter(d=>decisions[d]).map(d=>({tag:'column',width:'auto',elements:[{tag:'button',text:{tag:'plain_text',content:decisions[d].label},type:decisions[d].type,behaviors:[{type:'callback',value:{...value,decision:d}}]}]}));
 return card(title(r),'orange',[...describe(r),...buttons.length?[{tag:'column_set',horizontal_spacing:'8px',columns:buttons}]:[]]);
}
// The answer a click gives request r: {decision} or {answers} with a list of strings per question text. Null for a decision the request
// does not offer or a question left unanswered.
export function answerOf(r,{value,formValue}){
 if(r.kind!=='question')return r.decisions?.includes(value?.decision)&&decisions[value.decision]?{decision:value.decision}:null;
 const answers={};
 for(const [i,q] of r.questions.entries()){
  const c=choice(formValue,i),labels=c.other?[c.other]:c.picked.map(j=>q.options?.[j]?.label).filter(Boolean);
  if(!labels.length)return null;answers[q.question]=q.multi_select?labels:labels.slice(0,1);
 }
 return {answers};
}
// Arguments of `herdr agent answer <pane> <request id>` for an answer.
export const answerArgs=a=>a.answers?['--answers',JSON.stringify(a.answers)]:['--decision',a.decision,...a.decision==='deny'?['--message',refused]:[]];
// The card once someone answered from Feishu: the answer and who gave it, without buttons.
export function settled(r,a,openId){
 if(a.answers)return card(title(r),'green',[...r.questions.map(q=>plain(`${q.question}\n回答：${a.answers[q.question].join('、')}`)),by('已回答',openId)]);
 const d=decisions[a.decision];return card(title(r),d.template,[...describe(r),by(d.done,openId)]);
}
// Cards of records whose request is gone; only the title is kept in the record.
export const expired=heading=>card(heading,'grey',[plain('已失效（超时、已在终端处理或本轮已结束）')]);
export const failed=heading=>card(heading,'grey',[plain('提交失败。Agent 仍在等待时会重新发送卡片')]);
