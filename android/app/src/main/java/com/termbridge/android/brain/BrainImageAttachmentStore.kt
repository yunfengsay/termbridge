package com.termbridge.android.brain

import android.content.Context
import android.net.Uri
import com.termbridge.android.peer.AndroidPeerIdentity
import com.termbridge.android.peer.PhoneActionRequest
import com.termbridge.android.peer.PhoneActionResult
import com.termbridge.android.peer.PhoneActionStore
import com.termbridge.android.peer.PhoneSelectedAsset
import com.termbridge.android.peer.PhoneSelectedAssetStore
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/** Exact user-picked images shared by Global text, realtime call, and its floating presentation. */
data class BrainImageAttachment(
    val actionId: String,
    val deviceId: String,
    val assets: List<PhoneSelectedAsset>,
) {
    fun toWireMap(): Map<String, Any?> = mapOf(
        "actionId" to actionId,
        "deviceId" to deviceId,
        "assets" to assets.map(PhoneSelectedAsset::toWireMap),
    )

    fun toJson(): JSONObject = JSONObject().apply {
        put("actionId", actionId)
        put("deviceId", deviceId)
        put("assets", JSONArray(assets.map { it.toJson() }))
    }

    companion object {
        fun fromJson(json: JSONObject): BrainImageAttachment {
            val raw = json.getJSONArray("assets")
            val assets = (0 until raw.length()).map { PhoneSelectedAsset.fromJson(raw.getJSONObject(it)) }
            require(assets.isNotEmpty() && assets.size <= PhoneActionRequest.MAX_PHOTO_SELECTION)
            return BrainImageAttachment(
                actionId = json.getString("actionId"),
                deviceId = json.getString("deviceId"),
                assets = assets,
            )
        }
    }
}

class BrainImageAttachmentStore(private val context: Context) {
    private val preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    private val actionStore = PhoneActionStore(context)
    private val assetStore = PhoneSelectedAssetStore(context)

    @Synchronized
    fun import(uris: List<Uri>): BrainImageAttachment = reserve { actionId ->
        assetStore.import(actionId, uris, PhoneActionRequest.MAX_PHOTO_SELECTION)
    }

    @Synchronized
    fun importScreenCapture(png: ByteArray): BrainImageAttachment = reserve { actionId ->
        val timestamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        listOf(assetStore.importBytes(actionId, "screen-$timestamp.png", "image/png", png))
    }

    private fun reserve(importAssets: (String) -> List<PhoneSelectedAsset>): BrainImageAttachment {
        discardUnusedCurrent()
        val actionId = "brain-image-${UUID.randomUUID()}"
        val request = PhoneActionRequest(
            actionId = actionId,
            requestId = actionId,
            callId = "brain-image",
            toolResultId = actionId,
            conversationId = actionId,
            action = "photo.edit",
            instructions = GLOBAL_TURN_INSTRUCTIONS,
            maxItems = PhoneActionRequest.MAX_PHOTO_SELECTION,
        )
        check(actionStore.save(request)) { "could not reserve the image attachment" }
        return try {
            val assets = importAssets(actionId)
            actionStore.complete(PhoneActionResult(
                actionId = actionId,
                action = request.action,
                state = "running",
                summary = "已选择 ${assets.size} 张照片，等待 Global 指令",
                data = mapOf(
                    "selectedCount" to assets.size,
                    "instructions" to GLOBAL_TURN_INSTRUCTIONS,
                    "assets" to assets.map(PhoneSelectedAsset::toMap),
                ),
            ))
            BrainImageAttachment(actionId, AndroidPeerIdentity.deviceId(context), assets).also {
                preferences.edit()
                    .putString(KEY_CURRENT, it.toJson().toString())
                    .putBoolean(KEY_USED, false)
                    .apply()
            }
        } catch (error: Throwable) {
            actionStore.discard(actionId)
            assetStore.delete(mapOf("actionId" to actionId))
            throw error
        }
    }

    @Synchronized
    fun current(): BrainImageAttachment? = preferences.getString(KEY_CURRENT, null)?.let { raw ->
        runCatching { BrainImageAttachment.fromJson(JSONObject(raw)) }.getOrNull()
    }

    @Synchronized
    fun markUsed(actionId: String) {
        if (current()?.actionId == actionId) preferences.edit().putBoolean(KEY_USED, true).apply()
    }

    /** Remove the composer reference but retain encrypted assets for an Agent already using them. */
    @Synchronized
    fun consume(actionId: String) {
        if (current()?.actionId != actionId) return
        preferences.edit().remove(KEY_CURRENT).remove(KEY_USED).apply()
    }

    @Synchronized
    fun discardCurrent() {
        val current = current() ?: return
        val used = preferences.getBoolean(KEY_USED, false)
        preferences.edit().remove(KEY_CURRENT).remove(KEY_USED).apply()
        if (!used) {
            actionStore.discard(current.actionId)
            assetStore.delete(mapOf("actionId" to current.actionId))
        }
    }

    private fun discardUnusedCurrent() = discardCurrent()

    private companion object {
        const val STORE = "brain_image_attachment"
        const val KEY_CURRENT = "current"
        const val KEY_USED = "used"
        const val GLOBAL_TURN_INSTRUCTIONS = "Follow the Global conversation turn attached to this exact image batch"
    }
}
