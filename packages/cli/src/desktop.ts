import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { WebSocket } from 'ws';
import { FrameType, parseFrame, encodeControl, framePtyIn, framePtyResize, ControlMessageSchema } from '@termbridge/protocol';
import { dial, handshake } from './client.js';

/**
 * Map one local desktop request onto its Host control message.
 *
 * `generation` is carried on every request that can produce an answer, including
 * `chat-earlier`: the Host echoes it back so a shell can discard a page that
 * belongs to a conversation view the user has already left. Dropping it here
 * would strand every "load earlier" at the shell.
 *
 * Exported so the mapping itself is testable; the schema does the validating.
 */
export function agentChatControl(request:Record<string,unknown>):Record<string,unknown>{
  switch(request.op){
    case 'chat-list':return {t:'agent_chat_list',requestId:request.requestId};
    case 'chat-subscribe':return {t:'agent_chat_subscribe',requestId:request.requestId,conversationId:request.conversationId,generation:request.generation};
    case 'chat-unsubscribe':return {t:'agent_chat_unsubscribe',conversationId:request.conversationId};
    case 'chat-earlier':return {t:'agent_chat_earlier',requestId:request.requestId,conversationId:request.conversationId,generation:request.generation,cursor:request.cursor};
    default:return {t:'agent_chat_send',requestId:request.requestId,conversationId:request.conversationId,text:request.text};
  }
}

/** Versioned local JSON-lines surface for native UI clients. CLI owns Relay/PTY semantics. */
export function runDesktop(host: string): void {
  let manager: WebSocket | undefined, terminal: WebSocket | undefined;
  let selectedHost = host;
  let sid: number | undefined, ready = false, closing = false, retry: ReturnType<typeof setTimeout> | undefined;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;
  const pendingTools = new Set<string>();
  // Layout arrives before attach and can change during its handshake.
  let cols = 100, rows = 28;
  const timers = new Map<WebSocket, ReturnType<typeof setInterval>>();
  const emit = (value: unknown) => {
    if (!process.stdout.write(JSON.stringify(value) + '\n')) {
      manager?.pause(); terminal?.pause();
      process.stdout.once('drain', () => { manager?.resume(); terminal?.resume(); });
    }
  };
  const error = (message: string) => emit({event:'error',message});
  function closeTerminal() {
    clearTimeout(requestTimeout);requestTimeout=undefined;
    const old=terminal;terminal=undefined;sid=undefined;old?.terminate();
  }
  function watch(ws: WebSocket) {
    let last=Date.now();
    ws.on('message',()=>{last=Date.now();});ws.on('ping',()=>{last=Date.now();});ws.on('pong',()=>{last=Date.now();});
    timers.set(ws,setInterval(()=>{if(Date.now()-last>70000)ws.terminate();else if(ws.readyState===WebSocket.OPEN)ws.ping();},10000));
    ws.on('close',()=>{clearInterval(timers.get(ws));timers.delete(ws);});
    ws.on('error',()=>error('无法连接 Host，请检查网络、证书指纹和代理设置。'));
  }
  function refresh(){if(manager?.readyState===WebSocket.OPEN)manager.send(encodeControl({t:'session_list'}));}
  function connect() {
    if(closing)return;
    emit({event:'status',status:'connecting'});ready=false;
    const ws=manager=dial();watch(ws);
    handshake(ws,host,()=>{
      ws.send(encodeControl({t:'config_get'}));refresh();
      if(process.env.TB_DESKTOP_DEVICE_ID)ws.send(encodeControl({t:'peer_register',deviceId:process.env.TB_DESKTOP_DEVICE_ID,
        platform:process.platform,name:hostname(),role:'manager',capabilities:['computer.tools','computer.call']}));
    },true);
    ws.on('message',raw=>{
      if(manager!==ws||closing)return;
      try{
        const frame=parseFrame(raw as Buffer);if(frame.type!==FrameType.Control)return;
        const msg=frame.msg;
        switch(msg.t){
          case 'config_info':selectedHost=msg.hostId||host;ready=true;emit({event:'config',hostId:msg.hostId,hostName:msg.hostName,agents:Object.keys(msg.agents)});emit({event:'status',status:'ready'});break;
          case 'host_list_result':emit({event:'hosts',data:msg});break;
          case 'session_list_result':emit({event:'sessions',sessions:msg.sessions});break;
          // Agent conversation rides the management connection on purpose: it is
          // a second view of an existing Agent, not a terminal attachment, so it
          // must not require one and must not disturb one.
          case 'agent_chat_list_result':emit({event:'chat-list',requestId:msg.requestId,conversations:msg.conversations});break;
          case 'agent_chat_snapshot':emit({event:'chat-snapshot',data:msg});break;
          case 'agent_chat_append':emit({event:'chat-append',data:msg});break;
          case 'agent_chat_earlier_result':emit({event:'chat-earlier',data:msg});break;
          case 'agent_chat_delivery':emit({event:'chat-delivery',data:msg});break;
          case 'tool_request':
            if(pendingTools.size>=8){ws.send(encodeControl({t:'tool_response',id:msg.id,ok:false,error:'电脑工具繁忙'}));break;}
            pendingTools.add(msg.id);emit({event:'tool',request:msg});break;
          case 'error':error(msg.message);break;
        }
      }catch{error('Host 返回了无效消息。');ws.terminate();}
    });
    ws.on('close',code=>{
      if(manager!==ws||closing)return;
      ready=false;closeTerminal();pendingTools.clear();emit({event:'status',status:'offline'});
      if(code!==4001&&code!==4002)retry=setTimeout(connect,3000);
    });
  }
  function openTerminal(sessionId?: string, agent?: string, cwd?: string) {
    if(!ready)throw Error('请先连接 Host。');
    if(requestTimeout)throw Error('正在打开会话，请稍候。');
    closeTerminal();emit({event:'terminal-reset'});emit({event:'status',status:'attaching'});
    const ws=terminal=dial();watch(ws);
    requestTimeout=setTimeout(()=>{
      closeTerminal();error(sessionId?'打开会话超时，请刷新后重试。':'未收到创建结果，请先刷新列表确认，避免重复创建。');emit({event:'status',status:'ready'});refresh();
    },20000);
    handshake(ws,selectedHost,()=>ws.send(encodeControl(sessionId
      ? {t:'attach',sessionId,cols,rows,nativeTerminal:true}
      : {t:'session_create',agent,cwd,cols,rows,clientPlatform:process.platform,clientName:hostname()})));
    ws.on('message',raw=>{
      if(terminal!==ws||closing)return;
      try{
        const frame=parseFrame(raw as Buffer);
        if(frame.type===FrameType.PtyOut){if(frame.sid===sid)emit({event:'output',data:Buffer.from(frame.data).toString('base64')});return;}
        if(frame.type!==FrameType.Control)return;
        const msg=frame.msg;
        if(msg.t==='attach_ok'||msg.t==='session_created'){
          clearTimeout(requestTimeout);requestTimeout=undefined;sid=msg.sid;
          ws.send(framePtyResize(sid,cols,rows));
          emit({event:'attached',sessionId:msg.sessionId});refresh();
        }else if(msg.t==='error'){error(msg.message);closeTerminal();emit({event:'status',status:'ready'});refresh();}
        else if(msg.t==='session_exit'){closeTerminal();emit({event:'status',status:'ready'});refresh();}
        else if(msg.t==='tool_request')ws.send(encodeControl({t:'tool_response',id:msg.id,ok:false,error:'请使用独立注册的电脑协助通道'}));
      }catch{error('终端消息无效。');closeTerminal();emit({event:'status',status:'ready'});}
    });
    ws.on('close',()=>{if(terminal===ws){closeTerminal();error('终端连接已断开，可以从列表重新打开。');emit({event:'status',status:ready?'ready':'offline'});}});
  }
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  input.on('line',line=>{
    try{
      if(Buffer.byteLength(line)>16*1024*1024)throw Error('本地请求过大。');
      const request=JSON.parse(line);
      switch(request.op){
        case 'refresh':refresh();break;
        case 'attach':
          if(typeof request.sessionId!=='string'||request.sessionId.length>256)throw Error('会话标识无效。');
          openTerminal(request.sessionId);break;
        case 'create': {
          const msg=ControlMessageSchema.parse({t:'session_create',agent:request.agent||undefined,cwd:request.cwd||undefined,cols:100,rows:28});
          if(msg.t==='session_create')openTerminal(undefined,msg.agent,msg.cwd);break;
        }
        case 'input':
          if(typeof request.data!=='string'||Buffer.byteLength(request.data)>65536)throw Error('终端输入过长。');
          if(sid!==undefined&&terminal?.readyState===WebSocket.OPEN)terminal.send(framePtyIn(sid,Buffer.from(request.data)));break;
        case 'resize':
          if(!Number.isInteger(request.cols)||!Number.isInteger(request.rows)||request.cols<2||request.cols>500||request.rows<2||request.rows>200)throw Error('终端尺寸无效。');
          cols=request.cols;rows=request.rows;
          if(sid!==undefined&&terminal?.readyState===WebSocket.OPEN)terminal.send(framePtyResize(sid,cols,rows));break;
        case 'chat-list':
        case 'chat-subscribe':
        case 'chat-unsubscribe':
        case 'chat-earlier':
        case 'chat-send': {
          // The schema is the gate: a malformed local request is rejected here
          // rather than forwarded to the Host.
          const msg=ControlMessageSchema.parse(agentChatControl(request));
          if(manager?.readyState===WebSocket.OPEN)manager.send(encodeControl(msg));
          else throw Error('请先连接 Host。');
          break;
        }
        case 'tool-response': {
          const msg=ControlMessageSchema.parse({...request.response,t:'tool_response'});
          if(msg.t==='tool_response'&&pendingTools.delete(msg.id)&&manager?.readyState===WebSocket.OPEN)manager.send(encodeControl(msg));break;
        }
        default:throw Error('不支持的桌面命令。');
      }
    }catch(e){error(e instanceof Error?e.message:'本地请求无效。');}
  });
  function stop(){closing=true;clearTimeout(retry);closeTerminal();manager?.terminate();input.close();for(const timer of timers.values())clearInterval(timer);}
  input.on('close',stop);process.once('SIGTERM',stop);process.once('SIGINT',stop);
  connect();
}
