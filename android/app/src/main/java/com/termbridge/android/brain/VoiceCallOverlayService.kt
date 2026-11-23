package com.termbridge.android.brain

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.LinearLayout
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.termbridge.android.R
import kotlin.math.abs

/** Keeps an active Voice Brain call visible and microphone-capable outside the app. */
class VoiceCallOverlayService : Service() {
    private lateinit var windowManager: WindowManager
    private var overlayRoot: LinearLayout? = null
    private var orb: VoiceLevelView? = null
    private var actionMenu: LinearLayout? = null
    private var orbParams: WindowManager.LayoutParams? = null
    private var callSnapshot = VoiceCallUiState.current()
    private var notifiedMode: VoiceLevelView.Mode? = null
    private val visibilityHandler = Handler(Looper.getMainLooper())
    private val verifyVisibility = object : Runnable {
        override fun run() {
            val state = VoiceCallUiState.current()
            if (state.active && !state.surfaceVisible &&
                (!Settings.canDrawOverlays(this@VoiceCallOverlayService) || overlayRoot?.isShown != true)) {
                VoiceCallOwnership.shared.stopActive("overlay_visibility_lost")
            }
            if (VoiceCallUiState.current().active) visibilityHandler.postDelayed(this, 1_000)
        }
    }

    private val callListener: (VoiceCallUiState.Snapshot) -> Unit = { snapshot ->
        callSnapshot = snapshot
        if (!snapshot.active) {
            stopSelf()
        } else {
            renderOverlay()
        }
    }

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WindowManager::class.java)
        createNotificationChannel()
        promoteToForeground()
        VoiceCallUiState.addListener(callListener)
        visibilityHandler.postDelayed(verifyVisibility, 1_000)
    }

    private fun promoteToForeground() {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                0
            },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Each startForegroundService request must be acknowledged, including
        // repeat starts and a call cancelled before this command was delivered.
        promoteToForeground()
        if (!VoiceCallUiState.current().active) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_HANGUP -> {
                VoiceCallOwnership.shared.stopActive("notification_hangup")
                stopSelf()
                return START_NOT_STICKY
            }
        }
        renderOverlay()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        VoiceCallUiState.removeListener(callListener)
        visibilityHandler.removeCallbacksAndMessages(null)
        removeOrb()
        if (callSnapshot.active) {
            VoiceCallOwnership.shared.stopActive("overlay_service_stopped")
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun renderOverlay() {
        val allowed = Settings.canDrawOverlays(this)
        if (callSnapshot.active && !callSnapshot.surfaceVisible && !allowed) {
            VoiceCallOwnership.shared.stopActive("overlay_permission_missing")
            return
        }
        updateNotification()
        if (!VoiceOverlayPolicy.shouldShow(callSnapshot.active, callSnapshot.surfaceVisible, allowed)) {
            removeOrb()
            return
        }
        if (overlayRoot == null) addOrb(createOverlay())
        val view = orb ?: return
        view.setMode(callSnapshot.mode)
        view.setLevel(callSnapshot.level)
        view.contentDescription = if (callSnapshot.attachmentCount > 0) {
            getString(R.string.voice_call_return_with_images, callSnapshot.attachmentCount)
        } else {
            getString(R.string.voice_call_return)
        }
    }

    private fun createOverlay(): LinearLayout = object : LinearLayout(this) {
        override fun onDetachedFromWindow() {
            super.onDetachedFromWindow()
            val state = VoiceCallUiState.current()
            if (state.active && !state.surfaceVisible) {
                VoiceCallOwnership.shared.stopActive("overlay_detached")
            }
        }
    }.apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        clipChildren = false
        clipToPadding = false
        addView(createOrb(), LinearLayout.LayoutParams(dp(68), dp(68)))
        addView(createActionMenu().also { actionMenu = it })
    }

    private fun createOrb(): VoiceLevelView = VoiceLevelView(this).apply {
        orb = this
        setCompactMode(true)
        contentDescription = getString(R.string.voice_overlay_actions)
        elevation = 0f // Shader supplies the soft halo; no heavy platform shadow around the orb.
        setOnClickListener { openCall() }
        setOnLongClickListener { toggleActions(); true }
        setOnTouchListener(OrbTouchListener())
    }

    private fun createActionMenu(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        visibility = View.GONE
        addView(actionButton(R.drawable.ic_screen_capture, R.string.voice_overlay_capture_screen) {
            collapseActions()
            startActivity(VoiceOverlayActionActivity.captureScreenIntent(this@VoiceCallOverlayService))
        })
        addView(actionButton(R.drawable.ic_attach, R.string.voice_overlay_pick_images) {
            collapseActions()
            startActivity(VoiceOverlayActionActivity.pickImagesIntent(this@VoiceCallOverlayService))
        })
    }

    private fun actionButton(icon: Int, label: Int, action: () -> Unit): ImageButton = ImageButton(this).apply {
        val size = dp(44)
        layoutParams = LinearLayout.LayoutParams(size, size).apply { topMargin = dp(6) }
        setImageResource(icon)
        setColorFilter(Color.WHITE)
        contentDescription = getString(label)
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.argb(218, 28, 34, 36))
            setStroke(dp(1), Color.argb(70, 255, 255, 255))
        }
        elevation = dp(10).toFloat()
        setPadding(dp(11), dp(11), dp(11), dp(11))
        setOnClickListener { action() }
    }

    private fun toggleActions() {
        actionMenu?.visibility = if (actionMenu?.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    private fun collapseActions() {
        actionMenu?.visibility = View.GONE
    }

    private fun addOrb(view: LinearLayout) {
        val size = dp(68)
        val preferences = getSharedPreferences(POSITION_PREFERENCES, MODE_PRIVATE)
        val screenWidth = resources.displayMetrics.widthPixels
        view.measure(View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        val params = WindowManager.LayoutParams(
            size,
            WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            },
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = preferences.getInt(KEY_X, (screenWidth - size - dp(16)).coerceAtLeast(0))
                .coerceIn(0, (screenWidth - size).coerceAtLeast(0))
            y = preferences.getInt(KEY_Y, dp(132))
                .coerceIn(0, (resources.displayMetrics.heightPixels - view.measuredHeight).coerceAtLeast(0))
        }
        runCatching { windowManager.addView(view, params) }
            .onSuccess {
                overlayRoot = view
                orbParams = params
                VoiceCallUiState.setOverlayVisible(true)
            }
            .onFailure {
                orb = null
                actionMenu = null
                orbParams = null
                VoiceCallUiState.setOverlayVisible(false)
                VoiceCallOwnership.shared.stopActive("overlay_add_failed")
            }
    }

    private fun removeOrb() {
        val view = overlayRoot ?: run { VoiceCallUiState.setOverlayVisible(false); return }
        overlayRoot = null
        orb = null
        actionMenu = null
        orbParams = null
        runCatching { windowManager.removeView(view) }
        VoiceCallUiState.setOverlayVisible(false)
    }

    private fun openCall() {
        startActivity(
            BrainActivity.intent(this).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            ),
        )
    }

    private inner class OrbTouchListener : View.OnTouchListener {
        private val touchSlop = ViewConfiguration.get(this@VoiceCallOverlayService).scaledTouchSlop
        private var downRawX = 0f
        private var downRawY = 0f
        private var downX = 0
        private var downY = 0
        private var dragged = false
        private var longPressed = false
        private var longPress: Runnable? = null

        override fun onTouch(target: View, event: MotionEvent): Boolean {
            val params = orbParams ?: return false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    downX = params.x
                    downY = params.y
                    dragged = false
                    longPressed = false
                    longPress = Runnable {
                        if (!dragged && VoiceCallUiState.current().active) longPressed = target.performLongClick()
                    }.also { visibilityHandler.postDelayed(it, ViewConfiguration.getLongPressTimeout().toLong()) }
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downRawX
                    val dy = event.rawY - downRawY
                    if (abs(dx) > touchSlop || abs(dy) > touchSlop) {
                        dragged = true
                        cancelLongPress()
                    }
                    if (dragged) {
                        val root = overlayRoot ?: return false
                        val width = resources.displayMetrics.widthPixels
                        val height = resources.displayMetrics.heightPixels
                        params.x = (downX + dx.toInt()).coerceIn(0, (width - root.width).coerceAtLeast(0))
                        params.y = (downY + dy.toInt()).coerceIn(0, (height - root.height).coerceAtLeast(0))
                        runCatching { windowManager.updateViewLayout(root, params) }
                    }
                    return true
                }
                MotionEvent.ACTION_UP -> {
                    cancelLongPress()
                    if (dragged) {
                        getSharedPreferences(POSITION_PREFERENCES, MODE_PRIVATE).edit()
                            .putInt(KEY_X, params.x)
                            .putInt(KEY_Y, params.y)
                            .apply()
                    } else if (!longPressed) {
                        target.performClick()
                    }
                    return true
                }
                MotionEvent.ACTION_CANCEL -> {
                    cancelLongPress()
                    return true
                }
            }
            return false
        }

        private fun cancelLongPress() {
            longPress?.let(visibilityHandler::removeCallbacks)
            longPress = null
        }
    }

    private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(getString(R.string.voice_overlay_notification_title))
        .setContentText(getString(statusText()))
        .addAction(R.drawable.ic_call_end, getString(R.string.voice_call_end), PendingIntent.getService(
            this, 1, Intent(this, VoiceCallOverlayService::class.java).setAction(ACTION_HANGUP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ))
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                BrainActivity.intent(this).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setOngoing(true)
        .setSilent(true)
        .build()

    private fun statusText(): Int = when (callSnapshot.mode) {
        VoiceLevelView.Mode.WAITING_WAKE -> R.string.voice_wake_standby
        VoiceLevelView.Mode.CONNECTING -> R.string.voice_orb_connecting
        VoiceLevelView.Mode.LISTENING -> R.string.voice_orb_listening
        VoiceLevelView.Mode.SPEAKING -> R.string.voice_orb_speaking
        VoiceLevelView.Mode.THINKING, VoiceLevelView.Mode.TOOL -> R.string.voice_orb_working
    }

    private fun updateNotification() {
        if (notifiedMode == callSnapshot.mode) return
        notifiedMode = callSnapshot.mode
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.voice_overlay_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply { setSound(null, null) },
        )
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val CHANNEL_ID = "voice_brain_call"
        private const val NOTIFICATION_ID = 43
        private const val POSITION_PREFERENCES = "voice_overlay_position"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"
        private const val ACTION_HANGUP = "com.termbridge.android.action.HANGUP_VOICE_CALL"
        private const val ACTION_HIDE_FOR_CAPTURE = "com.termbridge.android.action.HIDE_VOICE_OVERLAY_FOR_CAPTURE"
        private const val ACTION_SHOW_AFTER_CAPTURE = "com.termbridge.android.action.SHOW_VOICE_OVERLAY_AFTER_CAPTURE"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, VoiceCallOverlayService::class.java))
        }

        fun stop() {
            // Never stopService while startForegroundService is still pending:
            // Android can kill the process before onCreate gets to promote it.
            // An existing listener stops an acknowledged service; a new service
            // observes the inactive snapshot only after entering the foreground.
            VoiceCallOwnership.shared.stopActive("overlay_service_stop")
            VoiceCallUiState.setActive(false)
        }

        fun hideForCapture(context: Context) {
            // Keep the live microphone indicator visible even during screen
            // selection. A clean screenshot is not worth an invisible call.
            ContextCompat.startForegroundService(
                context,
                Intent(context, VoiceCallOverlayService::class.java).setAction(ACTION_HIDE_FOR_CAPTURE),
            )
        }

        fun showAfterCapture(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, VoiceCallOverlayService::class.java).setAction(ACTION_SHOW_AFTER_CAPTURE),
            )
        }
    }
}
