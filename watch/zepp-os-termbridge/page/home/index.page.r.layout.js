import * as hmUI from '@zos/ui'
import { px } from '@zos/utils'

function box(layout) {
  return { x: px(layout.x), y: px(layout.y), w: px(layout.w), h: px(layout.h) }
}

// Keep this device-facing file self-contained. Some physical Zepp OS builds
// validate layout modules more strictly than the desktop compiler.
const ROUND_LAYOUT = {
  background: { x: 0, y: 0, w: 480, h: 480 },
  title: { x: 150, y: 34, w: 180, h: 42 },
  connection: { x: 104, y: 78, w: 272, h: 28 },
  homeConnection: { x: 116, y: 52, w: 248, h: 44 },
  section: { x: 84, y: 100, w: 312, h: 34 },
  rows: [
    { x: 62, y: 144, w: 356, h: 64 },
    { x: 48, y: 216, w: 384, h: 64 }
  ],
  detailTitle: { x: 76, y: 140, w: 328, h: 54 },
  detailSummary: { x: 76, y: 198, w: 328, h: 92 },
  voiceDetail: { x: 76, y: 150, w: 328, h: 140 },
  secondary: { x: 150, y: 300, w: 180, h: 46 },
  confirmDiscard: { x: 70, y: 302, w: 150, h: 48 },
  confirmRewrite: { x: 260, y: 302, w: 150, h: 48 },
  primary: { x: 112, y: 356, w: 256, h: 68 },
  micButton: { x: 188, y: 342, w: 104, h: 104 },
  micBody: { x: 228, y: 368, w: 24, h: 34 },
  micLeft: { x: 218, y: 384, w: 6, h: 18 },
  micRight: { x: 256, y: 384, w: 6, h: 18 },
  micBridge: { x: 218, y: 398, w: 44, h: 6 },
  micStem: { x: 237, y: 400, w: 6, h: 18 },
  micBase: { x: 226, y: 414, w: 28, h: 6 }
}

export const BACKGROUND = {
  ...box(ROUND_LAYOUT.background),
  color: 0x000000
}

export const TITLE = {
  ...box(ROUND_LAYOUT.title),
  text: '', color: 0xffffff, text_size: px(28),
  align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V
}

export const CONNECTION = {
  ...box(ROUND_LAYOUT.connection),
  text: '', color: 0x8c97a6, text_size: px(17),
  align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V
}

export const HOME_CONNECTION = {
  ...box(ROUND_LAYOUT.homeConnection),
  text: '正在连接手机…', color: 0x67d9ff, text_size: px(20),
  align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V
}

export const SECTION = {
  ...box(ROUND_LAYOUT.section),
  text: '', color: 0x74f0a7, text_size: px(20),
  align_h: hmUI.align.LEFT, align_v: hmUI.align.CENTER_V
}

export const ITEM_ROWS = ROUND_LAYOUT.rows.map((layout) => ({
  ...box(layout),
  text: '', radius: px(17), normal_color: 0x121920,
  press_color: 0x25313d, color: 0xffffff, text_size: px(18)
}))

export const DETAIL_TITLE = {
  ...box(ROUND_LAYOUT.detailTitle),
  text: '', color: 0xffffff, text_size: px(24),
  align_h: hmUI.align.LEFT, align_v: hmUI.align.CENTER_V,
  text_style: hmUI.text_style.WRAP
}

export const DETAIL_SUMMARY = {
  ...box(ROUND_LAYOUT.detailSummary),
  text: '', color: 0xc5ccd6, text_size: px(18),
  align_h: hmUI.align.LEFT, align_v: hmUI.align.TOP,
  text_style: hmUI.text_style.WRAP
}

export const VOICE_DETAIL = {
  ...box(ROUND_LAYOUT.voiceDetail),
  text: '', color: 0xc5d3df, text_size: px(18),
  align_h: hmUI.align.LEFT, align_v: hmUI.align.TOP,
  text_style: hmUI.text_style.WRAP
}

export const SECONDARY = {
  ...box(ROUND_LAYOUT.secondary),
  text: '', radius: px(23), normal_color: 0x151c24,
  press_color: 0x2a3643, color: 0xaeb7c4, text_size: px(18)
}

export const CONFIRM_DISCARD = {
  ...box(ROUND_LAYOUT.confirmDiscard),
  text: '放弃', radius: px(24), normal_color: 0x24191b,
  press_color: 0x4b272d, color: 0xf4a3ad, text_size: px(18)
}

export const CONFIRM_REWRITE = {
  ...box(ROUND_LAYOUT.confirmRewrite),
  text: '改写', radius: px(24), normal_color: 0x151c24,
  press_color: 0x2a3643, color: 0xd3dae5, text_size: px(18)
}

export const PRIMARY = {
  ...box(ROUND_LAYOUT.primary),
  text: '', radius: px(34), normal_color: 0x1c2b24,
  press_color: 0x315040, color: 0x74f0a7, text_size: px(21)
}

export const MIC_BUTTON = {
  ...box(ROUND_LAYOUT.micButton),
  text: '', radius: px(52), normal_color: 0x12a86b,
  press_color: 0x087d53, color: 0xffffff, text_size: px(1)
}

export const MIC_BODY = {
  ...box(ROUND_LAYOUT.micBody), radius: px(12), color: 0xffffff
}

export const MIC_LEFT = {
  ...box(ROUND_LAYOUT.micLeft), radius: px(3), color: 0xffffff
}

export const MIC_RIGHT = {
  ...box(ROUND_LAYOUT.micRight), radius: px(3), color: 0xffffff
}

export const MIC_BRIDGE = {
  ...box(ROUND_LAYOUT.micBridge), radius: px(3), color: 0xffffff
}

export const MIC_STEM = {
  ...box(ROUND_LAYOUT.micStem), radius: px(3), color: 0xffffff
}

export const MIC_BASE = {
  ...box(ROUND_LAYOUT.micBase), radius: px(3), color: 0xffffff
}
