import * as hmUI from '@zos/ui'
import { codec, create, id } from '@zos/media'
import { readFileSync, rmSync } from '@zos/fs'
import { KEY_BACK, KEY_EVENT_CLICK, offKey, onKey } from '@zos/interaction'
import { BasePage } from '@zeppos/zml/base-page'
import { log as Logger } from '@zos/utils'
import { ACTION_POLL_MS, REFRESH_MS, VOICE_POLL_MS } from '../../shared/protocol'
import { packVoicePayload } from '../../shared/voice-payload'
import { isAttentionStatus, sortWorkInbox } from './work-inbox'
import { actionsForStatus } from './work-actions'
import {
  VOICE_STATUS_DEADLINE_MS,
  VOICE_TURN_DEADLINE_MS,
  VOICE_UPLOAD_DEADLINE_MS,
  formatRecordingElapsed,
  voiceIsTerminal,
  voiceNeedsConfirmation,
  voiceTargetLabel,
  withDeadline
} from './voice-flow'
import {
  BACKGROUND, TITLE, CONNECTION, HOME_CONNECTION, SECTION, ITEM_ROWS, DETAIL_TITLE, DETAIL_SUMMARY,
  VOICE_DETAIL, SECONDARY, CONFIRM_DISCARD, CONFIRM_REWRITE, PRIMARY,
  MIC_BUTTON, MIC_BODY, MIC_LEFT, MIC_RIGHT, MIC_BRIDGE, MIC_STEM, MIC_BASE
} from 'zosLoader:./index.page.[pf].layout.js'

const logger = Logger.getLogger('termbridge-home')

Page(
  BasePage({
    state: {
      background: null,
      title: null,
      connection: null,
      homeConnection: null,
      section: null,
      rows: [],
      detailTitle: null,
      detailSummary: null,
      voiceDetail: null,
      secondaryButton: null,
      confirmDiscardButton: null,
      confirmRewriteButton: null,
      primaryButton: null,
      micButton: null,
      micParts: [],
      timer: null,
      voiceTimer: null,
      recordElapsedTimer: null,
      recordTimer: null,
      recorder: null,
      refreshing: false,
      recording: false,
      voiceMode: false,
      voicePending: false,
      voicePollInFlight: false,
      voiceDecisionPending: false,
      voiceId: '',
      voiceOperation: 0,
      voiceDeadlineAt: 0,
      handoffPending: false,
      actionTimer: null,
      actionId: '',
      actionPending: false,
      actionPollInFlight: false,
      actionDeadlineAt: 0,
      actionOperation: 0,
      actionsPage: 0,
      recordStartedAt: 0,
      snapshot: null,
      screen: 'home',
      returnScreen: 'home',
      agentsPage: 0,
      selected: null
    },
    build() {
      logger.log('[TBWATCH] build 0.6.7 lazy-startup-controls')
      this.state.background = hmUI.createWidget(hmUI.widget.FILL_RECT, BACKGROUND)
      this.state.title = hmUI.createWidget(hmUI.widget.TEXT, {
        ...TITLE,
        visible: false
      })
      this.state.connection = hmUI.createWidget(hmUI.widget.TEXT, {
        ...CONNECTION,
        visible: false
      })
      this.state.homeConnection = hmUI.createWidget(hmUI.widget.TEXT, {
        ...HOME_CONNECTION,
        visible: true
      })
      this.state.section = hmUI.createWidget(hmUI.widget.TEXT, {
        ...SECTION,
        visible: false
      })
      this.state.rows = ITEM_ROWS.map(() => null)
      this.state.detailTitle = hmUI.createWidget(hmUI.widget.TEXT, {
        ...DETAIL_TITLE,
        visible: false
      })
      this.state.detailSummary = hmUI.createWidget(hmUI.widget.TEXT, {
        ...DETAIL_SUMMARY,
        visible: false
      })
      this.state.voiceDetail = hmUI.createWidget(hmUI.widget.TEXT, {
        ...VOICE_DETAIL,
        visible: false
      })
      this.prepareRecorder()
      onKey({
        callback: (key, event) => {
          if (key === KEY_BACK && event === KEY_EVENT_CLICK && this.state.screen !== 'home') {
            this.goBack()
            return true
          }
          return false
        }
      })
      this.refresh()
      this.state.timer = setInterval(() => this.refresh(), REFRESH_MS)
    },
    prepareRecorder() {
      try {
        const recorder = create(id.RECORDER)
        recorder.addEventListener(recorder.event.START, (result) => {
          logger.log(`[TBWATCH] recorder START result=${Boolean(result)} status=${safeRecorderStatus(recorder)}`)
          if (!result) {
            this.state.recording = false
            this.renderVoiceError('录音启动失败')
            return
          }
          this.state.recording = true
          this.state.recordStartedAt = Date.now()
          this.setPrimary('完成录音')
          this.renderVoiceState('录音中 · 00:00', '正在采集手表麦克风\n说完后再点一次麦克风\n录音会先交给手机识别', true)
          this.startRecordingClock()
          this.state.recordTimer = setTimeout(() => this.stopRecording(), MAX_RECORD_MS)
        })
        recorder.addEventListener(recorder.event.STOP, () => {
          logger.log(`[TBWATCH] recorder STOP status=${safeRecorderStatus(recorder)}`)
          this.state.recording = false
          this.stopRecordingClock()
          if (this.state.recordTimer) clearTimeout(this.state.recordTimer)
          this.state.recordTimer = null
          this.uploadRecording()
        })
        this.state.recorder = recorder
        logger.log(`[TBWATCH] recorder created status=${safeRecorderStatus(recorder)}`)
      } catch (error) {
        this.state.recorder = null
        logger.error(`[TBWATCH] recorder create failed ${safeError(error)}`)
      }
    },
    onPrimary() {
      if (this.state.screen === 'error') {
        this.refresh()
        return
      }
      if (this.state.screen === 'agents') {
        const pageCount = this.agentPageCount()
        this.state.agentsPage = pageCount > 1 ? (this.state.agentsPage + 1) % pageCount : 0
        this.renderAgents()
        return
      }
      if (this.state.screen === 'actions') {
        const pageCount = this.actionPageCount()
        this.state.actionsPage = pageCount > 1 ? (this.state.actionsPage + 1) % pageCount : 0
        this.renderActions()
        return
      }
      if (this.state.screen === 'action-status') {
        if (this.state.actionPending) this.stopWaitingForAction()
        else this.goBack()
        return
      }
      if (this.state.screen === 'voice-confirm') {
        this.submitVoiceDecision('confirm')
        return
      }
      if (this.state.screen === 'voice' && this.state.voicePending) {
        this.stopWaitingForVoice()
        return
      }
      this.toggleVoice()
    },
    onSecondary() {
      if (this.state.recording) return
      if (this.state.screen === 'home') {
        this.state.screen = 'agents'
        this.state.agentsPage = 0
        this.renderAgents()
        return
      }
      if (this.state.screen === 'voice') {
        this.exitVoice()
        return
      }
      if (this.state.screen === 'voice-confirm') {
        this.submitVoiceDecision('discard')
        return
      }
      if (this.state.screen === 'detail') {
        this.state.screen = 'actions'
        this.state.actionsPage = 0
        this.renderActions()
        return
      }
      if (this.state.screen === 'actions' || this.state.screen === 'action-status') {
        this.goBack()
        return
      }
      this.state.screen = 'home'
      this.state.selected = null
      this.renderHome()
    },
    goBack() {
      if (this.state.recording) return
      if (this.state.screen === 'voice-confirm') {
        this.submitVoiceDecision('discard')
        return
      }
      if (this.state.screen === 'voice') {
        this.exitVoice()
        return
      }
      if (this.state.screen === 'detail' && this.state.selected && this.state.selected.source === 'agents') {
        this.state.screen = 'agents'
        this.state.selected = null
        this.renderAgents()
        return
      }
      if ((this.state.screen === 'actions' || this.state.screen === 'action-status') && this.state.selected) {
        if (this.state.screen === 'action-status' && this.state.actionPending) this.dismissActionPolling()
        this.state.screen = 'detail'
        this.renderDetail(this.state.selected.item)
        return
      }
      this.state.screen = 'home'
      this.state.selected = null
      this.renderHome()
    },
    requestPhoneHandoff() {
      const item = this.state.selected && this.state.selected.item
      const sessionId = item && String(item.sessionId || '')
      if (!sessionId || this.state.handoffPending) return
      this.state.actionOperation += 1
      const operation = this.state.actionOperation
      this.state.handoffPending = true
      this.state.actionPending = true
      this.renderActionState('手机接力', '正在通知手机…', true)
      this.request({ method: 'OPEN_SESSION', params: { sessionId } })
        .then((result) => {
          if (operation !== this.state.actionOperation) return
          if (result.kind === 'handoff' && result.opened) {
            this.state.actionPending = false
            this.renderActionState('手机接力', '已发送到手机通知\n点通知继续当前任务', false)
          } else if (result.kind === 'pairing_required' || result.kind === 'pairing_rejected') {
            this.state.actionPending = false
            this.renderActionState('手机接力失败', '需要重新配对手机', false, true)
          } else {
            this.state.actionPending = false
            this.renderActionState('手机接力失败', '手机交接失败，请重试', false, true)
          }
        })
        .catch(() => {
          if (operation === this.state.actionOperation) {
            this.state.actionPending = false
            this.renderActionState('手机接力失败', '手机桥未连接', false, true)
          }
        })
        .finally(() => {
          if (operation === this.state.actionOperation) this.state.handoffPending = false
        })
    },
    openRow(index) {
      let item
      let source
      if (this.state.screen === 'home') {
        item = this.sortedAlerts()[index]
        source = 'home'
      } else if (this.state.screen === 'agents') {
        item = this.agents()[this.state.agentsPage * AGENTS_PER_PAGE + index]
        source = 'agents'
      } else if (this.state.screen === 'actions') {
        const action = this.currentActionItems()[index]
        if (action) this.executeAction(action.id)
        return
      }
      if (!item) return
      this.state.selected = { source, id: itemIdentity(item), item }
      this.state.returnScreen = source
      this.state.screen = 'detail'
      this.renderDetail(item)
    },
    executeAction(action) {
      const item = this.state.selected && this.state.selected.item
      const sessionId = item && String(item.sessionId || '')
      if (!sessionId) return
      if (action === 'handoff') {
        this.requestPhoneHandoff()
        return
      }
      this.state.actionOperation += 1
      const operation = this.state.actionOperation
      this.state.actionPending = true
      this.state.actionPollInFlight = false
      this.state.actionId = ''
      this.state.actionDeadlineAt = Date.now() + ACTION_TURN_DEADLINE_MS
      this.renderActionState(actionLabel(action), '正在发送到手机…', true)
      this.request({ method: 'SUBMIT_ACTION', params: { action, sessionId } })
        .then((result) => {
          if (operation !== this.state.actionOperation) return
          if (result.kind !== 'action') {
            this.renderActionError(actionErrorLabel(result && result.error))
            return
          }
          this.state.actionId = result.snapshot.actionId
          this.renderActionSnapshot(result.snapshot)
          if (result.snapshot.state === 'done' || result.snapshot.state === 'error') return
          this.pollAction()
          this.state.actionTimer = setInterval(() => this.pollAction(), ACTION_POLL_MS)
        })
        .catch(() => {
          if (operation === this.state.actionOperation) this.renderActionError('手机桥未连接')
        })
    },
    pollAction() {
      if (!this.state.actionId || this.state.actionPollInFlight) return
      if (Date.now() >= this.state.actionDeadlineAt) {
        this.renderActionError('操作超过 2 分钟，请稍后查看')
        return
      }
      const operation = this.state.actionOperation
      this.state.actionPollInFlight = true
      this.request({ method: 'ACTION_STATUS', params: { actionId: this.state.actionId } })
        .then((result) => {
          if (operation !== this.state.actionOperation) return
          if (result.kind !== 'action') {
            this.renderActionError(actionErrorLabel(result && result.error))
            return
          }
          this.renderActionSnapshot(result.snapshot)
        })
        .catch(() => {
          if (operation === this.state.actionOperation) this.renderActionError('手机连接中断')
        })
        .finally(() => {
          if (operation === this.state.actionOperation) this.state.actionPollInFlight = false
        })
    },
    renderActionSnapshot(snapshot) {
      const terminal = snapshot.state === 'done' || snapshot.state === 'error'
      if (terminal && this.state.actionTimer) clearInterval(this.state.actionTimer)
      if (terminal) this.state.actionTimer = null
      this.state.actionPending = !terminal
      if (snapshot.state === 'error') {
        this.renderActionError(actionErrorLabel(snapshot.error))
        return
      }
      this.renderActionState(
        snapshot.state === 'done' ? '操作完成' : actionLabel(snapshot.action),
        snapshot.summary || 'Global 正在处理',
        !terminal
      )
    },
    renderActionError(message) {
      if (this.state.actionTimer) clearInterval(this.state.actionTimer)
      this.state.actionTimer = null
      this.state.actionPending = false
      this.renderActionState('操作失败', message, false, true)
    },
    renderActionState(title, summary, pending, isError = false) {
      this.state.screen = 'action-status'
      this.showStandardChrome()
      this.hideRows()
      this.state.title.setProperty(hmUI.prop.TEXT, title)
      this.state.connection.setProperty(hmUI.prop.TEXT, pending ? 'Global 正在处理' : isError ? '未完成' : '已有回执')
      this.state.connection.setProperty(hmUI.prop.COLOR, isError ? 0xf4b860 : 0x74f0a7)
      this.state.section.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailTitle.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailSummary.setProperty(hmUI.prop.VISIBLE, true)
      this.state.detailSummary.setProperty(hmUI.prop.TEXT, compact(summary, 160))
      this.state.detailSummary.setProperty(hmUI.prop.COLOR, 0xffffff)
      this.state.voiceDetail.setProperty(hmUI.prop.VISIBLE, false)
      this.showSecondary('返回详情')
      this.showPrimary(pending ? '停止等待' : '完成')
    },
    stopWaitingForAction() {
      this.dismissActionPolling()
      this.renderActionState('已停止等待', '操作可能仍在手机或 Global 中继续\n可稍后查看手机历史', false)
    },
    dismissActionPolling() {
      this.state.actionOperation += 1
      this.state.actionPending = false
      this.state.handoffPending = false
      this.state.actionId = ''
      if (this.state.actionTimer) clearInterval(this.state.actionTimer)
      this.state.actionTimer = null
    },
    toggleVoice() {
      if (this.state.recording) {
        this.stopRecording()
        return
      }
      if (this.state.screen !== 'voice') this.state.returnScreen = this.state.screen
      this.state.screen = 'voice'
      this.state.voiceMode = true
      this.state.voicePending = false
      this.state.voiceOperation += 1
      this.state.voicePollInFlight = false
      this.state.voiceDecisionPending = false
      this.state.voiceDeadlineAt = 0
      this.stopRecordingClock()
      if (!this.state.recorder) {
        this.renderVoiceError('此设备不能录音')
        return
      }
      if (this.state.voiceTimer) clearInterval(this.state.voiceTimer)
      this.state.voiceTimer = null
      this.state.voiceId = ''
      try {
        try {
          rmSync({ path: VOICE_FILE })
        } catch (_) {
          // The first recording has no previous file to remove.
        }
        this.state.recorder.setFormat(codec.OPUS, { target_file: VOICE_FILE })
        logger.log(`[TBWATCH] recorder start requested status=${safeRecorderStatus(this.state.recorder)}`)
        this.state.recorder.start()
        this.renderVoiceState('正在启动录音', '正在申请手表麦克风\n准备完成后直接说话')
        this.setPrimary('正在启动…')
      } catch (error) {
        logger.error(`[TBWATCH] recorder start failed ${safeError(error)}`)
        this.renderVoiceError('录音启动失败')
      }
    },
    stopRecording() {
      if (!this.state.recorder || !this.state.recording) return
      this.stopRecordingClock()
      this.renderVoiceState('正在保存录音', '正在封装手表录音\n下一步传到手机进行语音识别')
      this.setPrimary('请稍候…')
      try {
        this.state.recorder.stop()
      } catch (error) {
        logger.error(`[TBWATCH] recorder stop failed ${safeError(error)}`)
        this.state.recording = false
        this.renderVoiceError('录音保存失败')
      }
    },
    uploadRecording() {
      this.stopRecordingClock()
      this.state.voicePending = true
      this.state.voicePollInFlight = false
      const operation = this.state.voiceOperation + 1
      this.state.voiceOperation = operation
      this.renderVoiceState('正在传到手机', '录音已经完成\n手机确认收到后开始语音识别\n最长等待 12 秒')
      this.setPrimary('停止等待')
      let payload
      try {
        const buffer = readFileSync({ path: VOICE_FILE })
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 64 || buffer.byteLength > MAX_OPUS_BYTES) {
          throw new Error('invalid recording')
        }
        const sourceSessionId = this.state.selected && this.state.selected.item
          ? String(this.state.selected.item.sessionId || '')
          : ''
        payload = packVoicePayload(buffer, sourceSessionId)
        logger.log(`[TBWATCH] voice packet bytes=${payload.byteLength} contextual=${Boolean(sourceSessionId)}`)
      } catch (error) {
        logger.error(`[TBWATCH] voice file read failed ${safeError(error)}`)
        this.renderVoiceError('读取录音失败')
        return
      }
      withDeadline(
        this.request(payload, { contentType: 'bin', dataType: 'json', timeout: VOICE_UPLOAD_DEADLINE_MS }),
        VOICE_UPLOAD_DEADLINE_MS
      )
        .then((result) => {
          if (operation !== this.state.voiceOperation) return
          logger.log(`[TBWATCH] voice upload kind=${String(result && result.kind || '')} state=${String(result && result.snapshot && result.snapshot.state || '')}`)
          if (result.kind !== 'voice') {
            this.renderBridgeError(result)
            return
          }
          this.state.voiceId = result.snapshot.voiceId
          this.state.voiceDeadlineAt = Date.now() + VOICE_TURN_DEADLINE_MS
          this.renderVoiceSnapshot(result.snapshot)
          if (voiceIsTerminal(result.snapshot.state) || voiceNeedsConfirmation(result.snapshot.state)) return
          this.pollVoice()
          this.state.voiceTimer = setInterval(() => this.pollVoice(), VOICE_POLL_MS)
        })
        .catch((error) => {
          if (operation !== this.state.voiceOperation) return
          logger.error(`[TBWATCH] voice upload failed ${safeError(error)}`)
          this.renderVoiceError(
            error && error.message === 'deadline_exceeded'
              ? '手机 12 秒内没有确认\n请检查 Zepp 与 TermBridge'
              : '发送失败，请重试'
          )
        })
    },
    pollVoice() {
      if (!this.state.voiceId || this.state.voicePollInFlight) return
      if (this.state.voiceDeadlineAt && Date.now() >= this.state.voiceDeadlineAt) {
        this.renderVoiceError('Global 处理超过 2 分钟\n请重试')
        return
      }
      const operation = this.state.voiceOperation
      this.state.voicePollInFlight = true
      withDeadline(
        this.request({ method: 'VOICE_STATUS', params: { voiceId: this.state.voiceId } }),
        VOICE_STATUS_DEADLINE_MS
      )
        .then((result) => {
          if (operation !== this.state.voiceOperation) return
          if (result.kind !== 'voice') {
            this.renderBridgeError(result)
            return
          }
          this.renderVoiceSnapshot(result.snapshot)
          if (voiceIsTerminal(result.snapshot.state) || voiceNeedsConfirmation(result.snapshot.state)) {
            if (this.state.voiceTimer) clearInterval(this.state.voiceTimer)
            this.state.voiceTimer = null
          }
        })
        .catch(() => {
          if (operation === this.state.voiceOperation) this.renderVoiceError('手机连接中断\n请重试')
        })
        .finally(() => {
          if (operation === this.state.voiceOperation) this.state.voicePollInFlight = false
        })
    },
    renderVoiceSnapshot(snapshot) {
      const state = String(snapshot.state || '')
      if (voiceNeedsConfirmation(state)) {
        this.renderVoiceConfirmation(snapshot)
        return
      }
      this.renderVoiceState(
        voiceStateLabel(state),
        voiceProgressDetail(snapshot, state, this.voiceContextLabel())
      )
      if (state === 'done') this.setPrimary('继续说')
      else if (state === 'error') this.renderVoiceError(voiceErrorLabel(snapshot.error))
      else this.setPrimary('停止等待')
      if (state === 'done') this.state.voicePending = false
    },
    renderVoiceConfirmation(snapshot) {
      this.state.screen = 'voice-confirm'
      this.state.voicePending = false
      this.state.voiceDecisionPending = false
      if (this.state.voiceTimer) clearInterval(this.state.voiceTimer)
      this.state.voiceTimer = null
      this.showCompactChrome(connectedDeviceLabel(this.state.snapshot), 0x67d9ff, false)
      this.hideRows()
      this.state.section.setProperty(hmUI.prop.VISIBLE, true)
      this.state.section.setProperty(hmUI.prop.TEXT, '识别完成 · 请确认')
      this.state.section.setProperty(hmUI.prop.COLOR, 0x74f0a7)
      this.state.detailTitle.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailSummary.setProperty(hmUI.prop.VISIBLE, false)
      this.state.voiceDetail.setProperty(hmUI.prop.VISIBLE, true)
      this.state.voiceDetail.setProperty(hmUI.prop.TEXT, compact(snapshot.transcript || '没有识别到文字', 180))
      this.state.voiceDetail.setProperty(hmUI.prop.COLOR, 0xffffff)
      this.hideSecondary()
      this.ensureVoiceDecisionButtons()
      this.state.confirmDiscardButton.setProperty(hmUI.prop.VISIBLE, true)
      this.state.confirmRewriteButton.setProperty(hmUI.prop.VISIBLE, true)
      this.showPrimary('确认发送')
    },
    submitVoiceDecision(decision) {
      if (this.state.screen !== 'voice-confirm' || this.state.voiceDecisionPending || !this.state.voiceId) return
      const operation = this.state.voiceOperation
      this.state.voiceDecisionPending = true
      this.state.confirmDiscardButton.setProperty(hmUI.prop.VISIBLE, false)
      this.state.confirmRewriteButton.setProperty(hmUI.prop.VISIBLE, false)
      this.state.section.setProperty(hmUI.prop.TEXT, decision === 'confirm' ? '正在发送…' : decision === 'rewrite' ? '准备重新录音…' : '正在放弃…')
      this.setPrimary('请稍候…')
      withDeadline(
        this.request({ method: 'VOICE_DECISION', params: { voiceId: this.state.voiceId, decision } }),
        VOICE_STATUS_DEADLINE_MS
      )
        .then((result) => {
          if (operation !== this.state.voiceOperation) return
          this.state.voiceDecisionPending = false
          if (result.kind !== 'voice') {
            this.renderBridgeError(result)
            return
          }
          if (decision === 'rewrite' && result.snapshot.state === 'rewrite') {
            this.state.voiceId = ''
            this.state.screen = 'voice'
            this.toggleVoice()
            return
          }
          if (decision === 'discard' && result.snapshot.state === 'discarded') {
            this.state.voiceId = ''
            this.exitVoice()
            return
          }
          this.state.screen = 'voice'
          this.state.voiceDeadlineAt = Date.now() + VOICE_TURN_DEADLINE_MS
          this.state.voicePending = !voiceIsTerminal(result.snapshot.state)
          this.renderVoiceSnapshot(result.snapshot)
          if (!voiceIsTerminal(result.snapshot.state) && !voiceNeedsConfirmation(result.snapshot.state)) {
            this.pollVoice()
            this.state.voiceTimer = setInterval(() => this.pollVoice(), VOICE_POLL_MS)
          }
        })
        .catch(() => {
          if (operation === this.state.voiceOperation) this.renderVoiceError('手机没有确认操作\n请重试')
        })
    },
    renderVoiceState(title, detail, showActivity = false) {
      this.hideVoiceDecisionButtons()
      this.showCompactChrome(connectedDeviceLabel(this.state.snapshot), 0x67d9ff, true)
      this.hideRows()
      this.state.section.setProperty(hmUI.prop.VISIBLE, true)
      this.state.section.setProperty(hmUI.prop.TEXT, title)
      this.state.section.setProperty(hmUI.prop.COLOR, voiceStatusColor(title))
      this.state.detailTitle.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailSummary.setProperty(hmUI.prop.VISIBLE, false)
      this.state.voiceDetail.setProperty(hmUI.prop.VISIBLE, true)
      this.state.voiceDetail.setProperty(hmUI.prop.TEXT, detail)
      this.state.voiceDetail.setProperty(hmUI.prop.COLOR, 0xc5d3df)
      this.hideSecondary()
    },
    renderVoiceError(message) {
      this.state.voiceOperation += 1
      this.state.voicePending = false
      this.state.voicePollInFlight = false
      this.state.voiceDecisionPending = false
      this.state.voiceId = ''
      this.state.voiceDeadlineAt = 0
      if (this.state.voiceTimer) clearInterval(this.state.voiceTimer)
      this.state.voiceTimer = null
      this.stopRecordingClock()
      this.renderVoiceState('语音失败', message)
      this.state.connection.setProperty(hmUI.prop.COLOR, 0xf4b860)
      this.setPrimary('重试')
    },
    renderBridgeError(result) {
      if (result.kind === 'pairing_required') this.renderVoiceError('需要先配对')
      else if (result.kind === 'pairing_rejected') this.renderVoiceError('配对码无效')
      else if (result.error === 'voice_busy') this.renderVoiceError('手机上已有语音通话\n结束后再试')
      else if (result.error === 'global_offline') this.renderVoiceError('Global 当前离线')
      else if (result.error) this.renderVoiceError(voiceErrorLabel(result.error))
      else this.renderVoiceError('手机桥不可用')
    },
    exitVoice() {
      if (this.state.recording) return
      this.state.voiceOperation += 1
      this.state.voiceMode = false
      this.state.voicePending = false
      this.state.voicePollInFlight = false
      this.state.voiceDecisionPending = false
      this.state.voiceDeadlineAt = 0
      this.stopRecordingClock()
      if (this.state.voiceTimer) clearInterval(this.state.voiceTimer)
      this.state.voiceTimer = null
      if (this.state.selected) {
        this.state.screen = 'detail'
        this.renderDetail(this.state.selected.item)
      } else {
        this.state.screen = 'home'
        this.renderHome()
      }
    },
    voiceContextLabel() {
      const title = this.state.selected && this.state.selected.item && this.state.selected.item.title
      return voiceTargetLabel(title)
    },
    stopWaitingForVoice() {
      this.state.voiceOperation += 1
      this.state.voicePending = false
      this.state.voicePollInFlight = false
      this.state.voiceDecisionPending = false
      this.state.voiceId = ''
      this.state.voiceDeadlineAt = 0
      if (this.state.voiceTimer) clearInterval(this.state.voiceTimer)
      this.state.voiceTimer = null
      this.renderVoiceState('已停止等待', `${this.voiceContextLabel()}\n若手机已收到，仍可能继续处理`)
      this.setPrimary('重新录音')
    },
    startRecordingClock() {
      this.stopRecordingClock()
      this.state.voiceDetail.setProperty(hmUI.prop.VISIBLE, true)
      this.updateRecordingClock()
      this.state.recordElapsedTimer = setInterval(() => this.updateRecordingClock(), 250)
    },
    updateRecordingClock() {
      if (!this.state.recording) return
      const elapsed = Date.now() - this.state.recordStartedAt
      this.state.section.setProperty(hmUI.prop.TEXT, `录音中 · ${formatRecordingElapsed(elapsed)}`)
    },
    stopRecordingClock() {
      if (this.state.recordElapsedTimer) clearInterval(this.state.recordElapsedTimer)
      this.state.recordElapsedTimer = null
      if (this.state.voiceDetail) this.state.voiceDetail.setProperty(hmUI.prop.VISIBLE, false)
    },
    onCall(message) {
      if (message.kind === 'settings_changed') this.refresh()
    },
    refresh() {
      if (this.state.refreshing || this.state.voiceMode || this.state.screen === 'actions' || this.state.screen === 'action-status') return
      this.state.refreshing = true
      this.request({ method: 'GET_STATUS' })
        .then((result) => this.renderResult(result))
        .catch(() => this.renderResult({ kind: 'phone_unavailable' }))
        .finally(() => {
          this.state.refreshing = false
        })
    },
    renderResult(result) {
      if (result.kind === 'pairing_required') {
        this.renderMessage('需要配对', '请在 Zepp 设置中粘贴配对码')
        return
      }
      if (result.kind === 'pairing_rejected') {
        this.renderMessage('配对码无效', '请从 TermBridge 重新复制')
        return
      }
      if (result.kind !== 'status') {
        this.renderMessage('手机桥未连接', '打开手机上的 TermBridge')
        return
      }
      this.state.snapshot = result.snapshot
      if (this.state.screen === 'detail' && this.state.selected) {
        const refreshed = [...this.sortedAlerts(), ...this.agents()]
          .find((item) => itemIdentity(item) === this.state.selected.id)
        if (refreshed) {
          this.state.selected.item = refreshed
          this.renderDetail(refreshed)
          return
        }
        this.state.selected = null
        this.state.screen = 'home'
      }
      if (this.state.screen === 'agents') this.renderAgents()
      else this.renderHome()
    },
    renderHome() {
      const snapshot = this.state.snapshot
      if (!snapshot) return
      this.state.screen = 'home'
      this.state.voiceMode = false
      this.state.voicePending = false
      this.state.selected = null
      this.stopRecordingClock()
      this.hideVoiceDecisionButtons()
      this.showCompactChrome(connectedDeviceLabel(snapshot), snapshot.connected ? 0x74f0a7 : 0xf4b860, true)
      const alerts = this.sortedAlerts()
      this.state.section.setProperty(hmUI.prop.VISIBLE, true)
      this.state.section.setProperty(hmUI.prop.TEXT, `${alerts.length} 个通知`)
      this.state.section.setProperty(hmUI.prop.COLOR, alerts.length ? 0x67d9ff : 0x7f8a99)
      this.state.detailTitle.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailSummary.setProperty(hmUI.prop.VISIBLE, false)
      this.state.voiceDetail.setProperty(hmUI.prop.VISIBLE, false)
      this.state.rows.forEach((_, index) => {
        const alert = alerts[index]
        const visible = index < HOME_ALERTS && Boolean(alert)
        this.setRow(index, visible, alert ? `${statusLabel(alert.status)} · ${compact(alert.title, 28)}` : '', alertColor(alert && alert.status))
      })
      this.hideSecondary()
      this.hidePrimary()
      this.showMicButton(true)
    },
    renderAgents() {
      const snapshot = this.state.snapshot
      if (!snapshot) return
      this.state.screen = 'agents'
      this.state.voiceMode = false
      this.state.voicePending = false
      this.state.selected = null
      this.stopRecordingClock()
      this.hideVoiceDecisionButtons()
      this.showStandardChrome()
      const agents = this.agents()
      const pageCount = this.agentPageCount()
      this.state.agentsPage = Math.min(this.state.agentsPage, pageCount - 1)
      const start = this.state.agentsPage * AGENTS_PER_PAGE
      const items = agents.slice(start, start + AGENTS_PER_PAGE)
      this.state.title.setProperty(hmUI.prop.TEXT, '全部 Agent')
      this.state.connection.setProperty(hmUI.prop.TEXT, snapshot.connected ? snapshot.host : 'TermBridge 离线')
      this.state.connection.setProperty(hmUI.prop.COLOR, snapshot.connected ? 0x74f0a7 : 0xf4b860)
      this.state.section.setProperty(hmUI.prop.VISIBLE, true)
      this.state.section.setProperty(hmUI.prop.TEXT, agents.length ? `${start + 1}–${Math.min(start + items.length, agents.length)} / ${agents.length}` : '暂无 Agent')
      this.state.detailTitle.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailSummary.setProperty(hmUI.prop.VISIBLE, agents.length === 0)
      this.state.detailSummary.setProperty(hmUI.prop.TEXT, '连接 Host 后在这里查看 Agent')
      this.state.rows.forEach((_, index) => {
        const agent = items[index]
        this.setRow(index, Boolean(agent), agent ? `${statusLabel(agent.status)}  ${compact(agent.title, 26)}` : '', agent && isAttention(agent.status) ? 0xf4b860 : 0xffffff)
      })
      this.showSecondary('首页')
      this.showPrimary(pageCount > 1 ? `下一页 · ${this.state.agentsPage + 1}/${pageCount}` : '已显示全部')
    },
    renderActions() {
      const item = this.state.selected && this.state.selected.item
      if (!item) {
        this.goBack()
        return
      }
      this.state.screen = 'actions'
      this.state.actionPending = false
      this.hideVoiceDecisionButtons()
      this.showStandardChrome()
      const actions = actionsForStatus(item.status)
      const pageCount = this.actionPageCount()
      this.state.actionsPage = Math.min(this.state.actionsPage, pageCount - 1)
      const current = this.currentActionItems()
      const start = this.state.actionsPage * ACTIONS_PER_PAGE
      this.state.title.setProperty(hmUI.prop.TEXT, '处理任务')
      this.state.connection.setProperty(hmUI.prop.TEXT, compact(item.title, 28))
      this.state.connection.setProperty(hmUI.prop.COLOR, isAttention(item.status) ? 0xf4b860 : 0x74f0a7)
      this.state.section.setProperty(hmUI.prop.VISIBLE, true)
      this.state.section.setProperty(hmUI.prop.TEXT, `${start + 1}–${Math.min(start + current.length, actions.length)} / ${actions.length}`)
      this.state.detailTitle.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailSummary.setProperty(hmUI.prop.VISIBLE, false)
      this.state.voiceDetail.setProperty(hmUI.prop.VISIBLE, false)
      this.state.rows.forEach((_, index) => {
        const action = current[index]
        this.setRow(index, Boolean(action), action ? action.label : '', action && action.id === 'stop' ? 0xf4b860 : 0xffffff)
      })
      this.showSecondary('返回')
      this.showPrimary(pageCount > 1 ? `下一页 · ${this.state.actionsPage + 1}/${pageCount}` : '全部操作')
    },
    renderDetail(item) {
      this.state.screen = 'detail'
      this.state.voiceMode = false
      this.state.voicePending = false
      this.stopRecordingClock()
      this.hideVoiceDecisionButtons()
      this.showStandardChrome()
      this.state.title.setProperty(hmUI.prop.TEXT, this.state.selected && this.state.selected.source === 'home' ? '通知详情' : 'Agent 详情')
      this.state.connection.setProperty(hmUI.prop.TEXT, `${statusLabel(item.status)} · ${relativeTime(item.occurredAt)}`)
      this.state.connection.setProperty(hmUI.prop.COLOR, isAttention(item.status) ? 0xf4b860 : 0x74f0a7)
      this.hideRows()
      this.state.section.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailTitle.setProperty(hmUI.prop.VISIBLE, true)
      this.state.detailTitle.setProperty(hmUI.prop.TEXT, compact(item.title || '未命名 Agent', 42))
      this.state.detailSummary.setProperty(hmUI.prop.VISIBLE, true)
      this.state.detailSummary.setProperty(hmUI.prop.TEXT, compact(item.summary || '暂无摘要', 92))
      this.state.detailSummary.setProperty(hmUI.prop.COLOR, 0xc5ccd6)
      this.showSecondary('更多操作')
      this.hidePrimary()
      this.showMicButton(true)
    },
    renderMessage(title, detail) {
      this.state.screen = 'error'
      this.state.voiceMode = false
      this.state.voicePending = false
      this.stopRecordingClock()
      this.hideVoiceDecisionButtons()
      this.showStandardChrome()
      this.state.title.setProperty(hmUI.prop.TEXT, 'TermBridge')
      this.state.connection.setProperty(hmUI.prop.TEXT, title)
      this.state.connection.setProperty(hmUI.prop.COLOR, 0xf4b860)
      this.hideRows()
      this.state.section.setProperty(hmUI.prop.VISIBLE, true)
      this.state.section.setProperty(hmUI.prop.TEXT, '连接状态')
      this.state.detailTitle.setProperty(hmUI.prop.VISIBLE, false)
      this.state.detailSummary.setProperty(hmUI.prop.VISIBLE, true)
      this.state.detailSummary.setProperty(hmUI.prop.TEXT, detail)
      this.state.detailSummary.setProperty(hmUI.prop.COLOR, 0xffffff)
      this.hideSecondary()
      this.showPrimary('重试连接')
    },
    sortedAlerts() {
      const alerts = this.state.snapshot && Array.isArray(this.state.snapshot.alerts) ? this.state.snapshot.alerts : []
      return sortWorkInbox(alerts)
    },
    agents() {
      return this.state.snapshot && Array.isArray(this.state.snapshot.agents) ? this.state.snapshot.agents : []
    },
    agentPageCount() {
      return Math.max(1, Math.ceil(this.agents().length / AGENTS_PER_PAGE))
    },
    currentActionItems() {
      const item = this.state.selected && this.state.selected.item
      if (!item) return []
      const start = this.state.actionsPage * ACTIONS_PER_PAGE
      return actionsForStatus(item.status).slice(start, start + ACTIONS_PER_PAGE)
    },
    actionPageCount() {
      const item = this.state.selected && this.state.selected.item
      return Math.max(1, Math.ceil(actionsForStatus(item && item.status).length / ACTIONS_PER_PAGE))
    },
    ensureRow(index) {
      if (!this.state.rows[index]) {
        this.state.rows[index] = hmUI.createWidget(hmUI.widget.BUTTON, {
          ...ITEM_ROWS[index],
          click_func: () => this.openRow(index)
        })
      }
      return this.state.rows[index]
    },
    setRow(index, visible, text, color) {
      const row = visible ? this.ensureRow(index) : this.state.rows[index]
      if (!row) return
      row.setProperty(hmUI.prop.VISIBLE, visible)
      row.setProperty(hmUI.prop.TEXT, visible ? text : '')
      if (visible) row.setProperty(hmUI.prop.COLOR, color)
    },
    hideRows() {
      this.state.rows.forEach((row) => {
        if (row) row.setProperty(hmUI.prop.VISIBLE, false)
      })
    },
    ensurePrimaryButton() {
      if (!this.state.primaryButton) {
        this.state.primaryButton = hmUI.createWidget(hmUI.widget.BUTTON, {
          ...PRIMARY,
          click_func: () => this.onPrimary()
        })
      }
      return this.state.primaryButton
    },
    showPrimary(text) {
      const button = this.ensurePrimaryButton()
      button.setProperty(hmUI.prop.TEXT, text)
      button.setProperty(hmUI.prop.VISIBLE, true)
    },
    hidePrimary() {
      if (this.state.primaryButton) this.state.primaryButton.setProperty(hmUI.prop.VISIBLE, false)
    },
    ensureSecondaryButton() {
      if (!this.state.secondaryButton) {
        this.state.secondaryButton = hmUI.createWidget(hmUI.widget.BUTTON, {
          ...SECONDARY,
          click_func: () => this.onSecondary()
        })
      }
      return this.state.secondaryButton
    },
    showSecondary(text) {
      const button = this.ensureSecondaryButton()
      button.setProperty(hmUI.prop.TEXT, text)
      button.setProperty(hmUI.prop.VISIBLE, true)
    },
    hideSecondary() {
      if (this.state.secondaryButton) this.state.secondaryButton.setProperty(hmUI.prop.VISIBLE, false)
    },
    ensureVoiceDecisionButtons() {
      if (!this.state.confirmDiscardButton) {
        this.state.confirmDiscardButton = hmUI.createWidget(hmUI.widget.BUTTON, {
          ...CONFIRM_DISCARD,
          click_func: () => this.submitVoiceDecision('discard')
        })
      }
      if (!this.state.confirmRewriteButton) {
        this.state.confirmRewriteButton = hmUI.createWidget(hmUI.widget.BUTTON, {
          ...CONFIRM_REWRITE,
          click_func: () => this.submitVoiceDecision('rewrite')
        })
      }
    },
    showStandardChrome() {
      this.state.title.setProperty(hmUI.prop.VISIBLE, true)
      this.state.connection.setProperty(hmUI.prop.VISIBLE, true)
      this.state.homeConnection.setProperty(hmUI.prop.VISIBLE, false)
      this.hidePrimary()
      this.showMicButton(false)
    },
    showCompactChrome(text, color, showMic) {
      this.state.title.setProperty(hmUI.prop.VISIBLE, false)
      this.state.connection.setProperty(hmUI.prop.VISIBLE, false)
      this.state.homeConnection.setProperty(hmUI.prop.VISIBLE, true)
      this.state.homeConnection.setProperty(hmUI.prop.TEXT, text)
      this.state.homeConnection.setProperty(hmUI.prop.COLOR, color)
      this.hidePrimary()
      this.showMicButton(showMic)
    },
    showMicButton(visible) {
      if (visible && !this.state.micButton) {
        this.state.micButton = hmUI.createWidget(hmUI.widget.BUTTON, {
          ...MIC_BUTTON,
          click_func: () => this.onPrimary()
        })
        this.state.micParts = [MIC_BODY, MIC_LEFT, MIC_RIGHT, MIC_BRIDGE, MIC_STEM, MIC_BASE]
          .map((style) => hmUI.createWidget(hmUI.widget.FILL_RECT, style))
      }
      if (this.state.micButton) this.state.micButton.setProperty(hmUI.prop.VISIBLE, visible)
      this.state.micParts.forEach((part) => part.setProperty(hmUI.prop.VISIBLE, visible))
    },
    hideVoiceDecisionButtons() {
      if (this.state.confirmDiscardButton) this.state.confirmDiscardButton.setProperty(hmUI.prop.VISIBLE, false)
      if (this.state.confirmRewriteButton) this.state.confirmRewriteButton.setProperty(hmUI.prop.VISIBLE, false)
    },
    setPrimary(text) {
      if (this.state.primaryButton) this.state.primaryButton.setProperty(hmUI.prop.TEXT, text)
    },
    onDestroy() {
      if (this.state.timer) clearInterval(this.state.timer)
      if (this.state.voiceTimer) clearInterval(this.state.voiceTimer)
      if (this.state.actionTimer) clearInterval(this.state.actionTimer)
      if (this.state.recordElapsedTimer) clearInterval(this.state.recordElapsedTimer)
      if (this.state.recordTimer) clearTimeout(this.state.recordTimer)
      offKey()
      if (this.state.recording && this.state.recorder) {
        try { this.state.recorder.stop() } catch (error) {}
      }
      this.state.timer = null
      this.state.voiceTimer = null
      this.state.actionTimer = null
      this.state.recordElapsedTimer = null
      this.state.recordTimer = null
      logger.log('TermBridge status page stopped')
    }
  })
)

const VOICE_FILE = 'data://termbridge_voice.opus'
const MAX_RECORD_MS = 12000
const MAX_OPUS_BYTES = 1000000
const HOME_ALERTS = 2
const AGENTS_PER_PAGE = 2
const ACTIONS_PER_PAGE = 2
const ACTION_TURN_DEADLINE_MS = 120000

function safeRecorderStatus(recorder) {
  try { return recorder.getStatus() } catch (error) { return 'unknown' }
}

function safeError(error) {
  return compact(error && error.message ? error.message : String(error || 'unknown'), 96)
}

function voiceStateLabel(state) {
  switch (state) {
    case 'decoding': return '手机已收到 · 正在解码'
    case 'transcribing': return '正在识别'
    case 'thinking': return 'Global 正在思考'
    case 'synthesizing': return '正在生成语音'
    case 'speaking': return '手机正在播放'
    case 'done': return '完成'
    default: return '处理中'
  }
}

function connectedDeviceLabel(snapshot) {
  if (!snapshot || !snapshot.connected) return '正在连接手机…'
  return `已连接 · ${compact(snapshot.host || '手机', 16)}`
}

function alertColor(status) {
  switch (String(status || '').toLowerCase()) {
    case 'approval':
    case 'waiting': return 0xffc45c
    case 'blocked':
    case 'failed':
    case 'error': return 0xff7888
    case 'done': return 0x74f0a7
    case 'working':
    case 'running':
    case 'active': return 0x67d9ff
    default: return 0xd3dae5
  }
}

function voiceStatusColor(title) {
  const text = String(title || '')
  if (text.includes('失败') || text.includes('超时')) return 0xff7888
  if (text.includes('录音')) return 0xffc45c
  if (text.includes('识别') || text.includes('手机')) return 0x67d9ff
  if (text.includes('思考') || text.includes('生成')) return 0xc69cff
  if (text.includes('完成') || text.includes('播放')) return 0x74f0a7
  return 0xd3dae5
}

function voiceProgressDetail(snapshot, state, context) {
  const reply = compact(snapshot && snapshot.reply, 150)
  if (reply) return `手机回复\n${reply}`
  const transcript = compact(snapshot && snapshot.transcript, 150)
  if (transcript) {
    const next = state === 'thinking' ? '\n\n文字已发送，正在处理' : ''
    return `识别文字\n${transcript}${next}`
  }
  switch (state) {
    case 'decoding': return '手机已经收到录音\n正在检查并解码音频'
    case 'transcribing': return '音频解码完成\n正在识别你刚才说的话'
    case 'thinking': return '识别文字已经发送\n手机正在处理请求'
    case 'synthesizing': return '回复已经生成\n正在准备手机语音播放'
    case 'speaking': return '回复已送达手机\n手机正在播放语音'
    case 'done': return '这次语音请求已经完成\n可以再次点击麦克风继续'
    default: return context
  }
}

function voiceErrorLabel(error) {
  switch (String(error || '')) {
    case 'no_speech': return '没有听清，请再说一次'
    case 'audio_decode_failed': return '手机无法解码手表录音'
    case 'transcription_failed': return '语音识别失败'
    case 'global_offline': return 'Global 当前离线'
    case 'timeout': return '处理超时，请重试'
    default: return 'Global 处理失败'
  }
}

function actionLabel(action) {
  switch (String(action || '')) {
    case 'summarize': return '获取摘要'
    case 'retry': return '检查并重试'
    case 'continue': return '继续下一步'
    case 'stop': return '停止任务'
    case 'snooze': return '稍后处理'
    case 'handoff': return '手机接力'
    default: return '处理任务'
  }
}

function actionErrorLabel(error) {
  switch (String(error || '')) {
    case 'global_offline': return 'Global 当前离线'
    case 'action_unavailable': return '手机动作服务不可用'
    case 'invalid_action': return '此操作不受支持'
    case 'timeout': return '操作超时，请稍后查看'
    default: return '操作失败，请重试'
  }
}

function statusLabel(status) {
  switch (String(status || '').toLowerCase()) {
    case 'approval': return '待确认'
    case 'blocked': return '阻塞'
    case 'waiting': return '等待'
    case 'working':
    case 'running':
    case 'active': return '运行'
    case 'done': return '完成'
    case 'failed':
    case 'error': return '失败'
    default: return '空闲'
  }
}

function isAttention(status) {
  return isAttentionStatus(status)
}

function itemIdentity(item) {
  return String(item.id || item.sessionId || '')
}

function compact(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function relativeTime(value) {
  const timestamp = Number(value || 0)
  if (!timestamp) return '当前状态'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}
