package com.termbridge.android.content

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.termbridge.android.R
import com.termbridge.android.chat.SessionHostPin
import com.termbridge.android.chat.SessionPin
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.protocol.SessionFileProtocol
import com.termbridge.android.ui.applyWindowInsets
import java.util.concurrent.Executors

/** In-app image/Markdown viewer. Closing it does not end an active voice call. */
class ArtifactPreviewActivity : AppCompatActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private var reader: ArtifactReader? = null
    private var markdown: ArtifactMarkdown? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val location = intent.getStringExtra("location") ?: return finish()
        val target = ArtifactTarget.parse(location) ?: return finish()
        val session = intent.getStringExtra("session") ?: SessionFileProtocol.GLOBAL_SESSION
        val pin = SessionPin(intent.getStringExtra("host").orEmpty(), intent.getStringExtra("endpoint").orEmpty())
        val settings = SessionHostPin.resolve(pin, SettingsStore.load(this), SettingsStore.profiles(this)) ?: return finish()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(getColor(R.color.surface)) }
        val toolbar = MaterialToolbar(this).apply {
            title = Uri.decode(location.substringBefore('?').substringAfterLast('/')).take(80)
            setNavigationIcon(R.drawable.ic_arrow_back)
            setNavigationOnClickListener { finish() }
            menu.add(getString(R.string.content_copy_link)).setIcon(R.drawable.ic_copy).setOnMenuItemClickListener {
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Link", location)); true
            }
        }
        com.termbridge.android.ui.MenuAppearance.apply(this, toolbar.menu)
        root.addView(toolbar)
        val scroll = ScrollView(this)
        val text = TextView(this).apply {
            text = getString(R.string.content_loading); textSize = 16f; setTextColor(getColor(R.color.ink))
            val padding = (16 * resources.displayMetrics.density).toInt(); setPadding(padding, padding, padding, padding)
            setTextIsSelectable(true)
        }
        scroll.addView(text); root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root); applyWindowInsets(root)
        val source = ArtifactReader(settings, session, this).also { reader = it }
        val renderer = ArtifactMarkdown(this, source::read, { next -> open(this, next, session, settings.hostId, pin.endpointKey.ifEmpty { null }) }, location).also { markdown = it }
        worker.execute {
            val result = runCatching { source.read(target) }
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                result.fold(onSuccess = { data ->
                    if (target.image) {
                        // Decode outside the UI thread as well.
                        worker.execute {
                            val image = runCatching { renderer.bitmap(data) }
                            runOnUiThread {
                                if (isDestroyed || isFinishing) return@runOnUiThread
                                image.fold(onSuccess = { drawable ->
                                    scroll.removeAllViews()
                                    scroll.addView(ImageView(this).apply {
                                        adjustViewBounds = true; setImageDrawable(drawable)
                                        contentDescription = toolbar.title
                                        setOnLongClickListener { (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                                            .setPrimaryClip(ClipData.newPlainText("Image", location)); true }
                                    })
                                }, onFailure = { text.text = getString(R.string.content_failed) })
                            }
                        }
                    } else if (data.size <= 256 * 1024 && !data.contains(0.toByte())) {
                        if (target.markdown) renderer.bind(text, data.toString(Charsets.UTF_8))
                        else {
                            val content = data.toString(Charsets.UTF_8)
                            text.typeface = android.graphics.Typeface.MONOSPACE
                            text.textSize = 13f
                            val highlighted = runCatching {
                                com.termbridge.android.review.ReviewSyntaxHighlighter(applicationContext)
                                    .highlight(target.location, content)
                            }.getOrNull()
                            text.text = highlighted ?: content
                        }
                    } else text.setText(R.string.content_unsupported)
                }, onFailure = { text.text = getString(R.string.content_failed) + "\n" + (it.cause?.message ?: it.message).orEmpty().take(200) })
            }
        }
    }
    override fun onDestroy() { markdown?.close(); reader?.close(); worker.shutdownNow(); super.onDestroy() }
    companion object {
        fun open(
            context: Context,
            location: String,
            sessionId: String? = null,
            hostId: String? = null,
            endpointKey: String? = null,
        ) {
            val target = ArtifactTarget.parse(location) ?: return
            if (target.remote && !target.image && !target.markdown) {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target.location))) }; return
            }
            val settings = SettingsStore.load(context)
            val pin = if (!endpointKey.isNullOrBlank()) {
                SessionPin(hostId.orEmpty(), endpointKey)
            } else {
                SessionHostPin.pin(hostId, settings, SettingsStore.profiles(context)) ?: return
            }
            context.startActivity(Intent(context, ArtifactPreviewActivity::class.java)
                .putExtra("location", target.location).putExtra("session", sessionId ?: SessionFileProtocol.GLOBAL_SESSION)
                .putExtra("host", pin.hostId).putExtra("endpoint", pin.endpointKey))
        }
    }
}
