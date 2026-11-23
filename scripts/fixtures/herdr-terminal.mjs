#!/usr/bin/env node
// A deterministic native controller used only by the isolated tests.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const terminal = args[3];
let cols = Number(args[5]), rows = Number(args[7]), offset = 0;
const frame = (text) => console.log(JSON.stringify({type:'terminal.frame',encoding:'ansi',bytes:Buffer.from(text).toString('base64')}));
if (process.env.TB_NATIVE_TEST_TRACE) appendFileSync(process.env.TB_NATIVE_TEST_TRACE, JSON.stringify({args,socket:process.env.HERDR_SOCKET_PATH})+'\n');
if (terminal === 'missing') {
 console.log(JSON.stringify({type:'terminal.closed',reason:'terminal not found'}));
 process.exit(0);
}
if (terminal !== 'waiting') frame('\x1b[2J\x1b[H NATIVE_READY\x1b[6;8H\x1b[?25l');
createInterface({input:process.stdin}).on('line', line => {
 const message=JSON.parse(line);
 if (process.env.TB_NATIVE_TEST_TRACE) appendFileSync(process.env.TB_NATIVE_TEST_TRACE,line+'\n');
 if (message.type === 'terminal.input') frame('NATIVE_INPUT:'+message.bytes+'\x1b[6;8H\x1b[?25l');
 if (message.type === 'terminal.resize') {
  cols=message.cols; rows=message.rows;
  frame(`NATIVE_SIZE:${cols}x${rows}\x1b[6;8H\x1b[?25l`);
 }
 // Herdr's mouse-report route emits one wheel event per command, regardless
 // of lines. Codex ignores a wheel over its fixed header/footer regions.
 if (message.type === 'terminal.scroll' && message.column > 0 && message.column < cols
     && message.row > 0 && message.row < rows - 3) {
  offset=Math.max(0, Math.min(5000, offset + (message.direction === 'up' ? 1 : -1)));
  frame(`NATIVE_SCROLL_OFFSET:${offset}\x1b[6;8H\x1b[?25l`);
 }
 if (message.type === 'terminal.release') {console.log(JSON.stringify({type:'terminal.closed',reason:'detached'}));process.exit(0);}
}).on('close',()=>process.exit(0));
