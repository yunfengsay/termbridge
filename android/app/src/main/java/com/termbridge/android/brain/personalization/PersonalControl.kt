package com.termbridge.android.brain.personalization

import kotlin.math.exp

/** Wire order: speech probability, voiced duration/5s, pause/5s, playback, recent turn, explicit wake.
 * No ASR, speaker identity, PCM, or semantic claims. This calibration head remains in shadow mode.
 */
data class ControlFeedback(val id: String, val group: String, val at: Long, val features: List<Double>, val head: String, val label: Int)
data class ControlModel(
    val version: String = "base-v1", val samples: Int = 0,
    val addressed: List<Double> = List(7) { 0.0 }, val finished: List<Double> = List(7) { 0.0 },
) {
    init {
        require(samples in 0..500 && version.length in 1..80)
        require(listOf(addressed, finished).all { it.size == 7 && it.all { w -> w.isFinite() && w in -4.0..4.0 } })
    }
    fun probability(head: String, features: List<Double>): Double {
        require(head == "addressed" || head == "finished")
        require(features.size == 6 && features.all { it.isFinite() && it in 0.0..1.0 })
        val w = if (head == "addressed") addressed else finished
        val logit = features.mapIndexed { i, v -> w[i + 1] * v }.sum() + w[0]
        return 1 / (1 + exp(-logit.coerceIn(-30.0, 30.0)))
    }
    companion object {
        fun wireRevision(value: Any?): Long {
            val number = value as? Number ?: error("Invalid revision")
            val revision = number.toLong()
            require(number.toDouble().isFinite() && revision in 1..9_007_199_254_740_991L && number.toDouble() == revision.toDouble())
            return revision
        }
        fun fromWire(value: Map<*, *>): ControlModel {
            require((value["schema"] as? Number)?.toDouble() == 1.0 && value["mode"] == "shadow")
            val samples = value["samples"] as? Number ?: error("Invalid sample count")
            require(samples.toDouble().isFinite() && samples.toDouble() == samples.toInt().toDouble())
            fun weights(key: String) = (value[key] as List<*>).map { (it as Number).toDouble() }
            return ControlModel(value["version"] as String, samples.toInt(), weights("addressed"), weights("finished"))
        }
        fun train(rows: List<ControlFeedback>, version: String): ControlModel {
            val unique = rows.associateBy { it.id }.values.sortedBy { it.id }
            require(unique.size <= 500)
            val addressed = MutableList(7) { 0.0 }
            val finished = MutableList(7) { 0.0 }
            unique.forEach { require(it.head in listOf("addressed", "finished") && it.label in 0..1) }
            repeat(12) {
                unique.forEach { row ->
                    val error = row.label - ControlModel(addressed = addressed, finished = finished).probability(row.head, row.features)
                    val w = if (row.head == "addressed") addressed else finished
                    w.indices.forEach { i ->
                        val x = if (i == 0) 1.0 else row.features[i - 1]
                        w[i] = (w[i] + 0.12 * (error * x - 0.005 * w[i])).coerceIn(-4.0, 4.0)
                    }
                }
            }
            return ControlModel(version, unique.size, addressed.toList(), finished.toList())
        }
    }
}

/** Capture thread only adds six scalars; no disk/network and no audio retention. */
class ControlObservation {
    private var sum = 0.0
    private var count = 0
    private var voicedMs = 0L
    private var lastVoiceAt = 0L
    @Synchronized fun frame(probability: Float, now: Long) {
        if (!probability.isFinite()) return
        sum += probability.coerceIn(0f, 1f); count++
        if (probability >= 0.5f) { voicedMs += 32; lastVoiceAt = now }
    }
    @Synchronized fun snapshot(now: Long, playback: Boolean, recent: Boolean, wake: Boolean): List<Double>? {
        if (count == 0) return null
        return listOf(sum / count, (voicedMs / 5000.0).coerceIn(0.0, 1.0),
            ((now - lastVoiceAt) / 5000.0).coerceIn(0.0, 1.0),
            if (playback) 1.0 else 0.0, if (recent) 1.0 else 0.0, if (wake) 1.0 else 0.0)
            .also { reset() }
    }
    @Synchronized fun reset() { sum = 0.0; count = 0; voicedMs = 0; lastVoiceAt = 0 }
}
