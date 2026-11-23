import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ROUND_LAYOUT } from '../page/home/round-layout.js'

const CENTER = 240
const SAFE_RADIUS = 226

test('startup paints an opaque full-screen background before status content', () => {
  assert.deepEqual(ROUND_LAYOUT.background, { x: 0, y: 0, w: 480, h: 480 })
})

test('startup does not pre-create conditional buttons', () => {
  const source = readFileSync(new URL('../page/home/index.page.js', import.meta.url), 'utf8')
  const buildStart = source.indexOf('    build() {')
  const buildEnd = source.indexOf('      this.prepareRecorder()', buildStart)
  assert.ok(buildStart >= 0 && buildEnd > buildStart, 'build section should be discoverable')
  assert.doesNotMatch(source.slice(buildStart, buildEnd), /hmUI\.widget\.BUTTON/)
})

function assertInsideRoundSafeArea(name, rect) {
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h]
  ]
  for (const [x, y] of corners) {
    const distance = Math.hypot(x - CENTER, y - CENTER)
    assert.ok(distance <= SAFE_RADIUS, `${name} corner ${x},${y} is ${distance.toFixed(1)}px from center`)
  }
}

test('all painted home controls fit the inset 480px round screen', () => {
  const boxes = [
    ['title', ROUND_LAYOUT.title],
    ['connection', ROUND_LAYOUT.connection],
    ['homeConnection', ROUND_LAYOUT.homeConnection],
    ['section', ROUND_LAYOUT.section],
    ...ROUND_LAYOUT.rows.map((rect, index) => [`row${index}`, rect]),
    ['detailTitle', ROUND_LAYOUT.detailTitle],
    ['detailSummary', ROUND_LAYOUT.detailSummary],
    ['voiceDetail', ROUND_LAYOUT.voiceDetail],
    ['secondary', ROUND_LAYOUT.secondary],
    ['confirmDiscard', ROUND_LAYOUT.confirmDiscard],
    ['confirmRewrite', ROUND_LAYOUT.confirmRewrite],
    ['primary', ROUND_LAYOUT.primary],
    ['micButton', ROUND_LAYOUT.micButton],
    ['micBody', ROUND_LAYOUT.micBody],
    ['micLeft', ROUND_LAYOUT.micLeft],
    ['micRight', ROUND_LAYOUT.micRight],
    ['micBridge', ROUND_LAYOUT.micBridge],
    ['micStem', ROUND_LAYOUT.micStem],
    ['micBase', ROUND_LAYOUT.micBase]
  ]
  boxes.forEach(([name, rect]) => assertInsideRoundSafeArea(name, rect))
})

test('interactive controls keep a usable touch target', () => {
  for (const [name, rect] of [
    ...ROUND_LAYOUT.rows.map((box, index) => [`row${index}`, box]),
    ['secondary', ROUND_LAYOUT.secondary],
    ['confirmDiscard', ROUND_LAYOUT.confirmDiscard],
    ['confirmRewrite', ROUND_LAYOUT.confirmRewrite],
    ['primary', ROUND_LAYOUT.primary],
    ['micButton', ROUND_LAYOUT.micButton]
  ]) {
    assert.ok(rect.w >= 104, `${name} is too narrow`)
    assert.ok(rect.h >= 46, `${name} is too short`)
  }
})
