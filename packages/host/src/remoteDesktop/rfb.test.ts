import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopRfb, type RfbInput } from './rfb.js';

function fixture() {
  const output: Buffer[] = [], input: RfbInput[] = [], errors: string[] = [];
  const rfb = new DesktopRfb(1280, 720, { send: b => output.push(b), input: e => input.push(e), close: e => errors.push(e) });
  const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1, 2, 0, 0, 2, 0, 0, 0, 7, 255, 255, 255, 33])]);
  for (const byte of handshake) rfb.receive(Buffer.from([byte]));
  return { rfb, output, input, errors };
}
const update = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 2, 208]);

test('fragmented noVNC handshake negotiates Tight and frames wait for consumer demand', () => {
  const { rfb, output, errors } = fixture();
  assert.deepEqual(errors, []); assert.equal(output.length, 4);
  assert.equal(output[3].readUInt16BE(0), 1280);
  let consumed = 0; const jpeg = Buffer.alloc(17_000, 42);
  rfb.offerFrame(1280, 720, jpeg, () => consumed++);
  assert.equal(consumed, 0); assert.equal(output.length, 4);
  rfb.receive(update);
  assert.equal(consumed, 1); const frame = output[4];
  assert.equal(frame.readUInt16BE(2), 1); assert.equal(frame.readInt32BE(12), 7); assert.equal(frame[16], 0x90);
  assert.deepEqual(frame.subarray(20), jpeg);
  rfb.offerFrame(800, 600, Buffer.from([255, 216, 255, 217]), () => consumed++);
  rfb.receive(update);
  assert.equal(output[5].readUInt16BE(2), 2); assert.equal(output[5].readInt32BE(12), -223);
  assert.equal(consumed, 2);
});

test('mouse button transitions preserve dragging and right click with correct pixel normalization', () => {
  const { rfb, input } = fixture();
  for (const mask of [1, 1, 0, 4, 0]) rfb.receive(Buffer.from([5, mask, 4, 255, 2, 207]));
  const buttons = input.filter(e => e.args.action === 'down' || e.args.action === 'up');
  assert.deepEqual(buttons.map(e => [e.args.action, e.args.button]), [['down', 0], ['up', 0], ['down', 1], ['up', 1]]);
  assert.equal(buttons[0].args.x, 1); assert.equal(buttons[0].args.y, 1);
  rfb.receive(Buffer.from([5, 1, 0, 10, 0, 10])); rfb.resetInput();
  const before = input.filter(e => e.args.action === 'down').length;
  rfb.receive(Buffer.from([5, 1, 0, 10, 0, 10]));
  assert.equal(input.filter(e => e.args.action === 'down').length, before + 1);
});

test('keyboard preserves Command shortcut and Unicode and refuses malformed clipboard lengths', () => {
  const { rfb, input, errors } = fixture();
  for (const [symbol, down] of [[0xffeb, 1], [99, 1], [99, 0], [0xffeb, 0], [0x01004e2d, 1]]) {
    const msg = Buffer.from([4, down, 0, 0, 0, 0, 0, 0]); msg.writeUInt32BE(symbol, 4); rfb.receive(msg);
  }
  assert.deepEqual(input.map(e => e.args), [{code:55,down:true},{code:8,down:true},{code:8,down:false},{code:55,down:false},{text:'中'}]);
  rfb.receive(Buffer.from([6, 0, 0, 0, 255, 255, 255, 255]));
  assert.equal(errors.length, 1);
  const n = input.length; rfb.receive(Buffer.from([5, 1, 0, 0, 0, 0])); assert.equal(input.length, n);
});
