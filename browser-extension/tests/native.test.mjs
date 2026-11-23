import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import net from 'node:net';
import {decodeFrames} from '../bridge.mjs';
function frame(v){const b=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);}
test('native framing supports split headers, UTF-8 and rejects oversized frames',()=>{const values=[],decode=decodeFrames(v=>values.push(v));const b=frame({text:'中文'});for(const x of b)decode(Buffer.from([x]));assert.deepEqual(values,[{text:'中文'}]);const bad=Buffer.alloc(4);bad.writeUInt32LE(1048577);assert.throws(()=>decode(bad),/too large/);});
test('native connection requires token and consent, routes replies and revokes pending calls',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tb-browser-test-'));const p=spawn(process.execPath,[new URL('../bridge.mjs',import.meta.url).pathname,'native-host'],{env:{...process.env,TB_BROWSER_HOME:dir},stdio:['pipe','pipe','pipe']});const messages=[];p.stdout.on('data',decodeFrames(m=>messages.push(m)));
 const wait=async condition=>{for(let i=0;i<100&&!condition();i++)await new Promise(r=>setTimeout(r,20));assert.ok(condition());};
 try{await wait(()=>messages.some(m=>m.event==='connected'));const secret=fs.readFileSync(path.join(dir,'token'),'utf8');const send=q=>new Promise((resolve,reject)=>{const s=net.connect(path.join(dir,'bridge.sock'));let data='';s.on('connect',()=>s.write(JSON.stringify(q)+'\n'));s.on('data',b=>{data+=b;if(data.includes('\n')){resolve(JSON.parse(data));s.end();}});s.on('error',reject);});
 assert.equal((await send({token:'wrong',op:'read'})).ok,false);assert.equal((await send({token:secret,op:'read'})).ok,false);
 p.stdin.write(frame({event:'permission',enabled:true}));const result=send({token:secret,op:'read',args:{tabId:1}});await wait(()=>messages.some(m=>m.op==='read'));const q=messages.find(m=>m.op==='read');p.stdin.write(frame({id:q.id,ok:true,data:{text:'中文'}}));assert.equal((await result).data.text,'中文');
 const pending=send({token:secret,op:'read'});await wait(()=>messages.filter(m=>m.op==='read').length===2);p.stdin.write(frame({event:'permission',enabled:false}));assert.match((await pending).error,/revoked/);
 assert.equal((await send({token:secret,op:'status'})).enabled,false);
 }finally{p.stdin.end();await new Promise(r=>p.on('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
