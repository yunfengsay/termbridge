package com.termbridge.android.watch

data class WatchStatusPayload(val batteryLevel: Int) {
    companion object {
        fun decode(payload: ByteArray): WatchStatusPayload {
            require(payload.size == 1) { "watch status must contain only battery level" }
            val batteryLevel = payload[0].toInt() and 0xff
            require(batteryLevel in 0..100) { "watch battery level is out of range" }
            return WatchStatusPayload(batteryLevel)
        }
    }
}
