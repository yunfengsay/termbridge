package com.termbridge.android.brain

import java.util.concurrent.CopyOnWriteArraySet

/** Process-local presentation state for showing an active call outside BrainActivity. */
object VoiceCallUiState {
    data class Snapshot(
        val active: Boolean = false,
        val level: Float = 0f,
        val mode: VoiceLevelView.Mode = VoiceLevelView.Mode.CONNECTING,
        val attachmentCount: Int = 0,
        val surfaceVisible: Boolean = false,
        val overlayVisible: Boolean = false,
    )

    private val listeners = CopyOnWriteArraySet<(Snapshot) -> Unit>()
    private val visibleSurfaces = mutableSetOf<Any>()
    @Volatile private var snapshot = Snapshot()

    fun current(): Snapshot = snapshot

    fun addListener(listener: (Snapshot) -> Unit) {
        listeners += listener
        listener(snapshot)
    }

    fun removeListener(listener: (Snapshot) -> Unit) {
        listeners -= listener
    }

    fun setActive(active: Boolean) = update(snapshot.copy(active = active, level = if (active) snapshot.level else 0f))

    fun setLevel(level: Float) = update(snapshot.copy(level = level.coerceIn(0f, 1f)))

    fun setMode(mode: VoiceLevelView.Mode) = update(snapshot.copy(mode = mode))

    fun setAttachmentCount(count: Int) = update(snapshot.copy(attachmentCount = count.coerceIn(0, 20)))

    /** A visible call page or in-app orb, not merely any foreground app page. */
    fun setSurfaceVisible(owner: Any, visible: Boolean) {
        if (visible) visibleSurfaces.add(owner) else visibleSurfaces.remove(owner)
        update(snapshot.copy(surfaceVisible = visibleSurfaces.isNotEmpty()))
    }

    fun setOverlayVisible(visible: Boolean) = update(snapshot.copy(overlayVisible = visible))

    /** Process background is authoritative even if an Activity missed its cleanup callback. */
    fun clearActivitySurfaces() {
        visibleSurfaces.clear()
        update(snapshot.copy(surfaceVisible = false))
    }

    private fun update(next: Snapshot) {
        if (next == snapshot) return
        snapshot = next
        listeners.forEach { it(next) }
    }
}
