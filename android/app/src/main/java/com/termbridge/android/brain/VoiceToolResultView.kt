package com.termbridge.android.brain

import android.content.Context
import android.text.format.DateUtils
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import com.termbridge.android.R
import com.termbridge.android.databinding.ItemVoiceToolResultBinding
import com.termbridge.android.databinding.ItemVoiceToolRowBinding
import com.termbridge.android.protocol.VoiceToolViewInfo
import com.termbridge.android.protocol.VoiceToolViewItemInfo
import com.termbridge.android.peer.PhoneActionNavigation

/** One registered-tool result rendered as a single compact native card. */
class VoiceToolResultView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : FrameLayout(context, attrs) {
    private val binding = ItemVoiceToolResultBinding.inflate(LayoutInflater.from(context), this, true)

    fun bind(view: VoiceToolViewInfo, openItem: (VoiceToolViewItemInfo) -> Unit,
        markdown: com.termbridge.android.content.ArtifactMarkdown? = null) = with(binding) {
        title.text = view.title
        count.text = view.items.size.toString()
        rows.removeAllViews()
        view.items.forEachIndexed { index, item ->
            val row = ItemVoiceToolRowBinding.inflate(LayoutInflater.from(context), rows, false)
            row.bind(item, openItem, markdown)
            rows.addView(row.root)
            if (index < view.items.lastIndex) rows.addView(divider())
        }
        isVisible = view.items.isNotEmpty()
    }

    fun clear() {
        binding.rows.removeAllViews()
        isVisible = false
    }

    private fun divider(): View = View(context).apply {
        setBackgroundColor(ContextCompat.getColor(context, R.color.line))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            resources.displayMetrics.density.toInt().coerceAtLeast(1),
        ).apply {
            marginStart = context.dp(10)
            marginEnd = context.dp(10)
        }
    }
}

private fun ItemVoiceToolRowBinding.bind(
    item: VoiceToolViewItemInfo,
    openItem: (VoiceToolViewItemInfo) -> Unit,
    markdown: com.termbridge.android.content.ArtifactMarkdown?,
) {
    val phoneAction = PhoneActionNavigation.canOpen(root.context, item.id)
    title.text = item.title
    summary.text = item.detail?.takeIf(String::isNotBlank)
        ?: item.subtitle?.takeIf(String::isNotBlank)
        ?: ""
    summary.isVisible = summary.text.isNotBlank()
    // Native receipt summaries are plain text. Markdown's TextView gestures
    // otherwise swallow taps in the middle of an actionable receipt row.
    if (!phoneAction) markdown?.bind(summary, summary.text.toString())

    val relativeTime = item.timestamp?.takeIf { it > 0L }?.let {
        DateUtils.getRelativeTimeSpanString(
            it,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
            DateUtils.FORMAT_ABBREV_RELATIVE,
        ).toString()
    }
    trailing.text = relativeTime ?: item.status.orEmpty()
    trailing.isVisible = trailing.text.isNotBlank()
    statusDot.isVisible = !item.status.isNullOrBlank()
    statusDot.setBackgroundResource(statusDotDrawable(item.status))

    val canOpen = item.isOpenable || phoneAction
    chevron.isVisible = canOpen
    root.isClickable = canOpen
    root.isFocusable = canOpen
    root.setOnClickListener(if (canOpen) View.OnClickListener { openItem(item) } else null)
}

private fun statusDotDrawable(status: String?): Int = when (status?.lowercase()) {
    "working", "active", "dispatched", "completed", "done", "sent" -> R.drawable.status_dot_active
    "failed", "error", "missing" -> R.drawable.status_dot_error
    else -> R.drawable.status_dot_idle
}

private fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
