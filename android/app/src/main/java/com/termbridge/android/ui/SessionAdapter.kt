package com.termbridge.android.ui

import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.appcompat.widget.PopupMenu
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.termbridge.android.R
import com.termbridge.android.databinding.ItemSessionBinding
import com.termbridge.android.protocol.SessionInfo

class SessionAdapter(
    private val onEnter: (SessionInfo) -> Unit,
    private val onKill: (SessionInfo) -> Unit,
) : ListAdapter<SessionInfo, SessionAdapter.SessionViewHolder>(SessionDiff) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): SessionViewHolder =
        SessionViewHolder(ItemSessionBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: SessionViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    override fun onBindViewHolder(holder: SessionViewHolder, position: Int, payloads: MutableList<Any>) {
        val changes = payloads.filterIsInstance<SessionChange>()
        if (changes.isEmpty() || changes.size != payloads.size) {
            holder.bind(getItem(position))
            return
        }
        holder.bind(getItem(position), changes.reduce(SessionChange::merge))
    }

    inner class SessionViewHolder(
        private val binding: ItemSessionBinding,
    ) : RecyclerView.ViewHolder(binding.root) {
        fun bind(session: SessionInfo) = with(binding) {
            command.text = session.displayName
            val agentKey = (session.agent ?: session.command).lowercase()
            val (icon, background, inset) = when {
                "claude" in agentKey -> Triple(R.drawable.ic_agent_claude, R.drawable.agent_icon_claude_bg, 2)
                "codex" in agentKey -> Triple(R.drawable.ic_agent_codex, R.drawable.agent_icon_codex_bg, 5)
                else -> Triple(R.drawable.ic_agent_shell, R.drawable.agent_icon_shell_bg, 5)
            }
            agentIcon.setImageResource(icon)
            agentIcon.setBackgroundResource(background)
            val insetPx = (inset * root.resources.displayMetrics.density).toInt()
            agentIcon.setPadding(insetPx, insetPx, insetPx, insetPx)
            agentIcon.contentDescription = when {
                "claude" in agentKey -> "Claude Code"
                "codex" in agentKey -> "Codex"
                else -> "Shell"
            }
            bindMeta(session)
            bindPreview(session)
            bindStatus(session)
            card.setOnClickListener { onEnter(session) }
            more.isVisible = !session.isHerdr
            more.setOnClickListener { anchor ->
                PopupMenu(root.context, anchor).apply {
                    menu.add(root.context.getString(R.string.kill_session)).setIcon(R.drawable.ic_delete)
                    setForceShowIcon(true)
                    MenuAppearance.apply(root.context, menu)
                    setOnMenuItemClickListener {
                        onKill(session)
                        true
                    }
                }.show()
            }
        }

        internal fun bind(session: SessionInfo, change: SessionChange) {
            if (change.meta) bindMeta(session)
            if (change.preview) bindPreview(session)
            if (change.status) bindStatus(session)
        }

        private fun bindMeta(session: SessionInfo) = with(binding) {
            val age = if (session.isHerdr) {
                session.paneId ?: "Herdr"
            } else if (session.createdAt > 0) {
                DateUtils.getRelativeTimeSpanString(
                    session.createdAt,
                    System.currentTimeMillis(),
                    DateUtils.MINUTE_IN_MILLIS,
                    DateUtils.FORMAT_ABBREV_RELATIVE,
                )
            } else {
                "unknown age"
            }
            val details = root.context.resources.getQuantityString(
                R.plurals.session_details,
                session.viewers,
                session.cols,
                session.rows,
                session.viewers,
            )
            val identity = if (session.isHerdr) age else listOf(session.sessionId, age).joinToString(" · ")
            meta.text = listOf(identity, details).joinToString(" · ")
        }

        private fun bindPreview(session: SessionInfo) = with(binding) {
            preview.text = session.preview
            preview.isVisible = !session.preview.isNullOrBlank()
        }

        private fun bindStatus(session: SessionInfo) = with(binding) {
            val working = session.isHerdr && session.status == "working"
            if (session.isActive || working) {
                statusDot.setBackgroundResource(R.drawable.status_dot_active)
                state.setText(R.string.active)
                state.setTextColor(ContextCompat.getColor(root.context, R.color.green_dark))
            } else {
                statusDot.setBackgroundResource(R.drawable.status_dot_idle)
                state.setText(R.string.ready)
                state.setTextColor(ContextCompat.getColor(root.context, R.color.ink_muted))
            }
            if (session.isHerdr) {
                state.text = session.status
                    ?.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
                    ?: root.context.getString(R.string.ready)
            }
            state.setWorking(working)
            if (working) {
                val horizontal = (6 * root.resources.displayMetrics.density).toInt()
                val vertical = (2 * root.resources.displayMetrics.density).toInt()
                state.setBackgroundResource(R.drawable.status_working_pill)
                state.setPadding(horizontal, vertical, horizontal, vertical)
            } else {
                state.setBackgroundResource(0)
                state.setPadding(0, 0, 0, 0)
            }
            statusAge.isVisible = session.isHerdr && session.completedAt != null
            statusAge.setTimestamp(session.completedAt)
        }
    }
}

internal data class SessionChange(
    val meta: Boolean = false,
    val preview: Boolean = false,
    val status: Boolean = false,
) {
    fun merge(other: SessionChange): SessionChange = SessionChange(
        meta = meta || other.meta,
        preview = preview || other.preview,
        status = status || other.status,
    )
}

internal object SessionDiff : DiffUtil.ItemCallback<SessionInfo>() {
    override fun areItemsTheSame(oldItem: SessionInfo, newItem: SessionInfo): Boolean =
        oldItem.sessionId == newItem.sessionId

    override fun areContentsTheSame(oldItem: SessionInfo, newItem: SessionInfo): Boolean =
        oldItem == newItem

    override fun getChangePayload(oldItem: SessionInfo, newItem: SessionInfo): Any? {
        if (
            oldItem.command != newItem.command ||
            oldItem.source != newItem.source ||
            oldItem.name != newItem.name ||
            oldItem.workspace != newItem.workspace ||
            oldItem.agent != newItem.agent
        ) return null

        return SessionChange(
            meta = oldItem.cols != newItem.cols ||
                oldItem.rows != newItem.rows ||
                oldItem.createdAt != newItem.createdAt ||
                oldItem.viewers != newItem.viewers ||
                oldItem.paneId != newItem.paneId,
            preview = oldItem.preview != newItem.preview,
            status = oldItem.viewers != newItem.viewers ||
                oldItem.status != newItem.status ||
                oldItem.completedAt != newItem.completedAt,
        )
    }
}
