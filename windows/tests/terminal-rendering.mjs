// Real bundled xterm in Chromium. No WebView/terminal implementation mocks.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root=path.resolve(process.env.TB_TEST_TERMINAL_DIR||'windows/TermBridge.App/Terminal');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tb-terminal-render-'));
const server=http.createServer((q,r)=>{
 const file=path.join(root,path.basename(q.url==='/'?'index.html':q.url));
 r.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
 if(!fs.existsSync(file)){r.writeHead(404);r.end();return;}r.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const chrome=spawn(process.env.TB_CHROME_BINARY||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
 '--headless=new','--no-first-run','--remote-debugging-pipe',`--user-data-dir=${profile}`
],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let next=0,buffer=Buffer.alloc(0);const pending=new Map();
chrome.stdio[4].on('data',b=>{
 buffer=Buffer.concat([buffer,b]);let i;
 while((i=buffer.indexOf(0))>=0){const m=JSON.parse(buffer.subarray(0,i));buffer=buffer.subarray(i+1);pending.get(m.id)?.(m);pending.delete(m.id);}
});
function call(method,params={},sessionId){const id=++next;return new Promise((resolve,reject)=>{
 const timeout=setTimeout(()=>reject(Error('CDP timeout: '+method)),10000);
 pending.set(id,m=>{clearTimeout(timeout);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});
 chrome.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');
});}
try{
 const {targetId}=await call('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 await call('Page.enable',{},sessionId);
 await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.sent=[];window.receive=null;window.chrome.webview={postMessage:m=>sent.push(m),addEventListener:(_,f)=>receive=f};`},sessionId);
 await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`},sessionId);
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 for(let i=0;i<100;i++){if(await evaluate('!!window.receive'))break;await new Promise(r=>setTimeout(r,20));}
 // Reattaching to another session keeps the same WebView size: onResize will not fire.
 await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 await evaluate("sent.length=0;receive({data:{event:'focus'}})");
 await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const size=await evaluate('({cols:terminal.cols,rows:terminal.rows,events:sent,focused:document.activeElement.className})');
 assert.ok(size.events.some(e=>e.op==='resize'&&e.cols===size.cols&&e.rows===size.rows),'Every attachment must explicitly synchronize unchanged viewport dimensions');
 assert.match(size.focused,/xterm-helper-textarea/);
 const afterSwitch=await evaluate(`(async()=>{
  receive({data:{event:'output',data:btoa('OLD_SESSION_PROMPT\\r\\n')}});
  receive({data:{event:'terminal-reset'}});
  receive({data:{event:'output',data:btoa('NEW_SESSION_PROMPT')}});
  await new Promise(r=>terminal.write('',r));
  return Array.from({length:terminal.buffer.active.length},(_,i)=>terminal.buffer.active.getLine(i).translateToString(true)).join('\\n');
 })()`);
 assert.ok(!afterSwitch.includes('OLD_SESSION_PROMPT'),'Queued output from the previous session must be consumed before resetting');
 assert.ok(afterSwitch.includes('NEW_SESSION_PROMPT'));
 await evaluate("receive({data:{event:'terminal-mode',native:true}});new Promise(r=>terminal.write('',r))");
 assert.equal(await evaluate('terminal.buffer.active.type'),'alternate','Herdr screen patches must not be reflowed as shell scrollback');
 // Repaint a cursor-addressed input area repeatedly at the negotiated geometry.
 for(const width of [740,420,900,420]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:540,deviceScaleFactor:1,mobile:false},sessionId);
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const lines=await evaluate(`(async()=>{
   const text='Ask Codex to do anything';
   for(let i=0;i<8;i++)await new Promise(r=>terminal.write('\\x1b[2J\\x1b['+(terminal.rows-2)+';1H> '+text+'\\r\\nstatus\\x1b['+(terminal.rows-2)+';3H',r));
   return Array.from({length:terminal.buffer.active.length},(_,i)=>terminal.buffer.active.getLine(i).translateToString(true));
  })()`);
  assert.equal(lines.filter(line=>line.includes('Ask Codex')).length,1,'One visible prompt after resize and repeated repaint');
 }
 await evaluate("receive({data:{event:'terminal-reset'}});receive({data:{event:'terminal-mode',native:false}});new Promise(r=>terminal.write('',r))");
 assert.equal(await evaluate('terminal.buffer.active.type'),'normal','Ordinary PTY sessions keep their scrollback buffer');
 console.log('PASS: queued old-session output is cleared; reattach resynchronizes geometry/focus; Herdr uses a fixed screen; repaint at four widths keeps one prompt.');
}finally{
 chrome.kill();await new Promise(r=>chrome.once('exit',r));server.close();fs.rmSync(profile,{recursive:true,force:true});
}
