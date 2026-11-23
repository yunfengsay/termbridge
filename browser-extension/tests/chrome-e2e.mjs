// Isolated real-Chrome acceptance. Test manifest grants the same optional origins at install time
// because headless Chrome cannot accept the native permission prompt; production keeps them optional.
import {spawn,execFile} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import http from 'node:http';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {promisify} from 'node:util';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'tb-extension-e2e-')),profile=path.join(dir,'chrome'),extension=path.join(dir,'extension'),home=path.join(dir,'bridge');
fs.cpSync(path.join(root,'extension'),extension,{recursive:true});const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));manifest.host_permissions=manifest.optional_host_permissions;delete manifest.optional_host_permissions;fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const quote=x=>"'"+x.replaceAll("'","'\\''")+"'";const launcher=path.join(dir,'native');fs.writeFileSync(launcher,`#!/bin/sh\nexport TB_BROWSER_HOME=${quote(home)}\nexec ${quote(process.execPath)} ${quote(path.join(root,'bridge.mjs'))} native-host\n`,{mode:0o700});
fs.mkdirSync(path.join(profile,'NativeMessagingHosts'),{recursive:true});fs.writeFileSync(path.join(profile,'NativeMessagingHosts/com.termbridge.browser.json'),JSON.stringify({name:'com.termbridge.browser',description:'TermBridge acceptance',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}));
const server=http.createServer((q,r)=>{r.setHeader('content-type','text/html; charset=utf-8');r.end('<!doctype html><title>TB Browser Fixture</title><h1>Browser acceptance</h1><input id="name"><button id="apply" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Apply</button><p id="result"></p>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const binary=process.env.TB_CHROME_BINARY||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';const chrome=spawn(binary,['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-pipe','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`],{stdio:['ignore','ignore','pipe','pipe','pipe']});chrome.stderr.on('data',()=>{});let seq=0,buffer=Buffer.alloc(0);const pending=new Map();chrome.stdio[4].on('data',b=>{buffer=Buffer.concat([buffer,b]);let i;while((i=buffer.indexOf(0))>=0){const m=JSON.parse(buffer.subarray(0,i));buffer=buffer.subarray(i+1);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}}});
async function call(method,params={},sessionId){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),15000);pending.set(id,r=>{clearTimeout(timer);r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result)});chrome.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');});}
async function cli(...args){const {stdout}=await promisify(execFile)(process.execPath,[path.join(root,'bridge.mjs'),...args],{env:{...process.env,TB_BROWSER_HOME:home},timeout:25000,maxBuffer:2*1024*1024});return JSON.parse(stdout);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 assert.equal((await call('Extensions.loadUnpacked',{path:extension})).id,id);
 const popup=(await call('Target.createTarget',{url:`chrome-extension://${id}/popup.html`})).targetId;const {sessionId}=await call('Target.attachToTarget',{targetId:popup,flatten:true});await pause(1500);
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sessionId);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 let state=await evaluate("chrome.runtime.sendMessage({op:'status'})");assert.equal(state.connected,true,JSON.stringify(state));assert.equal(state.enabled,false);
 await evaluate("chrome.runtime.sendMessage({op:'enable'})");assert.equal((await cli('status')).enabled,true);
 const page=await cli('call','open',JSON.stringify({url:`http://127.0.0.1:${server.address().port}/`}));const tabId=page.data.tabId;await pause(800);
 const read=await cli('call','read',JSON.stringify({tabId}));assert.match(read.data.text,/Browser acceptance/);
 assert.equal((await cli('call','type',JSON.stringify({tabId,selector:'#name',text:'TermBridge 中文输入'}))).data.typed,true);
 assert.equal((await cli('call','click',JSON.stringify({tabId,selector:'#apply'}))).data.clicked,true);
 assert.match((await cli('call','read',JSON.stringify({tabId}))).data.text,/TermBridge 中文输入/);
 const image=await cli('call','screenshot',JSON.stringify({tabId}));assert.ok(image.data.image.startsWith('data:image/jpeg;base64,'));
 assert.ok((await cli('call','tabs')).data.some(t=>t.tabId===tabId));
 await evaluate("chrome.runtime.sendMessage({op:'disable'})");assert.equal((await cli('status')).enabled,false);await assert.rejects(()=>cli('call','read',JSON.stringify({tabId})));
 console.log('PASS real Chrome: native connection, consent, tabs, read, Chinese input, click, screenshot and revocation');
}finally{chrome.kill();await new Promise(r=>chrome.once('exit',r));server.close();fs.rmSync(dir,{recursive:true,force:true});}
