import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { SystemFrames } from './systemFrames.js';
import { VisibleTiles } from './frameEncoding.js';

function rawFrame(width: number, height: number, color = [30,110,190,0]) {
  const bytes = Buffer.alloc(16 + width * height * 4); bytes.writeUInt16BE(1,2); bytes.writeUInt16BE(width,8); bytes.writeUInt16BE(height,10);
  for (let offset=16;offset<bytes.length;offset+=4) bytes.set(color,offset);
  return bytes;
}
function jpegPayload(frame: Buffer) {
  let at=17,length=frame[at]&127;
  if (frame[at++]&128) { length|=(frame[at]&127)<<7; if(frame[at++]&128)length|=frame[at++]<<14; }
  return frame.subarray(at,at+length);
}
test('large fragmented system pixels become bounded JPEG updates with correct colors and viewport coordinates', async () => {
  const frames: Buffer[]=[];
  const source=new SystemFrames(2560,1440,async bytes=>{frames.push(bytes);});
  source.setViewport({x:1000,y:400,width:640,height:360});
  const raw=rawFrame(2560,1440);
  for(let i=0;i<raw.length;i+=16381) await source.receive(raw.subarray(i,i+16381));
  assert.equal(frames.length,1);
  const frame=frames[0];assert.equal(frame.readUInt16BE(2),1);assert.equal(frame.readInt32BE(12),7);
  assert.equal(frame.readUInt16BE(4),1000);assert.equal(frame.readUInt16BE(6),400);
  assert.equal(frame.readUInt16BE(8),640);assert.equal(frame.readUInt16BE(10),360);
  const image=await sharp(jpegPayload(frame)).raw().toBuffer({resolveWithObject:true});
  assert.equal(image.info.width,640);assert.equal(image.info.height,360);
  for(const [i,expected] of [30,110,190].entries()) assert.ok(Math.abs(image.data[i]-expected)<=3);
  assert.ok(frame.length<raw.length/100);
  assert.equal(source.stats.frames,1);
});
test('retired compression emits no pixels and malformed rectangle bounds are rejected', async () => {
  const frames: Buffer[]=[];const source=new SystemFrames(512,512,async b=>{frames.push(b);});
  const encoding=source.receive(rawFrame(512,512));source.close();await encoding;assert.equal(frames.length,0);
  const invalid=new SystemFrames(256,256,async()=>{});
  await assert.rejects(invalid.receive(rawFrame(512,512)),/bounds/);
});
test('native tile cache sends no unchanged images and only the changed visible tile', async () => {
  const tiles=new VisibleTiles(), width=512,height=512;
  const pixels=Buffer.alloc(width*height*3,120);
  const encode=()=>sharp(pixels,{raw:{width,height,channels:3}}).jpeg({quality:95}).toBuffer();
  const viewport={x:0,y:0,width:256,height:512};
  const image=await encode();
  assert.equal((await tiles.encode(image,width,height,viewport,false)).length,2);
  assert.equal((await tiles.encode(image,width,height,viewport,true)).length,0);
  for(let y=80;y<144;y++)pixels.fill(230,(y*width+80)*3,(y*width+144)*3);
  const changed=await tiles.encode(await encode(),width,height,viewport,true);
  assert.equal(changed.length,1);assert.equal(changed[0].readUInt16BE(0),0);assert.equal(changed[0].readUInt16BE(2),0);
  const panned=await tiles.encode(await encode(),width,height,{x:256,y:0,width:256,height:512},true);
  assert.equal(panned.length,2);assert.ok(panned.every(rect=>rect.readUInt16BE(0)===256));
});


test('clearing a native capture during asynchronous encoding cannot seed the replacement tile cache', async () => {
  const tiles = new VisibleTiles();
  const image = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#345678' } }).jpeg().toBuffer();
  const viewport = { x: 0, y: 0, width: 512, height: 512 };
  const old = tiles.encode(image, 512, 512, viewport, true);
  tiles.clear();
  assert.deepEqual(await old, []);
  assert.equal((await tiles.encode(image, 512, 512, viewport, true)).length, 4);
});
