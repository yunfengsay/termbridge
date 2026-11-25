package com.termbridge.android.content

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.style.BackgroundColorSpan
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.MediaController
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.widget.VideoView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.termbridge.android.R
import com.termbridge.android.chat.SessionHostPin
import com.termbridge.android.chat.SessionPin
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.protocol.SessionFileProtocol
import com.termbridge.android.ui.applyWindowInsets
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors

/** In-app viewer for images, SVG, HTML, PDF, Markdown, source code, media, and external handoff. */
class ArtifactPreviewActivity : AppCompatActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private var reader: ArtifactReader? = null
    private var markdown: ArtifactMarkdown? = null
    private var previewWebView: WebView? = null
    private var videoView: VideoView? = null
    private var tempFile: File? = null
    private var loadedBytes: ByteArray? = null
    private var showingSource = false

    private lateinit var toolbar: MaterialToolbar
    private lateinit var contentHost: FrameLayout
    private lateinit var scroll: ScrollView
    private lateinit var text: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val location = intent.getStringExtra("location") ?: return finish()
        val parsed = ArtifactTarget.parse(location) ?: return finish()
        val extraLine = intent.getIntExtra("line", 0).takeIf { it > 0 }
        val extraEndLine = intent.getIntExtra("endLine", 0).takeIf { it > 0 }
        val target = parsed.copy(
            line = parsed.line ?: extraLine,
            endLine = parsed.endLine ?: extraEndLine,
        )
        val session = intent.getStringExtra("session") ?: SessionFileProtocol.GLOBAL_SESSION
        val pin = SessionPin(intent.getStringExtra("host").orEmpty(), intent.getStringExtra("endpoint").orEmpty())
        val settings = SessionHostPin.resolve(pin, SettingsStore.load(this), SettingsStore.profiles(this)) ?: return finish()

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(getColor(R.color.surface)) }
        val fileName = Uri.decode(target.location.substringBefore('?').substringAfterLast('/')).take(80)
        val lineLabel = target.line?.let { start ->
            val end = target.endLine?.takeIf { it > start }
            if (end != null) "L$start–$end" else "L$start"
        }
        toolbar = MaterialToolbar(this).apply {
            title = fileName
            if (lineLabel != null) subtitle = lineLabel
            setNavigationIcon(R.drawable.ic_arrow_back)
            setNavigationOnClickListener { finish() }
            menu.add(getString(R.string.content_copy_link)).setIcon(R.drawable.ic_copy).setOnMenuItemClickListener {
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Link", location)); true
            }
        }
        com.termbridge.android.ui.MenuAppearance.apply(this, toolbar.menu)
        root.addView(toolbar)

        contentHost = FrameLayout(this)
        scroll = ScrollView(this)
        text = TextView(this).apply {
            text = getString(R.string.content_loading); textSize = 15f; setTextColor(getColor(R.color.ink))
            val padding = (16 * resources.displayMetrics.density).toInt(); setPadding(padding, padding, padding, padding)
            setTextIsSelectable(true)
        }
        scroll.addView(text)
        contentHost.addView(scroll, FrameLayout.LayoutParams(-1, -1))
        root.addView(contentHost, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root); applyWindowInsets(root)

        val source = ArtifactReader(settings, session, this).also { reader = it }
        val renderer = ArtifactMarkdown(this, source::read, { next -> open(this, next, session, settings.hostId, pin.endpointKey.ifEmpty { null }) }, location).also { markdown = it }

        worker.execute {
            val result = runCatching { source.read(target) }
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                result.fold(
                    onSuccess = { data ->
                        loadedBytes = data
                        addOpenWithMenuItem(fileName, target, data)
                        renderArtifact(target, data, fileName, renderer)
                    },
                    onFailure = {
                        text.text = getString(R.string.content_failed) + "\n" + (it.cause?.message ?: it.message).orEmpty().take(200)
                    },
                )
            }
        }
    }

    private fun renderArtifact(target: ArtifactTarget, data: ByteArray, fileName: String, renderer: ArtifactMarkdown) {
        when {
            target.svg -> {
                addSourceToggleMenuItem { renderSvgOrSource(target, data) }
                renderSvgOrSource(target, data)
            }
            target.html -> {
                addSourceToggleMenuItem { renderHtmlOrSource(target, data) }
                renderHtmlOrSource(target, data)
            }
            target.pdf -> renderPdf(data)
            target.image -> renderImage(target, data, renderer)
            target.video || target.audio -> renderMedia(fileName, target, data)
            isLikelyText(data) -> renderText(target, data, renderer)
            else -> renderBinaryFallback(fileName, target, data)
        }
    }

    private fun addSourceToggleMenuItem(onToggle: () -> Unit) {
        val item = toolbar.menu.add(getString(R.string.content_toggle_source))
        item.setOnMenuItemClickListener {
            showingSource = !showingSource
            item.title = getString(if (showingSource) R.string.content_toggle_preview else R.string.content_toggle_source)
            onToggle()
            true
        }
        com.termbridge.android.ui.MenuAppearance.apply(this, toolbar.menu)
    }

    private fun addOpenWithMenuItem(fileName: String, target: ArtifactTarget, data: ByteArray) {
        toolbar.menu.add(getString(R.string.content_open_external)).setOnMenuItemClickListener {
            openExternally(fileName, target, data)
            true
        }
        com.termbridge.android.ui.MenuAppearance.apply(this, toolbar.menu)
    }

    private fun renderSvgOrSource(target: ArtifactTarget, data: ByteArray) {
        if (showingSource) {
            destroyPreviewWebView()
            showTextView()
            renderSourceCode(target.location, data)
            return
        }
        val base64 = Base64.encodeToString(data, Base64.NO_WRAP)
        val html = """
            <!doctype html>
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8,user-scalable=yes">
            <style>
              html,body{margin:0;padding:0;min-height:100vh;background:#f7f7f4;display:flex;align-items:center;justify-content:center;}
              img{max-width:100vw;max-height:100vh;width:auto;height:auto;display:block;padding:12px;box-sizing:border-box;
                  background:repeating-conic-gradient(#eceee9 0% 25%, #ffffff 0% 50%) 50% / 16px 16px;border-radius:6px;}
            </style></head>
            <body><img src="data:image/svg+xml;base64,$base64" alt="SVG"/></body></html>
        """.trimIndent()
        showSandboxedWebView(html, allowJs = false)
    }

    private fun renderHtmlOrSource(target: ArtifactTarget, data: ByteArray) {
        if (showingSource) {
            destroyPreviewWebView()
            showTextView()
            renderSourceCode(target.location, data)
            return
        }
        showSandboxedWebView(data.toString(Charsets.UTF_8), allowJs = true)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showSandboxedWebView(html: String, allowJs: Boolean) {
        destroyPreviewWebView()
        val web = WebView(this).apply {
            setBackgroundColor(getColor(R.color.paper))
            settings.apply {
                javaScriptEnabled = allowJs
                domStorageEnabled = allowJs
                allowFileAccess = false
                allowContentAccess = false
                blockNetworkLoads = true
                builtInZoomControls = true
                displayZoomControls = false
                setSupportZoom(true)
                useWideViewPort = true
                loadWithOverviewMode = true
                cacheMode = WebSettings.LOAD_NO_CACHE
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true
            }
            loadDataWithBaseURL("https://preview.termbridge.local/", html, "text/html", "UTF-8", null)
        }
        previewWebView = web
        contentHost.removeAllViews()
        contentHost.addView(web, FrameLayout.LayoutParams(-1, -1))
    }

    private fun renderImage(target: ArtifactTarget, data: ByteArray, renderer: ArtifactMarkdown) {
        worker.execute {
            val decoded = runCatching<Drawable> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    val source = ImageDecoder.createSource(ByteBuffer.wrap(data))
                    ImageDecoder.decodeDrawable(source) { decoder, info, _ ->
                        val maxDim = maxOf(info.size.width, info.size.height)
                        if (maxDim > 2048) {
                            val scale = 2048f / maxDim
                            decoder.setTargetSize(
                                (info.size.width * scale).toInt().coerceAtLeast(1),
                                (info.size.height * scale).toInt().coerceAtLeast(1),
                            )
                        }
                    }
                } else {
                    renderer.bitmap(data)
                }
            }
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                decoded.fold(
                    onSuccess = { drawable ->
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && drawable is AnimatedImageDrawable) {
                            drawable.start()
                        }
                        val mime = mimeForExtension(target.extension)
                        if (target.extension in setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "ico") && data.size <= 12 * 1024 * 1024) {
                            val b64 = Base64.encodeToString(data, Base64.NO_WRAP)
                            val html = """
                                <!doctype html>
                                <html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8,user-scalable=yes">
                                <style>html,body{margin:0;padding:0;min-height:100vh;background:#0d100e;display:flex;align-items:center;justify-content:center;}
                                img{max-width:100vw;height:auto;display:block;}</style></head>
                                <body><img src="data:$mime;base64,$b64" alt="Image"/></body></html>
                            """.trimIndent()
                            showSandboxedWebView(html, allowJs = false)
                        } else {
                            showScrollView()
                            scroll.removeAllViews()
                            scroll.addView(ImageView(this).apply {
                                adjustViewBounds = true
                                setImageDrawable(drawable)
                                contentDescription = toolbar.title
                            })
                        }
                    },
                    onFailure = {
                        // Fallback for ICO or exotic formats Chromium can decode directly.
                        val mime = mimeForExtension(target.extension)
                        val b64 = Base64.encodeToString(data, Base64.NO_WRAP)
                        val html = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=8,user-scalable=yes\"></head><body style=\"margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f7f7f4\"><img style=\"max-width:100vw;height:auto\" src=\"data:$mime;base64,$b64\"/></body></html>"
                        showSandboxedWebView(html, allowJs = false)
                    },
                )
            }
        }
    }

    private fun renderPdf(data: ByteArray) {
        text.text = getString(R.string.content_loading)
        worker.execute {
            val pagesResult = runCatching {
                val file = writeTempFile("preview.pdf", data)
                val pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
                pfd.use { fd ->
                    PdfRenderer(fd).use { pdf ->
                        val total = pdf.pageCount
                        val limit = total.coerceAtMost(MAX_PDF_PAGES)
                        val targetWidth = resources.displayMetrics.widthPixels.coerceIn(720, 1600)
                        val bitmaps = ArrayList<Bitmap>(limit)
                        for (i in 0 until limit) {
                            pdf.openPage(i).use { page ->
                                val scale = targetWidth.toFloat() / page.width.coerceAtLeast(1)
                                val w = (page.width * scale).toInt().coerceAtLeast(1)
                                val h = (page.height * scale).toInt().coerceAtLeast(1)
                                val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                                bmp.eraseColor(Color.WHITE)
                                page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                bitmaps.add(bmp)
                            }
                        }
                        total to bitmaps
                    }
                }
            }
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                pagesResult.fold(
                    onSuccess = { (total, bitmaps) ->
                        toolbar.subtitle = getString(R.string.content_pdf_pages, bitmaps.size, total)
                        showScrollView()
                        val dp = resources.displayMetrics.density
                        val stack = LinearLayout(this).apply {
                            orientation = LinearLayout.VERTICAL
                            setBackgroundColor(getColor(R.color.surface_variant))
                            setPadding(0, (8 * dp).toInt(), 0, (16 * dp).toInt())
                        }
                        for (bmp in bitmaps) {
                            val img = ImageView(this).apply {
                                adjustViewBounds = true
                                setBackgroundColor(Color.WHITE)
                                setImageBitmap(bmp)
                            }
                            stack.addView(img, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                                bottomMargin = (8 * dp).toInt()
                            })
                        }
                        scroll.removeAllViews()
                        scroll.addView(stack)
                    },
                    onFailure = {
                        renderBinaryFallback(toolbar.title?.toString().orEmpty(), ArtifactTarget("file.pdf", false), data)
                    },
                )
            }
        }
    }

    private fun renderMedia(fileName: String, target: ArtifactTarget, data: ByteArray) {
        val file = runCatching { writeTempFile(fileName, data) }.getOrNull() ?: run {
            renderBinaryFallback(fileName, target, data); return
        }
        val container = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val player = VideoView(this).apply {
            setVideoPath(file.absolutePath)
            val controller = MediaController(this@ArtifactPreviewActivity)
            controller.setAnchorView(this)
            setMediaController(controller)
            setOnPreparedListener { mp -> mp.isLooping = false; start() }
            setOnErrorListener { _, _, _ ->
                renderBinaryFallback(fileName, target, data)
                true
            }
        }
        videoView = player
        container.addView(player, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        contentHost.removeAllViews()
        contentHost.addView(container, FrameLayout.LayoutParams(-1, -1))
    }

    private fun renderText(target: ArtifactTarget, data: ByteArray, renderer: ArtifactMarkdown) {
        showTextView()
        if (target.markdown && target.line == null && data.size <= 512 * 1024) {
            renderer.bind(text, data.toString(Charsets.UTF_8))
        } else {
            renderSourceCode(target.location, data, target.line, target.endLine)
        }
    }

    private fun renderSourceCode(location: String, data: ByteArray, targetLine: Int? = null, targetEndLine: Int? = null) {
        val truncated = data.size > MAX_TEXT_DISPLAY_BYTES
        val slice = if (truncated) data.copyOfRange(0, MAX_TEXT_DISPLAY_BYTES) else data
        val body = slice.toString(Charsets.UTF_8)
        text.typeface = android.graphics.Typeface.MONOSPACE
        text.textSize = 13f
        val prefix = if (truncated) {
            getString(R.string.content_text_truncated, MAX_TEXT_DISPLAY_BYTES / 1024, formatBytes(data.size)) + "\n\n"
        } else ""
        val displayText = prefix + body
        val rendered: CharSequence = if (!truncated && data.size <= 256 * 1024) {
            runCatching {
                com.termbridge.android.review.ReviewSyntaxHighlighter(applicationContext)
                    .highlight(location, displayText)
            }.getOrNull() ?: displayText
        } else {
            displayText
        }

        if (targetLine != null && targetLine > 0) {
            val prefixLines = prefix.count { it == '\n' }
            val startLine = targetLine + prefixLines
            val endLine = (targetEndLine?.coerceAtLeast(targetLine) ?: targetLine) + prefixLines
            val spanRange = lineRangeOffsets(displayText, startLine, endLine)
            if (spanRange != null) {
                val styled = SpannableStringBuilder(rendered)
                styled.setSpan(
                    BackgroundColorSpan(Color.argb(48, 250, 179, 20)),
                    spanRange.first,
                    spanRange.second,
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
                text.text = styled
                scrollToOffset(spanRange.first)
                return
            }
        }
        text.text = rendered
    }

    private fun lineRangeOffsets(content: String, startLine: Int, endLine: Int): Pair<Int, Int>? {
        var currentLine = 1
        var index = 0
        var rangeStart = -1
        var rangeEnd = content.length
        while (index <= content.length) {
            if (currentLine == startLine && rangeStart == -1) rangeStart = index
            val nextNewline = content.indexOf('\n', index)
            if (currentLine == endLine) {
                rangeEnd = if (nextNewline == -1) content.length else nextNewline
                break
            }
            if (nextNewline == -1) break
            index = nextNewline + 1
            currentLine++
        }
        if (rangeStart < 0 || rangeStart > content.length) return null
        return rangeStart to rangeEnd.coerceIn(rangeStart, content.length)
    }

    private fun scrollToOffset(charOffset: Int) {
        text.post {
            val layout = text.layout ?: return@post
            val lineIndex = layout.getLineForOffset(charOffset.coerceIn(0, text.text.length))
            val targetY = (layout.getLineTop(lineIndex) - (scroll.height / 4)).coerceAtLeast(0)
            scroll.scrollTo(0, targetY)
        }
    }

    private fun renderBinaryFallback(fileName: String, target: ArtifactTarget, data: ByteArray) {
        showScrollView()
        val dp = resources.displayMetrics.density
        val sha = MessageDigest.getInstance("SHA-256").digest(data).take(8).joinToString("") { "%02x".format(it) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * dp).toInt(), (24 * dp).toInt(), (20 * dp).toInt(), (24 * dp).toInt())
        }
        box.addView(TextView(this).apply {
            text = fileName.ifBlank { target.location }
            textSize = 17f
            setTextColor(getColor(R.color.ink))
        })
        box.addView(TextView(this).apply {
            text = "${formatBytes(data.size)} · ${mimeForExtension(target.extension)} · sha256:$sha"
            textSize = 13f
            setTextColor(getColor(R.color.ink_muted))
            setPadding(0, (6 * dp).toInt(), 0, (18 * dp).toInt())
        })
        box.addView(MaterialButton(this).apply {
            text = getString(R.string.content_open_external)
            setOnClickListener { openExternally(fileName, target, data) }
        })
        scroll.removeAllViews()
        scroll.addView(box)
    }

    private fun openExternally(fileName: String, target: ArtifactTarget, data: ByteArray) {
        runCatching {
            val file = writeTempFile(fileName.ifBlank { "file.${target.extension.ifEmpty { "bin" }}" }, data)
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
            val mime = mimeForExtension(target.extension)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(intent, fileName))
        }.onFailure {
            Toast.makeText(this, R.string.content_open_external_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun writeTempFile(rawName: String, data: ByteArray): File {
        val dir = File(cacheDir, "preview").apply { mkdirs() }
        val safeName = rawName.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifEmpty { "artifact" }
        val out = File(dir, "${UUID.randomUUID().toString().take(8)}-$safeName")
        out.writeBytes(data)
        tempFile?.delete()
        tempFile = out
        return out
    }

    private fun showScrollView() {
        contentHost.removeAllViews()
        contentHost.addView(scroll, FrameLayout.LayoutParams(-1, -1))
    }

    private fun showTextView() {
        scroll.removeAllViews()
        scroll.addView(text)
        showScrollView()
    }

    private fun destroyPreviewWebView() {
        previewWebView?.let { w ->
            w.stopLoading()
            w.loadUrl("about:blank")
            w.destroy()
        }
        previewWebView = null
    }

    private fun isLikelyText(data: ByteArray): Boolean {
        val sample = data.size.coerceAtMost(8 * 1024)
        for (i in 0 until sample) {
            if (data[i] == 0.toByte()) return false
        }
        return true
    }

    private fun mimeForExtension(ext: String): String = when (ext.lowercase()) {
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "bmp" -> "image/bmp"
        "ico" -> "image/x-icon"
        "heic" -> "image/heic"
        "heif" -> "image/heif"
        "avif" -> "image/avif"
        "pdf" -> "application/pdf"
        "html", "htm" -> "text/html"
        "md", "markdown" -> "text/markdown"
        "json" -> "application/json"
        "mp4", "m4v" -> "video/mp4"
        "webm" -> "video/webm"
        "mov" -> "video/quicktime"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "m4a" -> "audio/mp4"
        "ogg" -> "audio/ogg"
        else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase()) ?: "application/octet-stream"
    }

    private fun formatBytes(size: Int): String = when {
        size >= 1024 * 1024 -> String.format("%.1f MB", size / (1024.0 * 1024.0))
        size >= 1024 -> String.format("%.1f KB", size / 1024.0)
        else -> "$size B"
    }

    override fun onDestroy() {
        destroyPreviewWebView()
        videoView?.stopPlayback()
        videoView = null
        markdown?.close()
        reader?.close()
        worker.shutdownNow()
        tempFile?.delete()
        tempFile = null
        super.onDestroy()
    }

    companion object {
        private const val MAX_PDF_PAGES = 60
        private const val MAX_TEXT_DISPLAY_BYTES = 512 * 1024

        fun open(
            context: Context,
            location: String,
            sessionId: String? = null,
            hostId: String? = null,
            endpointKey: String? = null,
        ) {
            val target = ArtifactTarget.parse(location) ?: return
            if (target.remote && !target.image && !target.svg && !target.markdown) {
                if (com.termbridge.android.browser.RemoteBrowserPolicy.shouldIntercept(target.location)) {
                    val active = SettingsStore.load(context)
                    val profiles = SettingsStore.profiles(context)
                    val pin = if (!endpointKey.isNullOrBlank()) {
                        SessionPin(hostId.orEmpty(), endpointKey)
                    } else {
                        SessionHostPin.pin(hostId, active, profiles)
                    }
                    val resolved = SessionHostPin.resolve(pin, active, profiles)
                    if (resolved != null) {
                        com.termbridge.android.browser.RemoteBrowserActivity.open(context, resolved, target.location)
                        return
                    }
                }
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target.location))) }; return
            }
            val settings = SettingsStore.load(context)
            val pin = if (!endpointKey.isNullOrBlank()) {
                SessionPin(hostId.orEmpty(), endpointKey)
            } else {
                SessionHostPin.pin(hostId, settings, SettingsStore.profiles(context)) ?: return
            }
            context.startActivity(Intent(context, ArtifactPreviewActivity::class.java)
                .putExtra("location", target.location)
                .putExtra("line", target.line ?: 0)
                .putExtra("endLine", target.endLine ?: 0)
                .putExtra("session", sessionId ?: SessionFileProtocol.GLOBAL_SESSION)
                .putExtra("host", pin.hostId).putExtra("endpoint", pin.endpointKey))
        }
    }
}
