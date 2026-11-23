const terminal=new Terminal({cursorBlink:true,fontSize:14,lineHeight:1.15,fontFamily:'"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace',scrollback:5000,theme:{background:'#202020',foreground:'#e8e8e8',cursor:'#ffffff'}});
const fit=new FitAddon.FitAddon();terminal.loadAddon(fit);terminal.open(document.getElementById('terminal'));
terminal.onData(data=>chrome.webview.postMessage({op:'input',data}));
terminal.onResize(({cols,rows})=>chrome.webview.postMessage({op:'resize',cols,rows}));
let frame;new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>fit.fit());}).observe(document.getElementById('terminal'));
chrome.webview.addEventListener('message',({data:message})=>{
 if(message.event==='output')terminal.write(Uint8Array.from(atob(message.data),x=>x.charCodeAt(0)));
 // xterm.write is queued. Reset in that same queue so old-session bytes cannot
 // land after the clear and appear alongside the newly attached session.
 if(message.event==='terminal-reset')terminal.write('',()=>terminal.reset());
 // Herdr sends a fixed screen plus cursor-addressed patches, not a reflowable PTY log.
 // Match the CLI's native-terminal mode; normal shell sessions retain scrollback.
 if(message.event==='terminal-mode'&&message.native)terminal.write('\x1b[?1049h\x1b[?2004h');
 if(message.event==='paste')terminal.paste(message.text);
 if(message.event==='focus'){requestAnimationFrame(()=>{
  fit.fit();
  // A new attachment needs its size even when the WebView itself did not resize.
  chrome.webview.postMessage({op:'resize',cols:terminal.cols,rows:terminal.rows});
  terminal.focus();
 });}
});
chrome.webview.postMessage({op:'ready'});

terminal.attachCustomKeyEventHandler(event=>{
 if(event.ctrlKey&&!event.altKey&&event.key.toLowerCase()==='v'){
  event.preventDefault();
  if(event.type==='keydown')chrome.webview.postMessage({op:'paste'});
  return false;
 }
 if(event.ctrlKey&&event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='c'){
  event.preventDefault();
  if(event.type==='keydown')chrome.webview.postMessage({op:'copy',data:terminal.getSelection()});
  return false;
 }
 return true;
});
