package com.termbridge.android.watch

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothManager
import android.content.pm.ServiceInfo
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.CountDownTimer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.app.ServiceCompat
import com.termbridge.android.MainActivity
import com.termbridge.android.R
import com.termbridge.android.TerminalActivity
import com.termbridge.android.notifications.AgentMonitorService
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.protocol.ControlMessage
import java.util.UUID
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import android.provider.CalendarContract
import android.provider.MediaStore
import android.provider.AlarmClock
import android.provider.Settings
import android.view.KeyEvent
import org.json.JSONObject
import android.util.Base64

/**
 * Phone-side bridge for the watch. The relay is always loaded from the active
 * Android profile; Cloudflare, a LAN relay and any other ws/wss endpoint are
 * deliberately indistinguishable here.
 */
class WatchGatewayService : Service(), WatchBleClient.Listener, TermbridgeClient.Listener {
    private val handler = Handler(Looper.getMainLooper())
    private var watchClient: WatchBleClient? = null
    private var hostClient: TermbridgeClient? = null
    private var voiceRequestId: String? = null
    private var watchReady = false
    private var voiceReady = false
    private var stopped = false
    private val pendingNotifications = ArrayDeque<ByteArray>()
    private val background = Executors.newSingleThreadExecutor()
    private var rideTracker: WatchRideTracker? = null
    private var fitnessSensors: WatchFitnessSensorClient? = null
    private var timer: CountDownTimer? = null
    private var activeRingtone: android.media.Ringtone? = null
    private var pendingWork: ByteArray? = null
    private var pendingNavigation: ByteArray? = null
    private val reconnectBackoff = WatchReconnectBackoff()
    private var reconnectDueAt = 0L
    private val reconnect = Runnable {
        reconnectDueAt = 0L
        connectWatch()
    }

    override fun onCreate() {
        super.onCreate()
        WatchRideTracker.repairIncompleteJournals(this)
        WatchSettingsStore.updateConnection(this, connected = false)
        pendingNotifications.addAll(loadNotificationHistory())
        pendingWork = loadWorkSnapshot()
        publishWatchState()
        createNotificationChannel()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification(getString(R.string.watch_connecting)),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopped = true
                WatchSettingsStore.clear(this)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_NOTIFY -> {
                intent.getByteArrayExtra(EXTRA_NOTIFICATION)?.let(::enqueueNotification)
                connectWatch()
                flushNotifications()
            }
            ACTION_WORK -> {
                intent.getByteArrayExtra(EXTRA_WORK)?.let {
                    pendingWork = it
                    saveWorkSnapshot(it)
                }
                connectWatch()
                flushWorkSnapshot()
            }
            ACTION_NAVIGATION -> {
                pendingNavigation = intent.getByteArrayExtra(EXTRA_NAVIGATION)
                connectWatch()
                flushNavigation()
            }
            ACTION_SYNC, null -> {
                connectWatch(force = true)
                // Explicit settings/profile syncs may re-provision an already
                // connected watch. Ordinary notification/work/navigation
                // pushes must not: those arrive every few seconds and used to
                // keep flooding the BLE link with the same profile.
                if (watchReady) provisionCurrentProfile()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        timer?.cancel()
        activeRingtone?.stop()
        activeRingtone = null
        rideTracker?.stop()
        fitnessSensors?.stop()
        background.shutdownNow()
        closeVoice(sendWatchStop = false)
        watchClient?.disconnect()
        watchClient = null
        WatchSettingsStore.updateConnection(this, connected = false)
        publishWatchState()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onWatchReady(client: WatchBleClient) {
        handler.removeCallbacks(reconnect)
        reconnectDueAt = 0L
        reconnectBackoff.reset()
        watchReady = true
        WatchSettingsStore.updateConnection(this, connected = true)
        publishWatchState()
        updateNotification(getString(R.string.watch_syncing_profile))
        pendingNotifications.clear()
        pendingNotifications.addAll(loadNotificationHistory())
        provisionCurrentProfile()
        sendActivitySnapshot(rideTracker?.snapshot() ?: idleActivity())
        syncDailySnapshot()
        flushWorkSnapshot()
        flushNavigation()
    }

    override fun onWatchMessage(message: WatchLinkMessage) {
        when (message.type) {
            WatchMessageType.HELLO -> provisionCurrentProfile()
            WatchMessageType.PROVISIONED -> onProfileProvisioned(message.payload)
            WatchMessageType.WATCH_STATUS -> runCatching {
                WatchStatusPayload.decode(message.payload)
            }.onSuccess { status ->
                WatchSettingsStore.updateTelemetry(this, status.batteryLevel, System.currentTimeMillis())
                publishWatchState()
                updateNotification(getString(R.string.watch_connected_with_battery, status.batteryLevel))
            }.onFailure {
                onWatchError(it.message ?: "Invalid watch status")
            }
            WatchMessageType.MOTION_STATUS -> runCatching { WatchMotionStatus.decode(message.payload) }
                .onFailure { onWatchError(it.message ?: "Invalid motion status") }
            WatchMessageType.VOICE_START -> startVoice()
            WatchMessageType.VOICE_INPUT_PCM -> {
                if (voiceReady && message.payload.isNotEmpty()) {
                    hostClient?.sendControl(
                        "t" to "brain_voice_input_audio",
                        "requestId" to voiceRequestId,
                        "data" to message.payload,
                    )
                }
            }
            WatchMessageType.VOICE_COMMIT -> hostClient?.sendControl(
                "t" to "brain_voice_commit",
                "requestId" to voiceRequestId,
            )
            WatchMessageType.VOICE_CANCEL -> hostClient?.sendControl(
                "t" to "brain_voice_cancel",
                "requestId" to voiceRequestId,
            )
            WatchMessageType.VOICE_STOP -> closeVoice(sendWatchStop = false)
            WatchMessageType.OPEN_CONVERSATION -> runCatching {
                WatchNotificationPayload.decodeConversationOpen(message.payload)
            }.onSuccess { route ->
                val payload = WatchNotificationPayload(
                    hostId = route.hostId,
                    sessionId = route.sessionId,
                    title = route.title.ifBlank { getString(R.string.task_complete) },
                    body = "",
                    completedAt = System.currentTimeMillis(),
                )
                AgentMonitorService.publishCompletion(this, payload, openImmediately = true)
            }
            WatchMessageType.ACTIVITY_COMMAND -> runCatching { WatchAction.decode(message.payload) }
                .onSuccess(::handleActivityAction)
                .onFailure { onWatchError(it.message ?: "Invalid activity action") }
            WatchMessageType.PHONE_ACTION -> runCatching { WatchAction.decode(message.payload) }
                .onSuccess(::handlePhoneAction)
                .onFailure { onWatchError(it.message ?: "Invalid phone action") }
        }
    }

    override fun onWatchDisconnected() {
        watchClient = null
        watchReady = false
        WatchSettingsStore.updateConnection(this, connected = false)
        publishWatchState()
        closeVoice(sendWatchStop = false)
        updateNotification(getString(R.string.watch_disconnected))
        if (!stopped && WatchSettingsStore.load(this).paired) {
            scheduleReconnect()
        }
    }

    override fun onWatchError(message: String) {
        updateNotification(message.take(80))
    }

    override fun onConnectionState(state: ConnectionState) {
        when (state) {
            ConnectionState.Connecting, ConnectionState.Authenticating -> sendWatchStatus("connecting")
            ConnectionState.Connected -> Unit
            ConnectionState.Disconnected -> failVoice(getString(R.string.watch_host_disconnected))
            is ConnectionState.Failed -> failVoice(state.message)
        }
    }

    override fun onReady(client: TermbridgeClient) {
        val requestId = voiceRequestId ?: return
        client.sendControl(
            "t" to "brain_voice_start",
            "requestId" to requestId,
            "locale" to "zh-CN",
            "sendKeyword" to "发送",
            "mode" to "call",
            "outputMode" to "voice",
        )
    }

    override fun onControl(message: ControlMessage) {
        val requestId = voiceRequestId ?: return
        if (message.string("requestId") != null && message.string("requestId") != requestId) return
        when (message.type) {
            "brain_voice_ready" -> {
                voiceReady = true
                watchClient?.send(WatchMessageType.VOICE_READY)
                sendWatchStatus("listening")
            }
            "brain_voice_transcript", "brain_voice_text" -> {
                val text = message.string("text").orEmpty().take(MAX_WATCH_TEXT)
                if (text.isNotEmpty()) watchClient?.send(WatchMessageType.VOICE_TEXT, text.toByteArray())
            }
            "brain_voice_output_audio" -> message.bytes("data")?.let { pcm ->
                if (pcm.isNotEmpty()) watchClient?.send(WatchMessageType.VOICE_OUTPUT_PCM, pcm, streaming = true)
            }
            "brain_voice_status" -> sendWatchStatus(message.string("status").orEmpty())
            "brain_voice_error", "error" -> failVoice(
                message.string("error") ?: message.string("message") ?: getString(R.string.watch_voice_failed),
            )
            "brain_voice_stopped" -> closeVoice(sendWatchStop = true)
        }
    }

    override fun onPtyOutput(sid: Int, data: ByteArray) = Unit

    private fun connectWatch(force: Boolean = false) {
        if (!hasBluetoothPermission()) {
            updateNotification(getString(R.string.watch_permission_required))
            return
        }
        val settings = WatchSettingsStore.load(this)
        if (!settings.paired || watchClient != null) {
            if (!settings.paired) stopSelf()
            return
        }
        if (!force && reconnectDueAt > SystemClock.elapsedRealtime()) return
        handler.removeCallbacks(reconnect)
        reconnectDueAt = 0L
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        val device = runCatching { adapter?.getRemoteDevice(settings.deviceAddress) }.getOrNull()
        if (device == null) {
            updateNotification(getString(R.string.watch_disconnected))
            return
        }
        val client = WatchBleClient(this, device, this)
        watchClient = client
        client.connect()
    }

    private fun scheduleReconnect() {
        val delay = reconnectBackoff.nextDelayMillis()
        reconnectDueAt = SystemClock.elapsedRealtime() + delay
        handler.removeCallbacks(reconnect)
        handler.postDelayed(reconnect, delay)
    }

    private fun provisionCurrentProfile() {
        if (!watchReady) return
        val watch = WatchSettingsStore.load(this)
        val current = SettingsStore.load(this)
        val provisioning = WatchProvisioning.current(
            current,
            watch.transport,
            negotiatedAttMtu = watchClient?.negotiatedAttMtu ?: WatchProvisioning.DEFAULT_ATT_MTU,
        )
        if (watchClient?.send(WatchMessageType.PROVISION, provisioning.encode()) != true) {
            updateNotification(getString(R.string.watch_sync_failed))
        } else {
            updateNotification(getString(R.string.watch_syncing_profile))
        }
    }

    private fun onProfileProvisioned(payload: ByteArray) {
        val current = SettingsStore.load(this)
        val acknowledgedKey = payload.toString(Charsets.UTF_8)
        if (acknowledgedKey.isNotEmpty() && acknowledgedKey != current.profileKey) {
            provisionCurrentProfile()
            return
        }
        updateNotification(getString(R.string.watch_ready_with_profile, current.displayName))
        flushNotifications()
        sendActivitySnapshot(rideTracker?.snapshot() ?: idleActivity())
        syncDailySnapshot()
    }

    private fun enqueueNotification(payload: ByteArray) {
        if (payload.isEmpty()) return
        while (pendingNotifications.size >= MAX_PENDING_NOTIFICATIONS) pendingNotifications.removeFirst()
        pendingNotifications.addLast(payload)
        saveNotificationHistory(payload)
    }

    private fun flushNotifications() {
        if (!watchReady) return
        while (pendingNotifications.isNotEmpty()) {
            val payload = pendingNotifications.first()
            if (watchClient?.send(WatchMessageType.AGENT_NOTIFICATION, payload) != true) return
            pendingNotifications.removeFirst()
        }
    }

    private fun flushWorkSnapshot() {
        if (!watchReady) return
        pendingWork?.let { watchClient?.send(WatchMessageType.WORK_SNAPSHOT, it) }
    }

    private fun flushNavigation() {
        if (!watchReady) return
        pendingNavigation?.let { payload ->
            if (watchClient?.send(WatchMessageType.NAVIGATION_CUE, payload) == true) {
                pendingNavigation = null
            }
        }
    }

    private fun saveNotificationHistory(payload: ByteArray) {
        val history = loadNotificationHistory().toMutableList()
        val identity = runCatching { WatchNotificationPayload.decode(payload) }.getOrNull()
        if (identity != null) {
            history.removeAll {
                runCatching { WatchNotificationPayload.decode(it) }.getOrNull()?.let { old ->
                    old.hostId == identity.hostId && old.sessionId == identity.sessionId &&
                        old.completedAt == identity.completedAt
                } == true
            }
        }
        history += payload
        while (history.size > MAX_PENDING_NOTIFICATIONS) history.removeAt(0)
        getSharedPreferences(HISTORY_STORE, MODE_PRIVATE).edit().apply {
            putInt("count", history.size)
            repeat(MAX_PENDING_NOTIFICATIONS) { index ->
                if (index < history.size) putString("notification:$index", Base64.encodeToString(history[index], Base64.NO_WRAP))
                else remove("notification:$index")
            }
        }.apply()
    }

    private fun loadNotificationHistory(): List<ByteArray> {
        val store = getSharedPreferences(HISTORY_STORE, MODE_PRIVATE)
        return (0 until store.getInt("count", 0).coerceIn(0, MAX_PENDING_NOTIFICATIONS)).mapNotNull { index ->
            store.getString("notification:$index", null)?.let {
                runCatching { Base64.decode(it, Base64.NO_WRAP) }.getOrNull()
            }
        }
    }

    private fun saveWorkSnapshot(payload: ByteArray) {
        getSharedPreferences(HISTORY_STORE, MODE_PRIVATE).edit()
            .putString("work", Base64.encodeToString(payload, Base64.NO_WRAP)).apply()
    }

    private fun loadWorkSnapshot(): ByteArray? = getSharedPreferences(HISTORY_STORE, MODE_PRIVATE)
        .getString("work", null)?.let { runCatching { Base64.decode(it, Base64.NO_WRAP) }.getOrNull() }

    private fun handleActivityAction(action: WatchAction) {
        when (action.action) {
            "start" -> startRide()
            "pause" -> rideTracker?.pause()
            "resume" -> rideTracker?.resume()
            "stop" -> stopRide(false)
            "discard" -> stopRide(true)
            "lap" -> sendActivitySnapshot(rideTracker?.snapshot() ?: idleActivity())
        }
    }

    private fun startRide() {
        if (!hasLocationPermission()) {
            updateNotification(getString(R.string.watch_location_permission_required))
            sendActivitySnapshot(idleActivity().copy(label = getString(R.string.watch_location_permission_required)))
            return
        }
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification(getString(R.string.watch_ride_active)),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
        )
        rideTracker?.stop()
        rideTracker = WatchRideTracker(this, ::sendActivitySnapshot).also { it.start() }
        fitnessSensors?.stop()
        fitnessSensors = WatchFitnessSensorClient(this) { heartRate, cadence ->
            rideTracker?.updateFitnessSensors(heartRate, cadence)
        }.also { it.start() }
    }

    private fun stopRide(discard: Boolean) {
        fitnessSensors?.stop()
        fitnessSensors = null
        rideTracker?.stop(discard)
        rideTracker = null
    }

    private fun sendActivitySnapshot(snapshot: WatchActivitySnapshot) {
        watchClient?.send(WatchMessageType.ACTIVITY_SNAPSHOT, snapshot.encode())
        if (snapshot.active) updateNotification(getString(R.string.watch_ride_distance, snapshot.distanceMeters / 1000.0))
    }

    private fun idleActivity() = WatchActivitySnapshot(
        active = false,
        paused = false,
        elapsedSeconds = 0,
        speedCentiKph = 0,
        distanceMeters = 0,
        elevationDecimeters = 0,
        gpsAccuracyDecimeters = 0,
    )

    private fun handlePhoneAction(action: WatchAction) {
        when (action.action) {
            "find_phone" -> ringPhone()
            "toggle_dnd" -> toggleDoNotDisturb()
            "timer_10m" -> startTimer(10 * 60_000L)
            "music_play_pause" -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
            "music_next" -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_NEXT)
            "camera" -> runCatching {
                startActivity(Intent(MediaStore.ACTION_IMAGE_CAPTURE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            "alarm" -> runCatching {
                startActivity(Intent(AlarmClock.ACTION_SET_ALARM).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            "continue", "open", "approve" -> openWorkSession(action.hostId, action.sessionId)
            "later" -> getSharedPreferences("watch_work", MODE_PRIVATE).edit()
                .putLong("later:${action.hostId}:${action.sessionId}", System.currentTimeMillis() + 30 * 60_000L)
                .apply()
        }
        if (action.action == "toggle_dnd") syncDailySnapshot()
    }

    private fun ringPhone() {
        activeRingtone?.stop()
        val ringtone = RingtoneManager.getRingtone(
            this,
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
        )
        activeRingtone = ringtone
        ringtone.play()
        handler.postDelayed({
            if (activeRingtone === ringtone) {
                if (ringtone.isPlaying) ringtone.stop()
                activeRingtone = null
            }
        }, 15_000L)
    }

    private fun startTimer(durationMillis: Long) {
        timer?.cancel()
        timer = object : CountDownTimer(durationMillis, 1_000L) {
            override fun onTick(millisUntilFinished: Long) = Unit
            override fun onFinish() {
                ringPhone()
                watchClient?.send(
                    WatchMessageType.NAVIGATION_CUE,
                    WatchNavigationCue(
                        0,
                        getString(R.string.watch_timer_complete),
                        kind = "timer",
                    ).encode(),
                )
            }
        }.start()
    }

    private fun toggleDoNotDisturb() {
        val manager = getSystemService(NotificationManager::class.java)
        if (!manager.isNotificationPolicyAccessGranted) {
            updateNotification(getString(R.string.watch_dnd_permission_required))
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            return
        }
        manager.setInterruptionFilter(
            if (manager.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALL) {
                NotificationManager.INTERRUPTION_FILTER_PRIORITY
            } else {
                NotificationManager.INTERRUPTION_FILTER_ALL
            },
        )
    }

    private fun dispatchMediaKey(keyCode: Int) {
        val audio = getSystemService(AudioManager::class.java)
        audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
    }

    private fun openWorkSession(hostId: String, sessionId: String) {
        if (sessionId.isBlank()) return
        startActivity(
            TerminalActivity.attachIntent(this, sessionId, "TermBridge", true, hostId.ifBlank { null })
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    private fun syncDailySnapshot() {
        if (!watchReady) return
        background.execute {
            val agenda = nextAgenda()
            val weather = currentWeather()
            val manager = getSystemService(NotificationManager::class.java)
            val payload = WatchDailySnapshot(
                temperatureDeciC = weather.first,
                weather = weather.second,
                agendaTitle = agenda.first,
                agendaAt = agenda.second,
                doNotDisturb = manager.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL,
            )
            handler.post { watchClient?.send(WatchMessageType.DAILY_SNAPSHOT, payload.encode()) }
        }
    }

    private fun nextAgenda(): Pair<String, Long> {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED) {
            return "日历未授权" to 0L
        }
        val now = System.currentTimeMillis()
        val end = now + 48 * 60 * 60_000L
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
            .appendPath(now.toString()).appendPath(end.toString()).build()
        return runCatching {
            contentResolver.query(
                uri,
                arrayOf(CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN),
                null, null,
                "${CalendarContract.Instances.BEGIN} ASC",
            )?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0).orEmpty() to cursor.getLong(1) else "" to 0L
            } ?: ("" to 0L)
        }.getOrDefault("" to 0L)
    }

    @Suppress("MissingPermission")
    private fun currentWeather(): Pair<Int, String> {
        if (!hasLocationPermission()) return 0 to "天气需定位"
        val now = System.currentTimeMillis()
        val cache = getSharedPreferences(WEATHER_STORE, MODE_PRIVATE)
        val cachedAt = cache.getLong("fetchedAt", 0L)
        if (cache.contains("temperature") && now - cachedAt in 0..WEATHER_CACHE_MS) {
            return cache.getInt("temperature", 0) to cache.getString("label", "").orEmpty()
        }
        val manager = getSystemService(LocationManager::class.java)
        val location = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .filter { now - it.time in 0..MAX_WEATHER_LOCATION_AGE_MS }
            .maxByOrNull { it.time } ?: return 0 to "天气待定位"
        return runCatching {
            val endpoint = URL(
                "https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}" +
                    "&longitude=${location.longitude}&current=temperature_2m,weather_code",
            )
            val connection = endpoint.openConnection() as HttpURLConnection
            connection.connectTimeout = 5_000
            connection.readTimeout = 5_000
            connection.setRequestProperty("User-Agent", "TermBridge-Android")
            try {
                val json = connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
                val current = json.getJSONObject("current")
                val result = (current.getDouble("temperature_2m") * 10).toInt() to
                    weatherLabel(current.getInt("weather_code"))
                cache.edit()
                    .putInt("temperature", result.first)
                    .putString("label", result.second)
                    .putLong("fetchedAt", now)
                    .apply()
                result
            } finally {
                connection.disconnect()
            }
        }.getOrDefault(0 to "天气暂不可用")
    }

    private fun weatherLabel(code: Int): String = when (code) {
        0 -> "晴"
        1, 2 -> "少云"
        3 -> "阴"
        45, 48 -> "雾"
        in 51..67, in 80..82 -> "雨"
        in 71..77, in 85..86 -> "雪"
        in 95..99 -> "雷雨"
        else -> "多云"
    }

    private fun startVoice() {
        val watch = WatchSettingsStore.load(this)
        if (watch.transport == WatchTransport.WIFI) {
            sendWatchStatus("wifi")
            return
        }
        closeVoice(sendWatchStop = false)
        watchClient?.setVoiceStreaming(true)
        voiceRequestId = "watch-${UUID.randomUUID()}"
        voiceReady = false
        sendWatchStatus("connecting")
        val current = SettingsStore.load(this)
        current.validationError()?.let {
            failVoice(it)
            return
        }
        hostClient = TermbridgeClient(current, this).also(TermbridgeClient::connect)
    }

    private fun sendWatchStatus(status: String) {
        if (status.isNotBlank()) watchClient?.send(WatchMessageType.VOICE_STATUS, status.take(64).toByteArray())
    }

    private fun failVoice(message: String) {
        watchClient?.send(WatchMessageType.VOICE_STATUS, "error:${message.take(120)}".toByteArray())
        closeVoice(sendWatchStop = true)
    }

    private fun closeVoice(sendWatchStop: Boolean) {
        val requestId = voiceRequestId
        if (requestId != null) {
            hostClient?.sendControl("t" to "brain_voice_stop", "requestId" to requestId)
        }
        hostClient?.disconnect()
        hostClient = null
        voiceRequestId = null
        voiceReady = false
        if (sendWatchStop) watchClient?.send(WatchMessageType.VOICE_STOP)
        if (requestId != null) watchClient?.setVoiceStreaming(false)
    }

    private fun hasBluetoothPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.watch_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.status_dot_active)
        .setContentTitle(getString(R.string.watch_notification_title))
        .setContentText(text)
        .setOngoing(true)
        .setSilent(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, WatchSettingsActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .build()

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    private fun publishWatchState() {
        sendBroadcast(Intent(ACTION_WATCH_STATE_CHANGED).setPackage(packageName))
    }

    companion object {
        private const val ACTION_SYNC = "com.termbridge.android.watch.SYNC"
        private const val ACTION_STOP = "com.termbridge.android.watch.STOP"
        private const val ACTION_NOTIFY = "com.termbridge.android.watch.NOTIFY"
        private const val ACTION_WORK = "com.termbridge.android.watch.WORK"
        private const val ACTION_NAVIGATION = "com.termbridge.android.watch.NAVIGATION"
        const val ACTION_WATCH_STATE_CHANGED = "com.termbridge.android.watch.STATE_CHANGED"
        private const val EXTRA_NOTIFICATION = "notification"
        private const val EXTRA_WORK = "work"
        private const val EXTRA_NAVIGATION = "navigation"
        private const val HISTORY_STORE = "watch_history"
        private const val WEATHER_STORE = "watch_weather"
        private const val CHANNEL_ID = "termbridge_watch"
        private const val NOTIFICATION_ID = 4307
        private const val MAX_WATCH_TEXT = 1_024
        private const val MAX_PENDING_NOTIFICATIONS = 8
        private const val WEATHER_CACHE_MS = 30 * 60_000L
        private const val MAX_WEATHER_LOCATION_AGE_MS = 6 * 60 * 60_000L

        fun sync(context: Context) {
            if (!WatchSettingsStore.load(context).paired) return
            val intent = Intent(context, WatchGatewayService::class.java).setAction(ACTION_SYNC)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stopAndForget(context: Context) {
            context.startService(Intent(context, WatchGatewayService::class.java).setAction(ACTION_STOP))
        }

        fun pushCompletion(context: Context, payload: WatchNotificationPayload) {
            if (!WatchSettingsStore.load(context).paired) return
            val intent = Intent(context, WatchGatewayService::class.java)
                .setAction(ACTION_NOTIFY)
                .putExtra(EXTRA_NOTIFICATION, payload.encode())
            ContextCompat.startForegroundService(context, intent)
        }

        fun pushWork(context: Context, payload: WatchWorkSnapshot) {
            if (!WatchSettingsStore.load(context).paired) return
            val intent = Intent(context, WatchGatewayService::class.java)
                .setAction(ACTION_WORK)
                .putExtra(EXTRA_WORK, payload.encode())
            ContextCompat.startForegroundService(context, intent)
        }

        fun pushNavigation(context: Context, cue: WatchNavigationCue) {
            if (!WatchSettingsStore.load(context).paired) return
            val intent = Intent(context, WatchGatewayService::class.java)
                .setAction(ACTION_NAVIGATION)
                .putExtra(EXTRA_NAVIGATION, cue.encode())
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
