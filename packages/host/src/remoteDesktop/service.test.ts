import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDesktop, desktopBase64, type ControlMessage, type DesktopPacket, type DesktopReady } from '@termbridge/protocol';
import { RemoteDesktopService } from './service.js';
import type { DesktopEvent } from './native.js';

const secret = 'remote-desktop-service-test-secret';
const eventually = async (check: () => boolean) => { for (let n = 0; n < 100 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
test('encrypted session owns native input, keeps first frame, and disconnect releases capture', async (t) => {
  const sent: ControlMessage[] = [], calls: string[] = [];
  const native = { onEvent: undefined as ((event: DesktopEvent) => void) | undefined,
    async request(op: string) {
      calls.push(op);
      if (op === 'start') {
        native.onEvent?.({ event: 'frame', generation: 4, width: 1280, height: 720, data: desktopBase64(new Uint8Array([255, 216, 255, 217])) });
        return { ok: true, data: { generation: 4, width: 1280, height: 720, displayId: 3 } };
      }
      return { ok: true, data: {} };
    }, async close() {}, async reset() { calls.push('stop'); },
  };
  const service = new RemoteDesktopService(native, { hostId: 'host', secret: () => secret, send: (_, msg) => sent.push(msg) });
  t.after(() => service.close());
  const client = await openDesktop(secret, 'host');
  service.handle(7, client.open);
  await eventually(() => sent.some(m => m.t === 'desktop_ready'));
  const cipher = await client.finish(sent.find(m => m.t === 'desktop_ready') as DesktopReady);
  const command = async (op: string) => service.handle(7, await cipher.seal(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ op }))])));
  await command('start'); await eventually(() => calls.includes('displays'));
  assert.equal((await service.local('key', {})).ok, false);
  assert.equal((await service.local('inspect', {})).ok, true);
  const rfb = Buffer.concat([Buffer.from([0]), Buffer.from('RFB 003.008\n'), Buffer.from([1,1,2,0,0,1,0,0,0,7,3,1,0,0,0,0,5,0,2,208])]);
  service.handle(7, await cipher.seal(rfb));
  await eventually(() => calls.includes('ack'));
  await eventually(() => sent.filter(m => m.t === 'desktop_data').length >= 7);
  const plaintext = [];
  for (const message of sent) if (message.t === 'desktop_data') plaintext.push(await cipher.open(message as DesktopPacket));
  assert.ok(plaintext.some(bytes => bytes[0] === 0 && bytes.includes(0x90)));
  service.drop(7);
  await eventually(() => calls.includes('stop'));
  assert.equal((await service.local('key', {})).ok, true);
});

test('disconnect during authentication invalidates the pending owner and never starts capture', async (t) => {
  const sent: ControlMessage[] = [], calls: string[] = [];
  const service = new RemoteDesktopService({ async request(op) { calls.push(op); return { ok: true }; }, async close() {}, async reset() { calls.push('stop'); } }, {
    hostId: 'host', secret: () => secret, send: (_, message) => sent.push(message),
  });
  t.after(() => service.close());
  const client = await openDesktop(secret, 'host');
  service.handle(7, client.open); service.drop(7);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, []); assert.deepEqual(sent, []);
});

test('attention highlights only: rejects invalid regions and ambiguous devices without any click', async (t) => {
  const calls: string[] = [], sent: Array<{ clientId: number; message: ControlMessage }> = [];
  const service = new RemoteDesktopService({ async request(op) { calls.push(op); return { ok: true }; }, async close() {}, async reset() { calls.push('stop'); } }, {
    hostId: 'host', secret: () => secret, send: (clientId, message) => sent.push({ clientId, message }),
  });
  t.after(() => service.close());
  assert.equal((await service.local('attention', { displayId: 3, region: { x: 0.9, y: 0, width: 0.5, height: 1 } })).ok, false);
  for (const [clientId, deviceId, foreground] of [[1, 'phone', false], [2, 'phone', true], [3, 'tablet', true]] as const) service.handle(clientId, { t: 'desktop_subscribe', deviceId, foreground });
  const args = { displayId: 3, region: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, title: 'Review this dialog' };
  assert.equal((await service.local('attention', args)).ok, false);
  assert.equal((await service.local('attention', { ...args, deviceId: 'phone' })).ok, true);
  assert.equal(sent.length, 1); assert.equal(sent[0].clientId, 2); assert.equal(sent[0].message.t, 'desktop_attention');
  assert.deepEqual(calls, []);
});

test('capture completing after disconnect cannot publish frames or resurrect input ownership', async (t) => {
  const sent: ControlMessage[] = [], calls: string[] = [];
  let finishStart: ((value: { ok: boolean; data: object }) => void) | undefined;
  const service = new RemoteDesktopService({ async request(op) {
    calls.push(op);
    if (op === 'start') return new Promise<{ ok: boolean; data: object }>(resolve => { finishStart = resolve; });
    return { ok: true, data: {} };
  }, async close() {}, async reset() { calls.push('stop'); } }, { hostId: 'host', secret: () => secret, send: (_, message) => sent.push(message) });
  t.after(() => service.close());
  const open = await openDesktop(secret, 'host'); service.handle(7, open.open);
  await eventually(() => sent.some(m => m.t === 'desktop_ready'));
  const cipher = await open.finish(sent.find(m => m.t === 'desktop_ready') as DesktopReady);
  service.handle(7, await cipher.seal(Buffer.concat([Buffer.from([1]), Buffer.from('{"op":"start"}')])));
  await eventually(() => !!finishStart);
  service.drop(7); const before = sent.length;
  finishStart!({ ok: true, data: { width: 1280, height: 720, displayId: 3, generation: 4 } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, before); assert.ok(calls.includes('stop'));
  assert.equal((await service.local('key', {})).ok, true);
});

test('system sharing stays inside encrypted ownership and never sends lock-screen input through CGEvent', async t => {
  const { default: net } = await import('node:net');
  const { SystemSharing } = await import('./systemSharing.js');
  let peer: import('node:net').Socket | undefined;
  const raw: Buffer[] = [];
  const server = net.createServer(socket => { peer = socket; socket.write('RFB 003.889\n'); socket.on('data', data => raw.push(data)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  class FixtureSharing extends SystemSharing {
    override connect(bytes: (data: Uint8Array) => Promise<void>, close: () => void) { return super.connect(bytes, close, port); }
  }
  const sent: ControlMessage[] = [], nativeCalls: string[] = [];
  const service = new RemoteDesktopService({ async request(op) { nativeCalls.push(op); return { ok: true, data: {} }; }, async reset() {}, async close() {} }, {
    hostId: 'host', secret: () => secret, send: (_, message) => sent.push(message), systemSharing: () => new FixtureSharing(),
  });
  t.after(async () => { await service.close(); peer?.destroy(); server.close(); });
  const open = await openDesktop(secret, 'host'); service.handle(7, open.open);
  await eventually(() => sent.some(m => m.t === 'desktop_ready'));
  const cipher = await open.finish(sent.find(m => m.t === 'desktop_ready') as DesktopReady);
  service.handle(7, await cipher.seal(Buffer.concat([Buffer.from([1]), Buffer.from('{"op":"start","backend":"system"}')])));
  await eventually(() => sent.filter(m => m.t === 'desktop_data').length >= 3);
  const payloads: Uint8Array[] = [];
  for (const packet of sent.filter(m => m.t === 'desktop_data')) payloads.push(await cipher.open(packet as DesktopPacket));
  assert.ok(payloads.some(bytes => bytes[0] === 0 && Buffer.from(bytes.subarray(1)).toString() === 'RFB 003.889\n'));
  const handshake = Buffer.from('RFB 003.008\n');
  service.handle(7, await cipher.seal(Buffer.concat([Buffer.from([0]), handshake])));
  await eventually(() => raw.length > 0);
  assert.deepEqual(Buffer.concat(raw), handshake);
  assert.equal((await service.local('key', { code: 36, down: true })).ok, false);
  assert.deepEqual(nativeCalls, []);
  service.drop(7); await eventually(() => peer!.destroyed);
});

test('a 20 MiB system framebuffer waits for each transport write and arrives intact', async t => {
  const { SystemSharing } = await import('./systemSharing.js');
  let emit: ((bytes: Uint8Array) => Promise<void>) | undefined;
  class Sharing extends SystemSharing {
    override async connect(onBytes: (bytes: Uint8Array) => Promise<void>) { emit = onBytes; return true; }
  }
  const sent: ControlMessage[] = [];
  let clientCipher: Awaited<ReturnType<Awaited<ReturnType<typeof openDesktop>>['finish']>>;
  let release: (() => void) | undefined, block = false, writes = 0, inFlight = 0, maxInFlight = 0, received = 0;
  const service = new RemoteDesktopService({ async request() { return { ok: true }; }, async close() {}, async reset() {} }, {
    hostId: 'host', secret: () => secret, systemSharing: () => new Sharing(), send: (_, message) => { sent.push(message); },
    async sendData(_, packet) {
      maxInFlight = Math.max(maxInFlight, ++inFlight); writes++;
      if (block) { block = false; await new Promise<void>(resolve => { release = resolve; }); }
      const plain = await clientCipher.open(packet);
      if (plain[0] === 0) { assert.ok(plain.subarray(1).every(byte => byte === 123)); received += plain.length - 1; }
      inFlight--;
    },
  });
  t.after(() => service.close());
  const open = await openDesktop(secret, 'host'); service.handle(7, open.open);
  await eventually(() => sent.some(m => m.t === 'desktop_ready'));
  clientCipher = await open.finish(sent.find(m => m.t === 'desktop_ready') as DesktopReady);
  service.handle(7, await clientCipher.seal(Buffer.concat([Buffer.from([1]), Buffer.from('{"op":"start","backend":"system"}')])));
  await eventually(() => !!emit && writes === 2 && inFlight === 0);
  block = true;
  const first = emit!(new Uint8Array(131072).fill(123));
  await eventually(() => !!release);
  assert.equal(writes, 3, 'Only one encrypted fragment can be in flight while the socket is congested');
  assert.equal(received, 0);
  release!(); await first;
  for (let remaining = 20 * 1024 * 1024 - 131072; remaining > 0; remaining -= 65536) await emit!(new Uint8Array(65536).fill(123));
  assert.equal(received, 20 * 1024 * 1024);
  assert.equal(maxInFlight, 1);
  assert.equal(sent.some(m => m.t === 'desktop_closed'), false);
});

test('late transport failure from a retired viewer cannot close its replacement', async t => {
  const { SystemSharing } = await import('./systemSharing.js');
  class Sharing extends SystemSharing { override async connect() { return true; } }
  const sent: ControlMessage[] = [];
  let fail: ((error: Error) => void) | undefined;
  const service = new RemoteDesktopService({ async request() { return { ok: true }; }, async close() {}, async reset() {} }, {
    hostId: 'host', secret: () => secret, systemSharing: () => new Sharing(), send: (_, message) => { sent.push(message); },
    sendData: () => new Promise<void>((_, reject) => { fail = reject; }),
  });
  t.after(() => service.close());
  const first = await openDesktop(secret, 'host'); service.handle(7, first.open);
  await eventually(() => sent.some(m => m.t === 'desktop_ready'));
  const cipher = await first.finish(sent.find(m => m.t === 'desktop_ready') as DesktopReady);
  service.handle(7, await cipher.seal(Buffer.concat([Buffer.from([1]), Buffer.from('{"op":"start","backend":"system"}')])));
  await eventually(() => !!fail);
  service.drop(7);
  const second = await openDesktop(secret, 'host'); service.handle(7, second.open);
  await eventually(() => sent.some(m => m.t === 'desktop_ready' && m.id === second.open.id));
  fail!(new Error('old socket failed'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.some(m => m.t === 'desktop_closed' && m.id === second.open.id), false);
});

test('viewer acknowledgements bound relay backlog and retirement releases a blocked writer', async t => {
  const { SystemSharing } = await import('./systemSharing.js');
  class Sharing extends SystemSharing { override async connect() { return true; } }
  const sent: ControlMessage[]=[];
  const service=new RemoteDesktopService({async request(){return {ok:true};},async reset(){},async close(){}},{
    hostId:'host',secret:()=>secret,systemSharing:()=>new Sharing(),send:(_,message)=>{sent.push(message);},
  });t.after(()=>service.close());
  const open=await openDesktop(secret,'host');service.handle(7,open.open);
  await eventually(()=>sent.some(m=>m.t==='desktop_ready'));
  const cipher=await open.finish(sent.find(m=>m.t==='desktop_ready') as DesktopReady);
  const command=async(value:object)=>service.handle(7,await cipher.seal(Buffer.concat([Buffer.from([1]),Buffer.from(JSON.stringify(value))])));
  await command({op:'start',backend:'system',flowControl:1});
  await eventually(()=>sent.filter(m=>m.t==='desktop_data').length===1);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(sent.filter(m=>m.t==='desktop_data').length,1,'No further data can pile up at the relay before the viewer receives the packet');
  const first=sent.find(m=>m.t==='desktop_data') as DesktopPacket;
  await cipher.open(first);await command({op:'ack',sequence:first.sequence});
  await eventually(()=>sent.filter(m=>m.t==='desktop_data').length===2);
  service.drop(7);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(sent.filter(m=>m.t==='desktop_closed').length,1);
});


test('a frame uses bounded pipelining instead of paying one network round trip per fragment', async t => {
  const { SystemSharing } = await import('./systemSharing.js');
  let emit!: (bytes: Uint8Array) => Promise<void>;
  class Sharing extends SystemSharing {
    override async connect(output: (bytes: Uint8Array) => Promise<void>) { emit = output; return true; }
  }
  const sent: ControlMessage[] = [];
  const service = new RemoteDesktopService({ async request() { return { ok: true }; }, async reset() {}, async close() {} }, {
    hostId: 'host', secret: () => secret, systemSharing: () => new Sharing(), send: (_, message) => { sent.push(message); },
  });
  t.after(() => service.close());
  const open = await openDesktop(secret, 'host'); service.handle(7, open.open);
  await eventually(() => sent.some(m => m.t === 'desktop_ready'));
  const cipher = await open.finish(sent.find(m => m.t === 'desktop_ready') as DesktopReady);
  const command = async (value: object) => service.handle(7, await cipher.seal(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))])));
  await command({ op: 'start', backend: 'system', flowControl: 1 });
  let cursor = 0, frameBytes = 0, rounds = 0;
  // Model an 80 ms network RTT: ACKs for every packet in a burst arrive together.
  async function acknowledgeBurst() {
    const burst = sent.filter(m => m.t === 'desktop_data').slice(cursor) as DesktopPacket[];
    assert.ok(burst.length <= 8, 'At most 512 KiB can be unacknowledged');
    cursor += burst.length;
    for (const packet of burst) {
      const plain = await cipher.open(packet);
      if (plain[0] === 0) { frameBytes += plain.length - 1; assert.ok(plain.subarray(1).every(b => b === 123)); }
      await command({ op: 'ack', sequence: packet.sequence });
    }
    return burst.length;
  }
  for (let n = 0; n < 5; n++) { await new Promise(resolve => setTimeout(resolve, 10)); await acknowledgeBurst(); }
  let finished = false;
  const delivery = emit(new Uint8Array(1024 * 1024).fill(123)).then(() => { finished = true; });
  const start = performance.now();
  while (!finished && rounds < 25) {
    await new Promise(resolve => setTimeout(resolve, 80));
    if (await acknowledgeBurst()) rounds++;
  }
  await delivery;
  t.diagnostic(JSON.stringify({ frameBytes, simulatedRttMs: 80, rounds, elapsedMs: Math.round(performance.now() - start) }));
  assert.equal(frameBytes, 1024 * 1024);
  assert.ok(rounds <= 3, `A 1 MiB frame took ${rounds} RTTs instead of three bounded bursts`);
  const blocked = emit(new Uint8Array(1024 * 1024).fill(123));
  await eventually(() => sent.filter(m => m.t === 'desktop_data').length - cursor === 8);
  service.drop(7);
  await blocked;
  assert.equal(sent.filter(m => m.t === 'desktop_closed').length, 1, 'Closing releases every outstanding acknowledgement');

});
