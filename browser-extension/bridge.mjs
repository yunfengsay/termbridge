import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export const root=path.dirname(fileURLToPath(import.meta.url));
export const home=process.env.TB_BROWSER_HOME || path.join(os.homedir(),'.termbridge','browser');
export const endpoint=process.platform==='win32'?`\\\\.\\pipe\\termbridge-browser-${crypto.createHash('sha256').update(home).digest('hex').slice(0,20)}`:path.join(home,'bridge.sock');
const MAX=1024*1024, HOST='com.termbridge.browser';
export function decodeFrames(onMessage){let buffer=Buffer.alloc(0);return chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readUInt32LE(0);if(size>MAX)throw Error('Native message too large');if(buffer.length<size+4)return;const body=buffer.subarray(4,4+size);buffer=buffer.subarray(4+size);onMessage(JSON.parse(body.toString('utf8')));}};}
function frame(value){const body=Buffer.from(JSON.stringify(value));if(body.length>MAX)throw Error('Native message too large');const h=Buffer.alloc(4);h.writeUInt32LE(body.length);return Buffer.concat([h,body]);}
function privateHome(){fs.mkdirSync(home,{recursive:true,mode:0o700});}
function token(){privateHome();const p=path.join(home,'token');if(!fs.existsSync(p)){try{fs.writeFileSync(p,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}return fs.readFileSync(p,'utf8');}
export async function request(op,args={}){const auth=token();return new Promise((resolve,reject)=>{let data='';const s=net.connect(endpoint);const timer=setTimeout(()=>{s.destroy();reject(Error('Browser request timed out'));},20000);s.on('connect',()=>s.write(JSON.stringify({token:auth,op,args})+'\n'));s.on('data',b=>{data+=b;if(data.length>MAX){s.destroy(Error('Browser response too large'));return;}if(data.includes('\n')){clearTimeout(timer);s.end();try{resolve(JSON.parse(data.split('\n')[0]));}catch(e){reject(e);}}});s.on('error',()=>{clearTimeout(timer);reject(Error('Chrome 未连接：请在插件中开启浏览器协助。'));});s.on('end',()=>{clearTimeout(timer);if(!data.includes('\n'))reject(Error('Chrome 已断开连接。'));});});}
export async function nativeHost(){
 const auth=token();const pending=new Map();let sequence=0,enabled=false;let ownsSocket=false;
 const send=v=>process.stdout.write(frame(v));
 const server=net.createServer(socket=>{let input='';socket.setTimeout(22000,()=>socket.destroy());socket.on('error',()=>{});socket.on('data',chunk=>{input+=chunk;if(input.length>65536){socket.destroy();return;}if(!input.includes('\n'))return;const line=input;input='';try{const q=JSON.parse(line);if(q.token!==auth){socket.end(JSON.stringify({ok:false,error:'Unauthorized'})+'\n');return;}if(q.op==='status'){socket.end(JSON.stringify({ok:true,connected:true,enabled})+'\n');return;}if(!enabled){socket.end(JSON.stringify({ok:false,error:'Browser assistance is disabled'})+'\n');return;}const id=++sequence;pending.set(id,socket);socket.on('close',()=>pending.delete(id));send({id,op:q.op,args:q.args});}catch{socket.destroy();}});});
 const finish=()=>{for(const s of pending.values())s.end(JSON.stringify({ok:false,error:'Chrome disconnected'})+'\n');pending.clear();server.close();if(ownsSocket&&process.platform!=='win32')try{fs.unlinkSync(endpoint);}catch{};};
 // Probe before deleting a stale Unix socket: another Chrome profile may own it.
 if(process.platform!=='win32'&&fs.existsSync(endpoint)){try{await request('status');send({event:'error',error:'另一个 Chrome 窗口已连接，请先在那里关闭协助。'});return;}catch{fs.unlinkSync(endpoint);}}
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{ownsSocket=true;if(process.platform!=='win32')fs.chmodSync(endpoint,0o600);resolve();});});
 process.stdin.on('data',chunk=>{try{decode(chunk);}catch{finish();process.exitCode=1;process.stdin.destroy();}});
 const decode=decodeFrames(msg=>{if(msg.event==='permission'){enabled=msg.enabled===true;if(!enabled){for(const s of pending.values())s.end(JSON.stringify({ok:false,error:'Browser assistance revoked'})+'\n');pending.clear();}return;}const s=pending.get(msg.id);if(s){pending.delete(msg.id);s.end(JSON.stringify(msg)+'\n');}});
 process.stdin.on('end',finish);process.stdin.on('error',finish);process.on('SIGTERM',()=>{finish();process.exit();});send({event:'connected'});
}
export function install(){
 if(!['darwin','win32'].includes(process.platform))throw Error('Chrome 安装组件目前支持 macOS 和 Windows。');
 privateHome();if(path.join(root,'bridge.mjs')!==path.join(home,'bridge.mjs'))fs.copyFileSync(path.join(root,'bridge.mjs'),path.join(home,'bridge.mjs'));const source=path.join(root,'extension');const extension=path.join(home,'extension');fs.cpSync(source,extension,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json')));const digest=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32);const id=digest.replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 let launcher;
 if(process.platform==='win32'){
  launcher=process.env.TB_BROWSER_NATIVE_EXE;if(!launcher||!fs.existsSync(launcher))throw Error('请通过 Windows App 设置安装 Chrome 连接组件。');
 }else{launcher=path.join(home,'native-host');const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";fs.writeFileSync(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(home,'bridge.mjs'))} native-host "$@"\n`,{mode:0o700});fs.chmodSync(launcher,0o700);}
 const native={name:HOST,description:'TermBridge browser connection',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]};
 const manifestPath=process.platform==='win32'?path.join(home,HOST+'.json'):path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts',HOST+'.json');fs.mkdirSync(path.dirname(manifestPath),{recursive:true});fs.writeFileSync(manifestPath,JSON.stringify(native,null,2),{mode:0o600});
 if(process.platform==='win32'){const r=spawnSync('reg.exe',['add',`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`,'/ve','/t','REG_SZ','/d',manifestPath,'/f'],{windowsHide:true,stdio:'pipe'});if(r.status!==0)throw Error('Chrome Native Messaging 注册失败');}
 return {ok:true,installed:true,extensionPath:extension,extensionId:id,storePublished:false};
}
export async function run(argv){const [op='status',action,args]=argv;if(op==='native-host'){await nativeHost();return;}let result;if(op==='install')result=install();else if(op==='path')result={extensionPath:path.join(home,'extension')};else if(op==='status'){try{result=await request('status');}catch{result={ok:true,connected:false,enabled:false,installed:fs.existsSync(path.join(home,'extension','manifest.json'))};}}else if(op==='call'){result=await request(action,JSON.parse(args||'{}'));}else throw Error('Usage: tb browser install | status | path | call <tabs|read|click|type|navigate|open|close|screenshot> [JSON]');console.log(JSON.stringify(result));if(result.ok===false)process.exitCode=1;}
const mainPath=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
if(process.argv[1]&&mainPath(process.argv[1])===mainPath(fileURLToPath(import.meta.url)))run(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
