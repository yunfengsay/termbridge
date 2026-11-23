package com.termbridge.android.review

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.termbridge.android.R
import com.termbridge.android.databinding.ItemReviewFileBinding
import com.termbridge.android.databinding.ItemReviewHunkBinding
import com.termbridge.android.databinding.ItemReviewLineBinding
import com.termbridge.android.databinding.ItemReviewNoticeBinding

internal class ReviewAdapter(
    private val syntaxHighlighter: ReviewSyntaxHighlighter,
) : ListAdapter<ReviewRow, RecyclerView.ViewHolder>(Diff) {
    override fun getItemViewType(position: Int): Int = when (getItem(position)) {
        is ReviewRow.FileHeader -> TYPE_FILE
        is ReviewRow.HunkHeader -> TYPE_HUNK
        is ReviewRow.Line -> TYPE_LINE
        is ReviewRow.Notice -> TYPE_NOTICE
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TYPE_FILE -> FileHolder(ItemReviewFileBinding.inflate(inflater, parent, false))
            TYPE_HUNK -> HunkHolder(ItemReviewHunkBinding.inflate(inflater, parent, false))
            TYPE_LINE -> LineHolder(ItemReviewLineBinding.inflate(inflater, parent, false), syntaxHighlighter)
            else -> NoticeHolder(ItemReviewNoticeBinding.inflate(inflater, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (holder) {
            is FileHolder -> holder.bind(getItem(position) as ReviewRow.FileHeader)
            is HunkHolder -> holder.bind(getItem(position) as ReviewRow.HunkHeader)
            is LineHolder -> holder.bind(getItem(position) as ReviewRow.Line)
            is NoticeHolder -> holder.bind(getItem(position) as ReviewRow.Notice)
        }
    }

    private class FileHolder(private val binding: ItemReviewFileBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(row: ReviewRow.FileHeader) = with(binding) {
            fileIcon.setImageResource(ReviewFileIcon.file(row.path))
            filePath.text = row.path
            fileOldPath.text = row.oldPath?.let { root.context.getString(R.string.review_renamed_from, it) }.orEmpty()
            fileOldPath.visibility = if (row.oldPath == null) android.view.View.GONE else android.view.View.VISIBLE
            fileStatus.text = root.context.getString(
                when (row.status) {
                    "added" -> R.string.review_status_added
                    "deleted" -> R.string.review_status_deleted
                    "renamed" -> R.string.review_status_renamed
                    "untracked" -> R.string.review_status_untracked
                    "unchanged" -> R.string.review_status_file
                    else -> R.string.review_status_modified
                },
            )
            fileStats.text = if (row.additions == 0 && row.deletions == 0) {
                ""
            } else {
                root.context.getString(R.string.review_file_stats, row.additions, row.deletions)
            }
        }
    }

    private class HunkHolder(private val binding: ItemReviewHunkBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(row: ReviewRow.HunkHeader) {
            binding.hunkText.text = row.text
        }
    }

    private class LineHolder(
        private val binding: ItemReviewLineBinding,
        private val syntaxHighlighter: ReviewSyntaxHighlighter,
    ) : RecyclerView.ViewHolder(binding.root) {
        fun bind(row: ReviewRow.Line) = with(binding) {
            val line = row.line
            lineNumbers.text = ReviewPresentation.lineNumber(line)
            linePrefix.text = when (line.kind) {
                "add" -> "+"
                "delete" -> "−"
                else -> " "
            }
            lineText.text = syntaxHighlighter.highlight(row.path, line.text.ifEmpty { " " })
            val background = when (line.kind) {
                "add" -> R.color.review_add_background
                "delete" -> R.color.review_delete_background
                else -> R.color.surface
            }
            val foreground = when (line.kind) {
                "add" -> R.color.review_add_text
                "delete" -> R.color.review_delete_text
                else -> R.color.ink
            }
            root.setBackgroundColor(ContextCompat.getColor(root.context, background))
            linePrefix.setTextColor(ContextCompat.getColor(root.context, foreground))
            lineText.setTextColor(ContextCompat.getColor(root.context, foreground))
        }
    }

    private class NoticeHolder(private val binding: ItemReviewNoticeBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(row: ReviewRow.Notice) {
            binding.noticeText.setText(
                when (row.kind) {
                    ReviewRow.Notice.Kind.EMPTY -> R.string.review_empty
                    ReviewRow.Notice.Kind.PROJECT_EMPTY -> R.string.review_project_empty
                    ReviewRow.Notice.Kind.BINARY -> R.string.review_binary
                    ReviewRow.Notice.Kind.PRIVATE -> R.string.review_private
                    ReviewRow.Notice.Kind.FILE_TRUNCATED -> R.string.review_file_truncated
                    ReviewRow.Notice.Kind.SNAPSHOT_TRUNCATED -> R.string.review_snapshot_truncated
                },
            )
        }
    }

    private object Diff : DiffUtil.ItemCallback<ReviewRow>() {
        override fun areItemsTheSame(oldItem: ReviewRow, newItem: ReviewRow): Boolean = oldItem == newItem
        override fun areContentsTheSame(oldItem: ReviewRow, newItem: ReviewRow): Boolean = oldItem == newItem
    }

    private companion object {
        const val TYPE_FILE = 1
        const val TYPE_HUNK = 2
        const val TYPE_LINE = 3
        const val TYPE_NOTICE = 4
    }
}
