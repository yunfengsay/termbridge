package com.termbridge.android.brain

import android.content.Context
import android.text.format.DateUtils
import android.util.AttributeSet
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
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

    fun bind(
        view: VoiceToolViewInfo,
        openItem: (VoiceToolViewItemInfo) -> Unit,
        markdown: com.termbridge.android.content.ArtifactMarkdown? = null,
        expanded: Boolean = false,
        onToggleExpanded: ((Boolean) -> Unit)? = null,
    ) = with(binding) {
        title.text = view.title
        count.text = view.items.size.toString()
        renderRows(view, openItem, markdown, expanded, onToggleExpanded)
        isVisible = view.items.isNotEmpty()
    }

    private fun renderRows(
        view: VoiceToolViewInfo,
        openItem: (VoiceToolViewItemInfo) -> Unit,
        markdown: com.termbridge.android.content.ArtifactMarkdown?,
        expanded: Boolean,
        onToggleExpanded: ((Boolean) -> Unit)?,
    ): Unit = with(binding) {
        rows.removeAllViews()
        val collapsible = view.items.size > MAX_COLLAPSED_ROWS
        val visibleItems = if (collapsible && !expanded) {
            view.items.takeLast(MAX_COLLAPSED_ROWS)
        } else {
            view.items
        }
        val hiddenCount = view.items.size - visibleItems.size
        visibleItems.forEachIndexed { index, item ->
            val row = ItemVoiceToolRowBinding.inflate(LayoutInflater.from(context), rows, false)
            row.bind(item, openItem, markdown)
            rows.addView(row.root)
            if (index < visibleItems.lastIndex || collapsible) rows.addView(divider())
        }
        if (collapsible) {
            val toggle = TextView(context).apply {
                text = if (expanded) {
                    context.getString(R.string.brain_tool_collapse)
                } else {
                    context.getString(R.string.brain_tool_expand_more, hiddenCount)
                }
                textSize = 11f
                setTextColor(ContextCompat.getColor(context, R.color.ink_muted))
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    context.dp(30),
                )
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    val nextExpanded = !expanded
                    onToggleExpanded?.invoke(nextExpanded)
                    renderRows(view, openItem, markdown, nextExpanded, onToggleExpanded)
                }
            }
            rows.addView(toggle)
        }
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

    companion object {
        const val MAX_COLLAPSED_ROWS = 3
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
