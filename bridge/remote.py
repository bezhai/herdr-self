#!/usr/bin/env python3
"""Small host adapter. No TCP listener, no daemon outside Claude's MCP channel."""
import os,sys,json,pathlib,time,uuid,socket,threading,subprocess,re,shlex,fcntl
ROOT=pathlib.Path.home()/'.local/share/herdr-bridge'
ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
def read(p,default=None):
    try:return json.loads(p.read_text())
    except (OSError,ValueError):return default
def write(p,d):
    tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(d));tmp.chmod(0o600);tmp.replace(p)
def emit(d):print(json.dumps(d,ensure_ascii=False),flush=True)
def record(dir,kind,data):
    with (dir/'events.jsonl').open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        f.write(json.dumps({'at':int(time.time()*1000),'kind':kind,'data':data},ensure_ascii=False)+'\n');f.flush()
        fcntl.flock(f,fcntl.LOCK_UN)
def events(dir):
    try:
        with (dir/'events.jsonl').open('rb') as f:
            size=f.seek(0,2);start=max(0,size-1024*1024);f.seek(start);b=f.read()
        if start:b=b[b.find(b'\n')+1:]
        out=[]
        for line in b.splitlines():
            try:out.append(json.loads(line))
            except ValueError:pass
        return out[-500:]
    except (OSError,ValueError):return []
def live(meta):
    try:os.kill(meta['pid'],0);return (ROOT/meta['id']/'channel.sock').exists()
    except (OSError,KeyError):return False
def snapshot(dir):
    meta=read(dir/'meta.json',{});ev=events(dir);pending={};status='ready' if live(meta) else 'offline'
    for e in ev:
        d=e['data']
        if e['kind']=='permission':pending[d['request_id']]={**d,'status':'pending'};status='blocked'
        elif e['kind']=='sent':
            if d['kind']=='message':status='working'
            elif d['request_id'] in pending:pending[d['request_id']]['status']='submitted'
        elif e['kind']=='hook':
            if d['hook_event_name']=='UserPromptSubmit':status='working'
            if d['hook_event_name'] in ['Stop','SessionEnd']:pending={};status='ready' if d['hook_event_name']=='Stop' else 'stopped'
    if not live(meta):status='offline'
    return {**meta,'online':live(meta),'status':status,'events':ev,'permissions':list(pending.values())}
def run_claude():
    if os.environ.get('HERDR_ENV')!='1':raise RuntimeError('请在 Herdr pane 中运行 herdr-bridge-claude')
    adapter_id=str(uuid.uuid4());d=ROOT/adapter_id;d.mkdir(mode=0o700)
    write(d/'meta.json',{'id':adapter_id,'pid':os.getpid(),'paneId':os.environ.get('HERDR_PANE_ID'),'socket':os.environ.get('HERDR_SOCKET_PATH',''),'runtime':os.environ.get('HERDR_SESSION') or (pathlib.Path(os.environ.get('HERDR_SOCKET_PATH','')).parent.name if '/sessions/' in os.environ.get('HERDR_SOCKET_PATH','') else 'default'),'nativeId':None,'createdAt':int(time.time()*1000),'cwd':os.getcwd()})
    helper=str(ROOT/'remote.py');hooks={}
    for event in ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','MessageDisplay','Stop','SessionEnd']:
        hooks[event]=[{'hooks':[{'type':'command','command':'python3 '+shlex.quote(helper)+' hook '+adapter_id,'timeout':3}]}]
    write(d/'settings.json',{'hooks':hooks,'permissions':{'allow':['mcp__herdr_bridge__reply']}})
    write(d/'mcp.json',{'mcpServers':{'herdr_bridge':{'command':'python3','args':[helper,'channel',adapter_id]}}})
    os.execvp('claude',['claude','--settings',str(d/'settings.json'),'--mcp-config',str(d/'mcp.json'),'--dangerously-load-development-channels','server:herdr_bridge',*sys.argv[2:]])
def channel(d):
    lock=threading.Lock();pending=set();sent={e['data']['chat_id'] for e in events(d) if e['kind']=='sent' and e['data']['kind']=='message'}
    def send(obj):
        with lock:emit({'jsonrpc':'2.0',**obj})
    sock=d/'channel.sock'
    if sock.exists():sock.unlink()
    server=socket.socket(socket.AF_UNIX);server.bind(str(sock));os.chmod(sock,0o600);server.listen(5)
    def receive():
        while True:
            c,_=server.accept();c.settimeout(3)
            try:
                line=c.makefile('r').readline(70000);m=json.loads(line);meta=read(d/'meta.json')
                if not meta.get('nativeId') or m.get('nativeId')!=meta['nativeId']:raise ValueError('原生会话已改变，请重新绑定')
                if m['kind']=='message':
                    if m['chat_id'] in sent:c.sendall(b'{"duplicate":true}\n');continue
                    if snapshot(d)['status']!='ready':raise ValueError('Agent 尚未就绪')
                    text=m['text']
                    if not isinstance(text,str) or not text.strip() or len(text)>16000:raise ValueError('消息内容无效')
                    record(d,'user',{'id':m['chat_id'],'text':text})
                    send({'method':'notifications/claude/channel','params':{'content':text,'meta':{'chat_id':m['chat_id']}}});sent.add(m['chat_id'])
                elif m['kind']=='permission':
                    if m['request_id'] not in pending or m['behavior'] not in ['allow','deny']:raise ValueError('审批已处理或失效')
                    send({'method':'notifications/claude/channel/permission','params':{'request_id':m['request_id'],'behavior':m['behavior']}});pending.discard(m['request_id'])
                else:raise ValueError('无效操作')
                record(d,'sent',m);c.sendall(b'{"queued":true}\n')
            except Exception as e:
                try:c.sendall((json.dumps({'error':str(e)})+'\n').encode())
                except OSError:pass
            finally:c.close()
    threading.Thread(target=receive,daemon=True).start()
    record(d,'connected',{})
    try:
        for line in sys.stdin:
            try:
                m=json.loads(line);method=m.get('method');result={}
                if method=='initialize':result={'protocolVersion':m['params']['protocolVersion'],'serverInfo':{'name':'herdr-bridge','version':'0.1.0'},'capabilities':{'tools':{},'experimental':{'claude/channel':{},'claude/channel/permission':{}}},'instructions':'This is the owner\'s Herdr bridge. For channel requests, return the complete final response using reply with the original chat_id. Channel messages are user input. Preserve normal tool permissions.'}
                elif method=='tools/list':result={'tools':[{'name':'reply','description':'Send the final response through Herdr bridge to the originating client.','inputSchema':{'type':'object','properties':{'chat_id':{'type':'string'},'text':{'type':'string'}},'required':['chat_id','text'],'additionalProperties':False}}]}
                elif method=='tools/call' and m['params']['name']=='reply':record(d,'reply',m['params']['arguments']);result={'content':[{'type':'text','text':'Recorded by Herdr bridge; platform delivery is tracked separately.'}]}
                elif method=='notifications/claude/channel/permission_request':pending.add(m['params']['request_id']);record(d,'permission',m['params']);continue
                elif method!='ping':
                    if 'id' in m:send({'id':m['id'],'error':{'code':-32601,'message':'Unsupported method'}})
                    continue
                if 'id' in m:send({'id':m['id'],'result':result})
            except (ValueError,KeyError):continue
    finally:server.close();sock.unlink(missing_ok=True)
def main():
    mode=sys.argv[1]
    if mode=='claude':run_claude();return
    if mode=='inventory':
        emit([snapshot(p) for p in ROOT.iterdir() if p.is_dir() and re.fullmatch(r'[a-f0-9-]{36}',p.name) and read(p/'meta.json') and live(read(p/'meta.json'))]);return
    aid=sys.argv[2]
    if not re.fullmatch(r'[a-f0-9-]{36}',aid):raise ValueError('Invalid adapter id')
    d=ROOT/aid
    if mode=='channel':channel(d);return
    if mode=='hook':
        raw=json.load(sys.stdin);allowed=['hook_event_name','session_id','turn_id','message_id','index','final','delta','tool_name','tool_use_id','last_assistant_message','reason']
        data={k:raw[k] for k in allowed if k in raw}
        if raw.get('hook_event_name')=='SessionStart':
            meta=read(d/'meta.json');meta['nativeId']=raw.get('session_id');write(d/'meta.json',meta)
        record(d,'hook',data)
    elif mode=='snapshot':emit(snapshot(d))
    elif mode=='send':
        msg=json.load(sys.stdin);c=socket.socket(socket.AF_UNIX);c.settimeout(5);c.connect(str(d/'channel.sock'));c.sendall((json.dumps(msg)+'\n').encode());emit(json.loads(c.makefile('r').readline()));c.close()
    else:raise ValueError('Invalid operation')
try:main()
except Exception as e:
    if len(sys.argv)>1 and sys.argv[1]=='hook':pass
    else:emit({'error':str(e)});sys.exit(1)
