// Node 24: real Relay/Host, native desktop CLI JSON-lines contract, no GUI mocks.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:net';import {once} from 'node:events';
const dist=process.env.TB_TEST_DIST;if(!dist)throw Error('Set TB_TEST_DIST to the reviewed CLI dist');
const root=mkdtempSync(join(tmpdir(),'tb-native-desktop-'));const children=[];
const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const env={PATH:process.env.PATH,USER:process.env.USER,SHELL:'/bin/sh',TB_SECRET:'native-desktop-disposable-test',RELAY_URL:`ws://127.0.0.1:${port}`,PORT:String(port),HOST_ID:'native-test',TB_HERDR:'off',TB_BACKEND:'direct',TB_CONFIG:join(root,'config.json'),TB_SETTINGS:join(root,'settings.json'),TB_CONTEXT_STATE:join(root,'context.json'),TB_BRAIN_STATE:join(root,'brain.json'),TB_BRAIN_MEMORY:join(root,'memory.md'),TB_BRIDGE_SOCK:join(root,'bridge.sock'),TB_VOICE_LEARNING_DIR:join(root,'voice')};
writeFileSync(env.TB_SETTINGS,'{}');writeFileSync(env.TB_CONFIG,JSON.stringify({shell:'/bin/sh',agents:{'qa-shell':'/bin/cat'}}));
function launch(file,args=[]){const p=spawn(process.execPath,[join(dist,file),...args],{cwd:root,env,stdio:['pipe','pipe','pipe']});children.push(p);return p;}
async function boot(file,pattern){const p=launch(file);let text='';await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('boot timeout '+file)),10000);p.stdout.on('data',b=>{text+=b;if(pattern.test(text)){clearTimeout(timeout);resolve();}});p.stderr.on('data',()=>{});p.once('exit',()=>{clearTimeout(timeout);reject(Error('boot exited '+file));});});}
async function until(fn){for(let n=0;n<400;n++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('desktop response timeout');}
function desktop(){const p=launch('cli.js',['--host','native-test','desktop']);let buffer='';const events=[];p.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){events.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});p.stderr.on('data',b=>process.stderr.write(b));return{p,events,send:r=>p.stdin.write(JSON.stringify(r)+'\n')};}
try{
 await boot('relay.js',/listening/);await boot('host.js',/online as id=native-test/);
 const a=desktop();await until(()=>a.events.some(e=>e.event==='config'));
 assert.ok(a.events.find(e=>e.event==='config').agents.includes('qa-shell'));
 const cwd=join(root,'工作目录');mkdirSync(cwd);
 a.send({op:'resize',cols:73,rows:19}); // WebView measures before a terminal socket exists.
 a.send({op:'create',agent:'qa-shell',cwd});a.send({op:'create',agent:'qa-shell',cwd});
 await until(()=>a.events.some(e=>e.event==='attached'));const id=a.events.find(e=>e.event==='attached').sessionId;
 a.send({op:'refresh'});
 await until(()=>a.events.some(e=>e.event==='sessions'&&e.sessions.length===1));
 const created=a.events.filter(e=>e.event==='sessions'&&e.sessions.length===1).at(-1).sessions[0];
 assert.equal(created.cols,73,'Initial PTY width must match the measured WebView');
 assert.equal(created.rows,19,'Initial PTY height must match the measured WebView');
 a.send({op:'input',data:'中文_NATIVE_INPUT_OK\r'});
 await until(()=>a.events.filter(e=>e.event==='output').some(e=>Buffer.from(e.data,'base64').toString().includes('中文_NATIVE_INPUT_OK')));
 a.send({op:'resize',cols:97,rows:31});a.send({op:'refresh'});
 await until(()=>a.events.some(e=>e.event==='sessions'&&e.sessions.length===1&&e.sessions[0].cols===97));
 a.send({op:'attach',sessionId:id});
 a.send({op:'resize',cols:83,rows:23}); // Layout can change during the handshake.
 await until(()=>a.events.filter(e=>e.event==='attached').length===2);
 a.send({op:'refresh'});
 await until(()=>a.events.filter(e=>e.event==='sessions').at(-1)?.sessions[0]?.viewers===1);
 const reattached=a.events.filter(e=>e.event==='sessions').at(-1).sessions[0];
 assert.equal(reattached.cols,83,'Resize during attach must be replayed once the sid exists');
 assert.equal(reattached.rows,23);
 a.p.stdin.end();await once(a.p,'exit');
 const b=desktop();await until(()=>b.events.some(e=>e.event==='sessions'));
 assert.equal(b.events.find(e=>e.event==='sessions').sessions[0].sessionId,id,'Closing the UI must retain the Host session');
 b.send({op:'resize',cols:-1,rows:2});await until(()=>b.events.some(e=>e.event==='error'));
 b.p.stdin.end();await once(b.p,'exit');
 console.log('PASS: config/list/create once, Chinese input, resize, viewer cleanup, persisted session, invalid input rejection.');
}finally{for(const p of children.reverse())if(p.exitCode===null)p.kill('SIGTERM');await new Promise(r=>setTimeout(r,500));rmSync(root,{recursive:true,force:true});}
