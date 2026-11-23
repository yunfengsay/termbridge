import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachInput } from './attachInput.js';

test('Ctrl-C interrupts, Ctrl-] asks, Enter cancels, d detaches', () => {
 const input = new AttachInput();
 assert.deepEqual(input.feed(Buffer.from([3]), true), [{type:'input',data:Buffer.from([3])}]);
 assert.deepEqual(input.feed(Buffer.from([29]), true), [{type:'prompt'}]);
 assert.deepEqual(input.feed(Buffer.from('\r'), true), [{type:'cancel'}]);
 assert.deepEqual(input.feed(Buffer.from([29]), true), [{type:'prompt'}]);
 assert.deepEqual(input.feed(Buffer.from('d'), true), [{type:'detach'}]);
});
test('Ctrl-C while disconnected requires confirmation; another Ctrl-C cancels', () => {
 const input = new AttachInput();
 assert.deepEqual(input.feed(Buffer.from([3]), false), [{type:'prompt'}]);
 assert.deepEqual(input.feed(Buffer.from([3]), false), [{type:'cancel'}]);
});
test('fragmented bracketed paste preserves UTF-8 and local shortcut bytes', () => {
 const input = new AttachInput();
 const source = Buffer.from('\x1b[200~中文\r\n\x1d\x03text\x1b[201~');
 const output: Buffer[]=[];
 for (const byte of source) for (const event of input.feed(Buffer.from([byte]), true)) {
   assert.equal(event.type,'input'); if(event.type==='input') output.push(event.data);
 }
 assert.deepEqual(Buffer.concat(output),source);
 assert.deepEqual(input.feed(Buffer.from([29]), true), [{type:'prompt'}]);
 assert.deepEqual(input.feed(Buffer.from('\x1b[200~d\x1b[201~'), true), []);
 for (const byte of Buffer.from('\x1b[200~d\x1b[201~')) assert.deepEqual(input.feed(Buffer.from([byte]), true), []);
 assert.equal(input.confirming, true);
});
