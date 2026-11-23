import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrTerminal } from './herdrTerminal.js';

test('native stream preserves cursor/bytes, resizes and releases without takeover', async () => {
 const dir=mkdtempSync(join(tmpdir(),'tb-native-'));
 const prior={bin:process.env.TB_HERDR_BIN,trace:process.env.TB_NATIVE_TEST_TRACE};
 process.env.TB_HERDR_BIN=resolve('scripts/fixtures/herdr-terminal.mjs');
 process.env.TB_NATIVE_TEST_TRACE=join(dir,'trace');
 let terminal: HerdrTerminal | undefined;
 try {
  const output: Buffer[]=[]; const closes:string[]=[];
  terminal=new HerdrTerminal({terminalId:'term-test',socketPath:'/tmp/isolated-herdr.sock',cols:81,rows:27,onData:d=>output.push(d),onClose:r=>closes.push(r)});
  assert.equal((await terminal.ready).toString(),'\x1b[2J\x1b[H NATIVE_READY\x1b[6;8H\x1b[?25l');
  terminal.activate();
  const bytes=Buffer.from('\x1b[200~中文\r\nhello\x1b[201~\r\x03\x1b[D');
  terminal.write(bytes); terminal.resize(97,31); terminal.scroll('up', 3); terminal.scroll('down', 2); terminal.scroll('up', 0);
  for(let n=0;n<100&&!Buffer.concat(output).includes('NATIVE_SIZE:97x31');n++) await delay(10);
  assert(Buffer.concat(output).includes('NATIVE_INPUT:'+bytes.toString('base64')));
  assert(Buffer.concat(output).includes('NATIVE_SIZE:97x31'));
  terminal.close(); terminal.close();
  for(let n=0;n<100&&!readFileSync(join(dir,'trace'),'utf8').includes('terminal.release');n++) await delay(10);
  const trace=readFileSync(join(dir,'trace'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(trace[0].args,['terminal','session','control','term-test','--cols','81','--rows','27']);
  assert.equal(trace[0].socket,'/tmp/isolated-herdr.sock');
  assert.equal(trace.filter(r=>r.type==='terminal.release').length,1);
  assert.deepEqual(trace.filter(r=>r.type==='terminal.scroll'), [
   ...Array.from({length:3},()=>({type:'terminal.scroll',source:'wheel',direction:'up',lines:1,column:48,row:15})),
   ...Array.from({length:2},()=>({type:'terminal.scroll',source:'wheel',direction:'down',lines:1,column:48,row:15})),
  ]);
  assert.deepEqual(closes,[]);
  const missing=new HerdrTerminal({terminalId:'missing',socketPath:'/tmp/isolated-herdr.sock',cols:80,rows:24,onData:()=>assert.fail('missing output'),onClose:()=>{}});
  await assert.rejects(missing.ready,/terminal not found/);
  const pending=new HerdrTerminal({terminalId:'waiting',socketPath:'/tmp/isolated-herdr.sock',cols:80,rows:24,onData:()=>{},onClose:()=>{}});
  pending.close(); await assert.rejects(pending.ready,/detached/);
 } finally {
  terminal?.close();
  if(prior.bin===undefined) delete process.env.TB_HERDR_BIN; else process.env.TB_HERDR_BIN=prior.bin;
  if(prior.trace===undefined) delete process.env.TB_NATIVE_TEST_TRACE; else process.env.TB_NATIVE_TEST_TRACE=prior.trace;
  // A pending fixture may still be shutting down; its trace is outside the repo.
  await delay(100); rmSync(dir,{recursive:true,force:true});
 }
});

test('native wheel reaches content and retains its amount before and after resize', async () => {
 const dir=mkdtempSync(join(tmpdir(),'tb-native-scroll-'));
 const prior=process.env.TB_HERDR_BIN;
 process.env.TB_HERDR_BIN=resolve('scripts/fixtures/herdr-terminal.mjs');
 const output: Buffer[]=[];
 const terminal=new HerdrTerminal({terminalId:'scroll',socketPath:'/tmp/isolated-herdr.sock',cols:100,rows:30,
  onData:d=>output.push(d),onClose:()=>{}});
 const reached=async (text:string) => {
  for(let n=0;n<100&&!Buffer.concat(output).includes(text);n++) await delay(10);
  assert(Buffer.concat(output).includes(text), `missing ${text}`);
  output.length=0;
 };
 try {
  await terminal.ready; terminal.activate();
  terminal.scroll('up',100); await reached('NATIVE_SCROLL_OFFSET:100');
  // Old coordinates would now fall outside the content area.
  terminal.resize(30,12); await reached('NATIVE_SIZE:30x12');
  for(let page=2;page<=10;page++) {
   terminal.scroll('up',100); await reached(`NATIVE_SCROLL_OFFSET:${page*100}`);
  }
  for(let page=9;page>=0;page--) {
   terminal.scroll('down',100); await reached(`NATIVE_SCROLL_OFFSET:${page*100}\x1b`);
  }
 } finally {
  terminal.close();
  if(prior===undefined) delete process.env.TB_HERDR_BIN; else process.env.TB_HERDR_BIN=prior;
  await delay(100); rmSync(dir,{recursive:true,force:true});
 }
});
