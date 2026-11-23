package com.termbridge.android.review

import android.graphics.Typeface
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.termbridge.android.R
import com.termbridge.android.databinding.ItemReviewNavigatorBinding

internal class ReviewNavigatorAdapter(
    private val onClick: (ReviewNavigatorRow) -> Unit,
) : ListAdapter<ReviewNavigatorRow, ReviewNavigatorAdapter.Holder>(Diff) {
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
        ItemReviewNavigatorBinding.inflate(LayoutInflater.from(parent.context), parent, false),
        onClick,
    )

    override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(getItem(position))

    internal class Holder(
        private val binding: ItemReviewNavigatorBinding,
        private val onClick: (ReviewNavigatorRow) -> Unit,
    ) : RecyclerView.ViewHolder(binding.root) {
        fun bind(row: ReviewNavigatorRow) = with(binding) {
            val density = root.resources.displayMetrics.density
            val start = ((6 + row.depth * 14) * density).toInt()
            navigatorRow.setPaddingRelative(start, navigatorRow.paddingTop, (6 * density).toInt(), navigatorRow.paddingBottom)
            root.setOnClickListener { onClick(row) }
            when (row) {
                is ReviewNavigatorRow.Directory -> {
                    root.isSelected = false
                    navigatorGlyph.text = if (row.expanded) "▾" else "▸"
                    navigatorGlyph.setTextColor(ContextCompat.getColor(root.context, R.color.review_directory_text))
                    navigatorIcon.setImageResource(ReviewFileIcon.directory(row.path, row.expanded))
                    navigatorTitle.text = row.name
                    navigatorTitle.setTextColor(ContextCompat.getColor(root.context, R.color.review_directory_text))
                    navigatorTitle.setTypeface(null, Typeface.BOLD)
                    navigatorStats.text = root.resources.getQuantityString(
                        R.plurals.review_file_count,
                        row.fileCount,
                        row.fileCount,
                    )
                    navigatorStats.setTextColor(ContextCompat.getColor(root.context, R.color.ink_muted))
                }
                is ReviewNavigatorRow.File -> {
                    root.isSelected = row.selected
                    navigatorGlyph.text = ""
                    navigatorIcon.setImageResource(ReviewFileIcon.file(row.file.path))
                    navigatorTitle.text = row.title
                    navigatorTitle.setTextColor(ContextCompat.getColor(root.context, R.color.ink))
                    navigatorTitle.setTypeface(null, Typeface.NORMAL)
                    navigatorStats.text = if (row.file.additions == 0 && row.file.deletions == 0) {
                        ""
                    } else {
                        coloredStats(row.file.additions, row.file.deletions)
                    }
                }
            }
        }

        private fun coloredStats(additions: Int, deletions: Int): SpannableString {
            val added = "+$additions"
            val deleted = "−$deletions"
            return SpannableString("$added  $deleted").apply {
                setSpan(
                    ForegroundColorSpan(color(if (additions > 0) R.color.review_add_text else R.color.ink_muted)),
                    0,
                    added.length,
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
                setSpan(
                    ForegroundColorSpan(color(if (deletions > 0) R.color.review_delete_text else R.color.ink_muted)),
                    added.length + 2,
                    length,
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            }
        }

        private fun color(resource: Int): Int = ContextCompat.getColor(binding.root.context, resource)

    }

    private object Diff : DiffUtil.ItemCallback<ReviewNavigatorRow>() {
        override fun areItemsTheSame(oldItem: ReviewNavigatorRow, newItem: ReviewNavigatorRow): Boolean =
            oldItem.key == newItem.key

        override fun areContentsTheSame(oldItem: ReviewNavigatorRow, newItem: ReviewNavigatorRow): Boolean =
            oldItem == newItem
    }
}
