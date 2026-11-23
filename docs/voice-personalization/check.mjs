// Read-only, dependency-free checks for this document and its synthetic demo.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(resolve(root, name), 'utf8');
const html = read('index.html');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate HTML IDs');

let checkedLinks = 0;
for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
  const target = match[1];
  if (/^https:\/\//.test(target)) continue;
  if (target.startsWith('#')) assert(ids.includes(target.slice(1)), `Missing anchor ${target}`);
  else assert(existsSync(resolve(root, target)), `Missing article asset ${target}`);
  checkedLinks++;
}
for (const name of ['README.md', 'plan.md', 'implementation.md', 'validation.md']) {
  for (const match of read(name).matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^https:\/\//.test(target)) continue;
    assert(existsSync(resolve(root, target.split('#')[0])), `Broken ${name} link: ${target}`);
    checkedLinks++;
  }
}

assert.match(html, /connect-src 'none'/, 'Document must block network connections');
assert.match(html, /合成数字 · 非真实 DDSD/, 'Synthetic demo disclaimer is required');
assert.match(html, /CAM\+\+ 本人校验仍关闭/, 'Current speaker verification limit must remain visible');
assert.match(html, /完整语义 DDSD 尚未验收/, 'Do not imply production completion');
assert.match(html, /长分句交接失败/, 'Failed live ablation must stay visible');
assert.match(read('plan.md'), /先预测计分，再按授权标签学习/, 'Online evaluation must avoid train/test leakage');
assert.match(read('plan.md'), /不能平均新旧权重/, 'Host and local-update conflict must be specified');
assert.match(read('article.css'), /prefers-reduced-motion/, 'Reduced-motion support is required');
assert.match(read('article.css'), /@media print/, 'Print layout is required');
for (const file of ['article.js', 'learning-demo.js']) {
  const source = read(file);
  assert(!/\b(fetch|XMLHttpRequest|WebSocket|getUserMedia|localStorage|sessionStorage)\s*[(.]/.test(source), `${file} must stay offline and memory-only`);
  new vm.Script(source, { filename: file });
}

const context = vm.createContext({});
new vm.Script(read('learning-demo.js')).runInContext(context, { timeout: 100 });
const demo = context.VoiceLearningDemo;
const baseline = demo.initial();
const before = demo.score(baseline);
const negative = demo.update(baseline, 0);
const positive = demo.update(baseline, 1);
assert(demo.score(negative) < before, 'Negative feedback must decrease the synthetic score');
assert(demo.score(positive) > before, 'Positive feedback must increase the synthetic score');
assert.equal(demo.score(baseline), before, 'Updates must not mutate the previous state');
assert.equal(demo.score(demo.initial()), before, 'Reset must restore baseline');
assert.throws(() => demo.update(baseline, 3), /binary label/);
let state = baseline;
for (let i = 0; i < 100; i++) state = demo.update(state, 0);
assert.equal(state.steps, demo.maxSteps, 'Demonstration update budget must be bounded');
assert(Number.isFinite(demo.score(state)) && demo.score(state) > 0 && demo.score(state) < 1);
assert(Math.abs(before - 0.598687660112452) < 1e-12, 'Golden baseline changed');
// First step has no regularization or clipping: z' = 0.4 - 0.25 * p * (1 + ||x||²).
assert(Math.abs(demo.score(negative) - 0.5217826280381015) < 1e-12, 'Golden first-step score changed');

const assets = readdirSync(resolve(root, 'assets')).filter(name => name.endsWith('.svg'));
for (const name of assets) {
  const svg = read(`assets/${name}`);
  assert.match(svg, /<title /);
  assert.match(svg, /<desc /);
  assert(!/<script|foreignObject|href="https?:/i.test(svg), `Unexpected active/external SVG content: ${name}`);
}
console.log(JSON.stringify({ result: 'pass', links: checkedLinks, diagrams: assets.length,
  syntheticBefore: before, syntheticAfter: demo.score(negative),
  scope: relative(process.cwd(), root), productionDDSDTested: false }, null, 2));
