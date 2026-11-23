package com.termbridge.android.watch

import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.protocol.MessagePackCodec

enum class WatchTransport(val wireName: String) {
    AUTO("auto"),
    BLUETOOTH("bluetooth"),
    WIFI("wifi");

    companion object {
        fun fromWireName(value: String?): WatchTransport = entries.firstOrNull { it.wireName == value } ?: AUTO
    }
}

data class WatchProvisioning(
    val relayUrl: String,
    val hostId: String,
    val secret: String,
    val tlsFingerprint: String,
    val profileKey: String,
    val transport: WatchTransport,
    val inputSampleRate: Int = INPUT_SAMPLE_RATE,
    val outputSampleRate: Int = OUTPUT_SAMPLE_RATE,
    val negotiatedAttMtu: Int = DEFAULT_ATT_MTU,
) {
    fun encode(): ByteArray = MessagePackCodec.packMap(
        linkedMapOf(
            "version" to 1,
            "relayUrl" to relayUrl,
            "hostId" to hostId,
            "secret" to secret,
            "tlsFingerprint" to tlsFingerprint,
            "profileKey" to profileKey,
            "transport" to transport.wireName,
            "voiceEncoding" to "pcm_s16le",
            "inputSampleRate" to inputSampleRate,
            "outputSampleRate" to outputSampleRate,
            "attMtu" to negotiatedAttMtu,
        ),
    )

    companion object {
        const val INPUT_SAMPLE_RATE = 16_000
        const val OUTPUT_SAMPLE_RATE = 24_000
        const val DEFAULT_ATT_MTU = 23

        fun current(
            settings: ConnectionSettings,
            transport: WatchTransport,
            negotiatedAttMtu: Int = DEFAULT_ATT_MTU,
        ): WatchProvisioning =
            WatchProvisioning(
                relayUrl = settings.relayUrl,
                hostId = settings.hostId,
                secret = settings.secret,
                tlsFingerprint = settings.normalizedFingerprint,
                profileKey = settings.profileKey,
                transport = transport,
                negotiatedAttMtu = negotiatedAttMtu.also {
                    require(it in DEFAULT_ATT_MTU..WatchBleContract.PREFERRED_MTU)
                },
            )

        fun decode(bytes: ByteArray): WatchProvisioning {
            val map = MessagePackCodec.unpackMap(bytes)
            require((map["version"] as? Number)?.toInt() == 1) { "unsupported provisioning version" }
            require(map["voiceEncoding"] == "pcm_s16le") { "unsupported watch voice encoding" }
            return WatchProvisioning(
                relayUrl = map["relayUrl"] as? String ?: error("missing relay URL"),
                hostId = map["hostId"] as? String ?: error("missing host ID"),
                secret = map["secret"] as? String ?: error("missing secret"),
                tlsFingerprint = map["tlsFingerprint"] as? String ?: "",
                profileKey = map["profileKey"] as? String ?: error("missing profile key"),
                transport = WatchTransport.fromWireName(map["transport"] as? String),
                inputSampleRate = (map["inputSampleRate"] as? Number)?.toInt() ?: INPUT_SAMPLE_RATE,
                outputSampleRate = (map["outputSampleRate"] as? Number)?.toInt() ?: OUTPUT_SAMPLE_RATE,
                negotiatedAttMtu = ((map["attMtu"] as? Number)?.toInt() ?: DEFAULT_ATT_MTU).also {
                    require(it in DEFAULT_ATT_MTU..WatchBleContract.PREFERRED_MTU) { "invalid watch ATT MTU" }
                },
            )
        }
    }
}
