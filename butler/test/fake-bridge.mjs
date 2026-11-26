// A stand-in for Bridge's control plane as butler uses it: GET /api/state, POST /api/topics/open, GET /api/topics/context and
// POST /api/topics/digest, all with the bearer access key (anything else is 401), as bridge/README.md documents them. The test
// sets what /api/state lists (state), what opening a topic answers (script: one answer per request, {status, body}, in order;
// none left: the success answer), the ready topics of the context (topics) and what a digest answers (digestScript, the same
// way), and reads every request in `requests`. A repeated key returns the first result with created: false, as the real one
// does; a digest for a topic that is not in topics is 404 unknown_topic.
import http from 'node:http';

export const KEY='bridge-key';
export class FakeBridge{
 constructor({state={}}={}){
  this.state={projects:[],agentConfigs:[],machines:[],bindings:[],...state};this.script=[];this.requests=[];this.byKey=new Map();this.seq=0;
  this.topics=[];this.digestScript=[];this.digestKeys=new Set();
  this.server=http.createServer((req,res)=>this.#handle(req,res));
 }
 async listen(){await new Promise(r=>this.server.listen(0,'127.0.0.1',r));this.url=`http://127.0.0.1:${this.server.address().port}`;return this;}
 async close(){this.server.closeAllConnections();await new Promise(r=>this.server.close(r));}
 // The requests that opened (or tried to open) a topic.
 opens(){return this.requests.filter(r=>r.method==='POST'&&r.path==='/api/topics/open');}
 // The digests handed to topics, as {topicId, key, text}.
 digests(){return this.requests.filter(r=>r.method==='POST'&&r.path==='/api/topics/digest').map(r=>r.body);}
 async #handle(req,res){
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):undefined,path=new URL(req.url,'http://fake').pathname;
  this.requests.push({method:req.method,path,body,authorization:req.headers.authorization});
  const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(req.headers.authorization!==`Bearer ${KEY}`)return send(401,{error:'未授权'});
  if(path==='/api/state'&&req.method==='GET')return send(200,this.state);
  if(path==='/api/topics/context'&&req.method==='GET')return send(200,{topics:this.topics});
  if(path==='/api/topics/digest'&&req.method==='POST'){
   const scripted=this.digestScript.shift();if(scripted)return send(scripted.status,scripted.body);
   const t=this.topics.find(x=>x.id===body.topicId);if(!t)return send(404,{error:'话题不存在',code:'unknown_topic'});
   const id=`${body.topicId} ${body.key}`,created=!this.digestKeys.has(id);this.digestKeys.add(id);
   return send(200,{topicId:body.topicId,key:body.key,created,pending:1});
  }
  if(path==='/api/topics/open'&&req.method==='POST'){
   const scripted=this.script.shift();if(scripted)return send(scripted.status,scripted.body);
   if(body.key&&this.byKey.has(body.key))return send(200,{...this.byKey.get(body.key),created:false});
   const result={topicId:`t${++this.seq}`,bindingId:`b${this.seq}`,rootMessageId:`om_root${this.seq}`,created:true};
   if(body.key)this.byKey.set(body.key,result);return send(200,result);
  }
  send(404,{error:'没有这个接口'});
 }
}
