package com.termbridge.android.brain

import kotlin.math.sqrt

object VoiceEmbedding {
    fun normalize(values: FloatArray): FloatArray {
        val magnitude = sqrt(values.sumOf { value -> (value * value).toDouble() }).toFloat()
        if (magnitude <= 1e-8f) return FloatArray(values.size)
        return FloatArray(values.size) { index -> values[index] / magnitude }
    }

    fun average(samples: List<FloatArray>): FloatArray {
        require(samples.isNotEmpty())
        val size = samples.first().size
        require(size > 0 && samples.all { it.size == size })
        val mean = FloatArray(size)
        samples.forEach { sample ->
            val normalized = normalize(sample)
            normalized.forEachIndexed { index, value -> mean[index] += value }
        }
        return normalize(mean)
    }

    fun similarity(profile: FloatArray, candidate: FloatArray): Float {
        if (profile.isEmpty() || profile.size != candidate.size) return -1f
        val left = normalize(profile)
        val right = normalize(candidate)
        return left.indices.sumOf { index -> (left[index] * right[index]).toDouble() }.toFloat()
    }
}
