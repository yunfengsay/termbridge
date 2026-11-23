package com.termbridge.android.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.view.Menu
import androidx.appcompat.view.menu.MenuBuilder
import androidx.core.graphics.ColorUtils
import androidx.core.view.MenuItemCompat
import com.google.android.material.color.MaterialColors

/** One semantic tint and icon visibility policy for toolbar and popup actions. */
object MenuAppearance {
    @SuppressLint("RestrictedApi") // AppCompat owns both Toolbar and PopupMenu menus.
    fun apply(context: Context, menu: Menu) {
        (menu as? MenuBuilder)?.setOptionalIconsVisible(true)
        val foreground = MaterialColors.getColor(context, com.google.android.material.R.attr.colorOnSurface, "MenuAppearance")
        val tint = ColorStateList(
            arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
            intArrayOf(ColorUtils.setAlphaComponent(foreground, (255 * 0.38f).toInt()), foreground),
        )
        for (index in 0 until menu.size()) {
            val item = menu.getItem(index)
            if (item.icon != null) MenuItemCompat.setIconTintList(item, tint)
            item.subMenu?.let { apply(context, it) }
        }
    }
}
