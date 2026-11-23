let port=null,connected=false,enabled=false,epoch=0,connectionError="";
const permissions={origins:['<all_urls>']};
function badge(){chrome.action.setBadgeText({text:enabled&&connected?'ON':''});chrome.action.setBadgeBackgroundColor({color:'#1f9d63'});}
function connect(){if(port)return;port=chrome.runtime.connectNative('com.termbridge.browser');port.onDisconnect.addListener(()=>{connectionError=chrome.runtime.lastError?.message||"Chrome 连接已关闭";port=null;connected=false;enabled=false;epoch++;badge();});port.onMessage.addListener(async msg=>{if(msg.event==='connected'){connected=true;connectionError="";port.postMessage({event:'permission',enabled});badge();return;}if(!msg.id)return;const owner=port,generation=epoch;try{if(!enabled)throw Error('请先在插件中开启浏览器协助');const data=await execute(msg.op,msg.args||{},generation);if(owner===port)owner.postMessage({id:msg.id,ok:true,data});}catch(e){if(owner===port)owner.postMessage({id:msg.id,ok:false,error:e.message});}});}
function check(g){if(!enabled||g!==epoch)throw Error('浏览器协助已停止');}
async function target(args){const tab=args.tabId===undefined?(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0]:await chrome.tabs.get(args.tabId);if(!tab||!/^https?:\/\//.test(tab.url||''))throw Error('请选择普通网页；浏览器设置页无法操作。');return tab;}
function webURL(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol))throw Error('仅支持 HTTP / HTTPS 网页');return u.href;}
async function execute(op,args,g){
 check(g);
 if(op==='tabs')return(await chrome.tabs.query({})).filter(t=>/^https?:\/\//.test(t.url||'')).map(t=>({tabId:t.id,title:t.title,url:t.url,active:t.active}));
 if(op==='open'){const url=webURL(args.url);check(g);const t=await chrome.tabs.create({url,active:args.active!==false});return {tabId:t.id};}
 const tab=await target(args);check(g);
 if(op==='navigate'){const url=webURL(args.url);await chrome.tabs.update(tab.id,{url});return {tabId:tab.id};}
 if(op==='close'){await chrome.tabs.remove(tab.id);return {closed:tab.id};}
 if(op==='screenshot'){
  const [active]=await chrome.tabs.query({active:true,windowId:tab.windowId});if(active?.id!==tab.id)throw Error('截图前请切换到目标标签页');check(g);
  const image=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:55});if(image.length>900000)throw Error('截图过大，请缩小浏览器窗口后重试');return {tabId:tab.id,image};
 }
 if(!['read','click','type'].includes(op))throw Error('不支持的浏览器操作');
 if(op!=='read'&&(typeof args.selector!=='string'||args.selector.length>1000))throw Error('需要网页元素 selector');
 if(op==='type'&&(typeof args.text!=='string'||args.text.length>16000))throw Error('输入文字长度无效');
 check(g);
 const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:pageAction,args:[op,args]});
 check(g);return result[0]?.result;
}
function pageAction(op,args){
 const visible=e=>!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';
 const selector=e=>{if(e.id)return '#'+CSS.escape(e.id);const parts=[];for(let n=e;n&&n!==document.body;n=n.parentElement){let i=1;for(let p=n.previousElementSibling;p;p=p.previousElementSibling)if(p.tagName===n.tagName)i++;parts.unshift(n.tagName.toLowerCase()+`:nth-of-type(${i})`);}return 'body>'+parts.join('>');};
 if(op==='read')return {title:document.title,url:location.href,text:(document.body?.innerText||'').slice(0,30000),elements:[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0,120).map(e=>({selector:selector(e),tag:e.tagName.toLowerCase(),type:e.type||'',label:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||'').slice(0,160)}))};
 const element=document.querySelector(args.selector);if(!element||!visible(element))throw Error('目标元素不存在或不可见');if(element.disabled)throw Error('目标元素已禁用');
 if(op==='click'){element.click();return {clicked:true};}
 element.focus();
 if(element.isContentEditable)element.textContent=args.text;
 else {const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLInputElement?HTMLInputElement.prototype:null;if(!proto)throw Error('目标元素不是输入框');const setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(element,args.text);}
 element.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:args.text}));element.dispatchEvent(new Event('change',{bubbles:true}));return {typed:true};
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
 if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html')){reply({ok:false});return;}
 if(msg.op==='status'){reply({connected,enabled,error:connectionError});return;}
 if(msg.op==='enable'){chrome.permissions.contains(permissions).then(granted=>{if(!granted){reply({ok:false,error:'请允许网页访问权限'});return;}enabled=true;epoch++;connect();if(connected)port.postMessage({event:'permission',enabled});badge();reply({ok:true});});return true;}
 if(msg.op==='disable'){enabled=false;epoch++;if(port)port.postMessage({event:'permission',enabled:false});badge();reply({ok:true});return;}
});
chrome.permissions.onRemoved.addListener(()=>{enabled=false;epoch++;if(port)port.postMessage({event:'permission',enabled:false});badge();});
connect();
