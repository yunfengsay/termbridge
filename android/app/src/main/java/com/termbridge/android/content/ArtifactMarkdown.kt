package com.termbridge.android.content

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.text.Spanned
import android.text.Spannable
import android.text.util.Linkify
import android.text.style.URLSpan
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.termbridge.android.R
import com.termbridge.android.review.ReviewPrismFactory
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import io.noties.markwon.MarkwonSpansFactory
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.image.*
import org.commonmark.node.Image
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import kotlin.math.abs

/** CommonMark rendering shared by Global messages and the document reader. */
class ArtifactMarkdown(private val context: Context, private val read: (ArtifactTarget) -> ByteArray,
    private val open: (String) -> Unit, private val base: String? = null) : AutoCloseable {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newFixedThreadPool(2)
    private val jobs = ConcurrentHashMap<AsyncDrawable, Future<*>>()
    private val gestures = java.util.WeakHashMap<TextView, Runnable>()
    private val rendered = java.util.WeakHashMap<TextView, Pair<String, java.lang.ref.WeakReference<CharSequence>>>()
    private val syntax = ReviewPrismFactory.create(
        context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES,
    )
    private var closed = false
    private val loader = object : AsyncDrawableLoader() {
        override fun load(drawable: AsyncDrawable) {
            if (closed || jobs.size >= 16) return
            val target = ArtifactTarget.parse(drawable.destination, base) ?: return
            jobs[drawable] = worker.submit {
                val result = runCatching { bitmap(read(target)) }.getOrNull()
                main.post { if (!closed && jobs.remove(drawable) != null && result != null) drawable.setResult(result) }
            }
        }
        override fun cancel(drawable: AsyncDrawable) { jobs.remove(drawable)?.cancel(true) }
        override fun placeholder(drawable: AsyncDrawable): Drawable? = null
    }
    private val markwon = Markwon.builder(context).usePlugin(object : AbstractMarkwonPlugin() {
        override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
            builder.syntaxHighlight(syntax).asyncDrawableLoader(loader).linkResolver { _, link -> openResolved(link) }
        }
        override fun configureTheme(builder: MarkwonTheme.Builder) {
            builder.codeTextColor(ContextCompat.getColor(context, R.color.ink))
                .codeBackgroundColor(ContextCompat.getColor(context, R.color.surface_variant))
        }
        override fun configureSpansFactory(builder: MarkwonSpansFactory.Builder) {
            builder.setFactory(Image::class.java) { config, props ->
                arrayOf(ImageSpanFactory().getSpans(config, props), object : URLSpan(ImageProps.DESTINATION.require(props)) {
                    override fun onClick(widget: android.view.View) { openResolved(url) }
                })
            }
        }
        override fun beforeSetText(textView: TextView, markdown: Spanned) { AsyncDrawableScheduler.unschedule(textView) }
        override fun afterSetText(textView: TextView) { AsyncDrawableScheduler.schedule(textView) }
    }).build()

    fun bind(view: TextView, text: String) {
        val previous = rendered[view]
        if (previous?.first == text && previous.second.get() === view.text) return
        gestures.remove(view)?.let { main.removeCallbacks(it) }
        markwon.setMarkdown(view, text)
        // Linkify only bare web addresses; existing CommonMark links stay intact.
        val spans = view.text as? Spannable
        if (spans != null) {
            val bare = android.text.SpannableString(spans.toString())
            Linkify.addLinks(bare, Linkify.WEB_URLS)
            bare.getSpans(0, bare.length, URLSpan::class.java).forEach { link ->
                val start = bare.getSpanStart(link); val end = bare.getSpanEnd(link)
                if (spans.getSpans(start, end, URLSpan::class.java).isNotEmpty()) return@forEach
                spans.setSpan(object : URLSpan(link.url) {
                    override fun onClick(widget: android.view.View) { openResolved(url) }
                }, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        installLinkGestures(view)
        rendered[view] = text to java.lang.ref.WeakReference(view.text)
    }
    private fun openResolved(link: String) { ArtifactTarget.parse(link, base)?.let { open(it.location) } }
    fun bitmap(bytes: ByteArray): Drawable {
        val info = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, info)
        require(info.outWidth > 0 && info.outHeight > 0) { "Unsupported image" }
        val options = BitmapFactory.Options().apply { inSampleSize = 1 }
        while (info.outWidth / options.inSampleSize > 2048 || info.outHeight / options.inSampleSize > 2048) options.inSampleSize *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("Unsupported image")
        return BitmapDrawable(context.resources, bitmap).apply { setBounds(0, 0, bitmap.width, bitmap.height) }
    }
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun installLinkGestures(view: TextView) {
        var held: URLSpan? = null; var copied = false; var startX = 0f; var startY = 0f
        val viewRef = java.lang.ref.WeakReference(view)
        val copy = Runnable {
            val targetView = viewRef.get() ?: return@Runnable
            held?.let { link ->
                val value = ArtifactTarget.parse(link.url, base)?.location ?: link.url
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Link", value))
                copied = true; targetView.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
            }
        }
        gestures[view] = copy
        view.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    val layout = view.layout ?: return@setOnTouchListener false
                    val x = event.x - view.totalPaddingLeft + view.scrollX
                    val y = event.y - view.totalPaddingTop + view.scrollY
                    val line = layout.getLineForVertical(y.toInt())
                    val offset = layout.getOffsetForHorizontal(line, x)
                    held = if (x >= layout.getLineLeft(line) && x <= layout.getLineRight(line))
                        (view.text as? Spanned)?.getSpans(offset, offset, URLSpan::class.java)?.firstOrNull() else null
                    copied = false; startX = event.x; startY = event.y
                    if (held != null) main.postDelayed(copy, ViewConfiguration.getLongPressTimeout().toLong())
                    held != null
                }
                MotionEvent.ACTION_MOVE -> {
                    if (abs(event.x - startX) + abs(event.y - startY) > ViewConfiguration.get(context).scaledTouchSlop) {
                        main.removeCallbacks(copy); held = null
                    }
                    held != null
                }
                MotionEvent.ACTION_UP -> {
                    main.removeCallbacks(copy)
                    val link = held; held = null
                    if (link != null && !copied) { view.performClick(); link.onClick(view) }
                    link != null
                }
                MotionEvent.ACTION_CANCEL -> { main.removeCallbacks(copy); held = null; false }
                else -> false
            }
        }
    }
    override fun close() { closed = true; jobs.values.forEach { it.cancel(true) }; jobs.clear(); worker.shutdownNow(); main.removeCallbacksAndMessages(null) }
}
