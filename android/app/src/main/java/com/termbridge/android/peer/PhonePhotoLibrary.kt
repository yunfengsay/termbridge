package com.termbridge.android.peer

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.ceil

enum class PhonePhotoAccessScope(val wireName: String) {
    NONE("none"),
    SELECTED("selected"),
    FULL("full"),
}

/** Android runtime permission boundary; tool approval remains a separate app-private policy. */
object PhonePhotoPermissions {
    fun requested(): Array<String> = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
        )
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    fun scope(context: Context): PhonePhotoAccessScope = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            granted(context, Manifest.permission.READ_MEDIA_IMAGES) -> PhonePhotoAccessScope.FULL
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            granted(context, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> PhonePhotoAccessScope.SELECTED
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            granted(context, Manifest.permission.READ_MEDIA_IMAGES) -> PhonePhotoAccessScope.FULL
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU &&
            granted(context, Manifest.permission.READ_EXTERNAL_STORAGE) -> PhonePhotoAccessScope.FULL
        else -> PhonePhotoAccessScope.NONE
    }

    private fun granted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}

/** MediaStore stays on-device; only aggregates or opaque, expiring asset handles cross the Peer boundary. */
class PhonePhotoLibrary(private val context: Context) {
    private data class Window(val start: Long, val endExclusive: Long)

    fun execute(
        request: PhoneActionRequest,
        cancellation: CancellationSignal? = null,
    ): PhoneActionResult {
        val scope = PhonePhotoPermissions.scope(context)
        if (scope == PhonePhotoAccessScope.NONE) {
            return PhoneActionResult(
                request.actionId,
                request.action,
                "denied",
                "请先在全局设置中授权照片访问",
                mapOf("missingPermissions" to PhonePhotoPermissions.requested().toList()),
            )
        }
        return when (request.action) {
            "photo.count" -> count(request, scope, cancellation)
            "photo.fetch" -> fetch(request, scope, cancellation)
            else -> error("unsupported photo library action")
        }
    }

    private fun count(
        request: PhoneActionRequest,
        scope: PhonePhotoAccessScope,
        cancellation: CancellationSignal?,
    ): PhoneActionResult {
        val window = window(request)
        val count = queryCount(window, request.collection, cancellation)
        val summary = if (scope == PhonePhotoAccessScope.FULL) {
            "该时间段拍摄了 $count 张照片"
        } else {
            "已在授权的照片范围内统计到 $count 张"
        }
        return PhoneActionResult(
            request.actionId,
            request.action,
            "completed",
            summary,
            mapOf(
                "count" to count,
                "collection" to request.collection,
                "startsAt" to requireNotNull(request.startsAt),
                "endsAt" to requireNotNull(request.endsAt),
                "accessScope" to scope.wireName,
                "contentExposed" to false,
            ),
        )
    }

    private fun fetch(
        request: PhoneActionRequest,
        scope: PhonePhotoAccessScope,
        cancellation: CancellationSignal?,
    ): PhoneActionResult {
        val budget = PhonePhotoAccessBudget(context).reserve(request.maxItems)
        if (!budget.allowed) {
            return PhoneActionResult(
                request.actionId,
                request.action,
                "denied",
                "照片读取过于频繁，请稍后再试",
                mapOf(
                    "retryAfterSeconds" to budget.retryAfterSeconds,
                    "maxPerRequest" to PhoneActionRequest.MAX_PHOTO_SELECTION,
                    "maxPerHour" to PhonePhotoAccessBudgetRules.MAX_ITEMS_PER_HOUR,
                ),
            )
        }
        val uris = query(window(request), request.collection, request.maxItems, cancellation)
        if (uris.isEmpty()) {
            return PhoneActionResult(
                request.actionId,
                request.action,
                "completed",
                "该时间段没有找到匹配的照片",
                mapOf(
                    "selectedCount" to 0,
                    "collection" to request.collection,
                    "accessScope" to scope.wireName,
                    "contentExposed" to false,
                ),
            )
        }
        val assets = PhoneSelectedAssetStore(context).import(
            request.actionId,
            uris,
            request.maxItems,
        ) { cancellation?.isCanceled == true }
        return PhoneActionResult(
            request.actionId,
            request.action,
            "running",
            "已授予 ${assets.size} 张照片的临时处理句柄",
            mapOf(
                "selectedCount" to assets.size,
                "collection" to request.collection,
                "startsAt" to requireNotNull(request.startsAt),
                "endsAt" to requireNotNull(request.endsAt),
                "accessScope" to scope.wireName,
                "contentExposed" to true,
                "expiresInSeconds" to PhoneSelectedAssetStore.RETENTION_SECONDS,
                "instructions" to request.instructions,
                "assets" to assets.map(PhoneSelectedAsset::toMap),
            ),
        )
    }

    private fun query(
        window: Window,
        collection: String,
        limit: Int,
        cancellation: CancellationSignal?,
    ): List<Uri> {
        if (cancellation?.isCanceled == true) throw OperationCanceledException()
        val taken = MediaStore.Images.Media.DATE_TAKEN
        val added = MediaStore.Images.Media.DATE_ADDED
        val selection = photoSelection(window, collection)
        val uris = mutableListOf<Uri>()
        context.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.Images.Media._ID),
            selection.first,
            selection.second,
            "$taken DESC, $added DESC",
            cancellation,
        )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            while (cursor.moveToNext() && uris.size < limit) {
                uris += ContentUris.withAppendedId(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    cursor.getLong(idColumn),
                )
            }
        }
        return uris
    }

    private fun queryCount(
        window: Window,
        collection: String,
        cancellation: CancellationSignal?,
    ): Int {
        if (cancellation?.isCanceled == true) throw OperationCanceledException()
        val selection = photoSelection(window, collection)
        return context.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.Images.Media._ID),
            selection.first,
            selection.second,
            null,
            cancellation,
        )?.use { it.count } ?: 0
    }

    private fun photoSelection(window: Window, collection: String): Pair<String, Array<String>> {
        val taken = MediaStore.Images.Media.DATE_TAKEN
        val added = MediaStore.Images.Media.DATE_ADDED
        val selectionParts = mutableListOf(
            "(($taken >= ? AND $taken < ?) OR (($taken IS NULL OR $taken = 0) AND $added >= ? AND $added < ?))",
        )
        val args = mutableListOf(
            window.start.toString(),
            window.endExclusive.toString(),
            (window.start / 1_000).toString(),
            ceil(window.endExclusive / 1_000.0).toLong().toString(),
        )
        when (collection) {
            "camera" -> {
                selectionParts += "${MediaStore.Images.Media.BUCKET_DISPLAY_NAME} = ? COLLATE NOCASE"
                args += "Camera"
            }
            "screenshots" -> {
                selectionParts += "${MediaStore.Images.Media.BUCKET_DISPLAY_NAME} LIKE ? COLLATE NOCASE"
                args += "%screenshot%"
            }
            "all" -> Unit
            else -> error("unsupported photo collection")
        }
        return selectionParts.joinToString(" AND ") to args.toTypedArray()
    }

    private fun window(request: PhoneActionRequest): Window {
        val start = parsePhoneIsoTime(requireNotNull(request.startsAt))
        val end = parsePhoneIsoTime(requireNotNull(request.endsAt))
        return Window(start, end)
    }
}

internal data class PhonePhotoAccessGrant(val at: Long, val count: Int)
internal data class PhonePhotoBudgetDecision(val allowed: Boolean, val retryAfterSeconds: Long = 0)

internal object PhonePhotoAccessBudgetRules {
    const val COOLDOWN_MS = 60_000L
    const val WINDOW_MS = 60L * 60 * 1_000
    const val MAX_ITEMS_PER_HOUR = 12

    fun decide(history: List<PhonePhotoAccessGrant>, now: Long, requested: Int): PhonePhotoBudgetDecision {
        require(requested in 1..PhoneActionRequest.MAX_PHOTO_SELECTION)
        val active = history.filter { it.at <= now && now - it.at < WINDOW_MS }
        val last = active.maxOfOrNull(PhonePhotoAccessGrant::at)
        if (last != null && now - last < COOLDOWN_MS) {
            return PhonePhotoBudgetDecision(false, seconds(COOLDOWN_MS - (now - last)))
        }
        if (active.sumOf(PhonePhotoAccessGrant::count) + requested > MAX_ITEMS_PER_HOUR) {
            val oldest = active.minOfOrNull(PhonePhotoAccessGrant::at) ?: now
            return PhonePhotoBudgetDecision(false, seconds(WINDOW_MS - (now - oldest)))
        }
        return PhonePhotoBudgetDecision(true)
    }

    private fun seconds(milliseconds: Long): Long = ceil(milliseconds.coerceAtLeast(1) / 1_000.0).toLong()
}

private class PhonePhotoAccessBudget(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences(STORE, Context.MODE_PRIVATE)

    fun reserve(count: Int, now: Long = System.currentTimeMillis()): PhonePhotoBudgetDecision = synchronized(lock) {
        val history = readHistory().filter { it.at <= now && now - it.at < PhonePhotoAccessBudgetRules.WINDOW_MS }
        val decision = PhonePhotoAccessBudgetRules.decide(history, now, count)
        val next = if (decision.allowed) history + PhonePhotoAccessGrant(now, count) else history
        val persisted = preferences.edit().putString(HISTORY, JSONArray().apply {
            next.forEach { grant -> put(JSONObject().put("at", grant.at).put("count", grant.count)) }
        }.toString()).commit()
        check(persisted) { "could not persist the photo access budget" }
        decision
    }

    private fun readHistory(): List<PhonePhotoAccessGrant> = runCatching {
        val array = JSONArray(preferences.getString(HISTORY, "[]"))
        buildList {
            for (index in 0 until array.length()) {
                val entry = array.optJSONObject(index) ?: continue
                val at = entry.optLong("at", -1)
                val count = entry.optInt("count", 0)
                if (at >= 0 && count in 1..PhoneActionRequest.MAX_PHOTO_SELECTION) {
                    add(PhonePhotoAccessGrant(at, count))
                }
            }
        }
    }.getOrDefault(emptyList())

    private companion object {
        const val STORE = "phone_photo_access_budget"
        const val HISTORY = "automatic-content-grants"
        val lock = Any()
    }
}
