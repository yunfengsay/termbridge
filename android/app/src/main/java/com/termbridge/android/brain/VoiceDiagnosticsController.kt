package com.termbridge.android.brain

/**
 * Thread-safe voice capture/send/VAD pipeline diagnostics for on-screen live call
 * debugging, kept outside BrainActivity so call state stays focused.
 */
class VoiceDiagnosticsController(
    private val clock: () -> Long = System::currentTimeMillis,
) {
    @Volatile var frames: Long = 0L
        private set
    @Volatile var capturedBytes: Long = 0L
        private set
    @Volatile var sentBytes: Long = 0L
        private set
    @Volatile var voicedCapturedBytes: Long = 0L
        private set
    @Volatile var lastEvent: String = "等待通话"
        private set
    @Volatile var lastEventAt: Long = 0L
        private set
    @Volatile var audible: Boolean = false
        private set
    @Volatile var probability: Float = 0f
        private set
    @Volatile var probabilityPeak: Float = 0f
        private set
    @Volatile var threshold: Float = 0f
        private set

    fun resetForCall() {
        frames = 0L
        capturedBytes = 0L
        sentBytes = 0L
        voicedCapturedBytes = 0L
        noteEvent("通话开始")
    }

    fun noteEvent(event: String) {
        lastEvent = event
        lastEventAt = clock()
    }

    fun recordFrame() {
        frames += 1
    }

    fun recordAudible(isAudible: Boolean) {
        audible = isAudible
    }

    fun recordVad(prob: Float, thresh: Float) {
        probability = prob
        threshold = thresh
        if (prob > probabilityPeak) probabilityPeak = prob
    }

    fun recordCaptured(bytes: Int) {
        capturedBytes += bytes
        if (audible) voicedCapturedBytes += bytes
    }

    fun recordSent(bytes: Int) {
        sentBytes += bytes
    }

    fun formatStatus(active: Boolean, hasRequestId: Boolean, remoteReady: Boolean): String {
        if (!active) return ""
        val req = if (hasRequestId) "有" else "无"
        val ready = if (remoteReady) "是" else "否"
        val age = if (lastEventAt == 0L) "" else " · ${(clock() - lastEventAt) / 1000}s前"
        val gate = if (audible) "语音▶" else "静音·"
        val peak = probabilityPeak
        probabilityPeak = probability
        return "采集 ${frames}帧/${capturedBytes / 1024}KB → 已发 ${sentBytes / 1024}KB(人声${voicedCapturedBytes / 1024}KB) [$gate]\n" +
            "VAD p=%.2f 峰值=%.2f 阈值=%.2f · 会话:%s 就绪:%s".format(
                probability, peak, threshold, req, ready,
            ) + "\n" +
            "最近: $lastEvent$age"
    }
}
