package com.termbridge.android.desktop

import android.content.Context
import android.content.res.ColorStateList
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import androidx.appcompat.widget.PopupMenu
import com.google.android.material.button.MaterialButton
import com.termbridge.android.R
import org.json.JSONObject

/** Native Material controls; the WebView only owns pixels and gestures. */
internal class DesktopControls(private val context: Context, private val send: (String, Any?) -> Unit) {
    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
    private fun row() = LinearLayout(context).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(12), 0, dp(12), 0)
    }
    val top = row()
    val bottom = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private var displays = emptyList<Pair<Int, String>>()
    private var selectedDisplay = 0
    private var connected = false
    private var scrolling = true
    private var backend = "auto"
    private var fps = 10
    private val actions = mutableListOf<View>()
    private fun button(label: Int, action: String, icon: Int? = null) = MaterialButton(context, null,
        com.google.android.material.R.attr.materialButtonStyle).apply {
        text = if (icon == null) context.getString(label) else ""
        contentDescription = context.getString(label)
        isAllCaps = false; textSize = 14f
        backgroundTintList = ColorStateList.valueOf(android.graphics.Color.TRANSPARENT)
        val tint = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_enabled), intArrayOf()), intArrayOf(context.getColor(R.color.green_dark), context.getColor(R.color.ink_muted)))
        setTextColor(tint); iconTint = tint
        strokeWidth = 0
        minWidth = 0; minimumWidth = 0; minHeight = dp(48); minimumHeight = dp(48)
        insetTop = 0; insetBottom = 0
        setPadding(dp(12), 0, dp(12), 0)
        icon?.let { setIconResource(it); iconSize = dp(22); iconPadding = 0; iconGravity = MaterialButton.ICON_GRAVITY_TEXT_START }
        setOnClickListener { send(action, null) }
    }
    private val display = button(R.string.desktop_display, "display").apply {
        maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
        setIconResource(R.drawable.ic_expand_more); iconSize = dp(18)
        iconGravity = MaterialButton.ICON_GRAVITY_TEXT_END
        setOnClickListener { showDisplays() }
    }
    private val drag = button(R.string.desktop_drag, "drag")
    private val fit = button(R.string.desktop_fit, "fit").apply { text = "100%" }
    private val keyboard = button(R.string.desktop_keyboard, "keyboard", R.drawable.ic_desktop_keyboard)
    private val more = button(R.string.desktop_more, "more", R.drawable.ic_more)
    private val reconnect = button(R.string.desktop_reconnect, "reconnect", R.drawable.ic_refresh)
    private val typing = row().apply { visibility = View.GONE }
    private val input = EditText(context).apply {
        hint = context.getString(R.string.desktop_type_hint); isSingleLine = true
        textSize = 16f; imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEND
        setPadding(dp(12), 0, dp(12), 0)
        setOnEditorActionListener { _, action, _ ->
            if (action == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) { submit(); true } else false
        }
    }
    init {
        top.addView(display, LinearLayout.LayoutParams(0, dp(48), 1f))
        for ((label, action, icon) in listOf(
            Triple(R.string.desktop_previous, "previous", R.drawable.ic_arrow_back),
            Triple(R.string.desktop_overview, "overview", R.drawable.ic_desktop),
            Triple(R.string.desktop_next, "next", R.drawable.ic_chevron_right))) {
            val b = button(label, action, icon); actions += b; top.addView(b, LinearLayout.LayoutParams(dp(48), dp(48)))
        }
        typing.addView(input, LinearLayout.LayoutParams(0, dp(48), 1f))
        typing.addView(button(R.string.desktop_send, "send", R.drawable.ic_send).apply { setOnClickListener { submit() } }, LinearLayout.LayoutParams(dp(48), dp(48)))
        bottom.addView(typing)
        val bar = row()
        bar.addView(drag, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
        bar.addView(fit, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
        bar.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        for (b in listOf(reconnect, keyboard, more)) bar.addView(b, LinearLayout.LayoutParams(dp(48), dp(48)))
        bottom.addView(bar)
        actions += listOf(drag, fit, keyboard)
        keyboard.setOnClickListener {
            typing.visibility = if (typing.visibility == View.GONE) View.VISIBLE else View.GONE
            val ime = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            if (typing.visibility == View.VISIBLE) { input.requestFocus(); ime.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT) }
            else { ime.hideSoftInputFromWindow(input.windowToken, 0); input.clearFocus() }
        }
        more.setOnClickListener {
            PopupMenu(context, more, Gravity.END, 0, R.style.Widget_Termbridge_DesktopPopupMenu).apply {
                setForceShowIcon(true)
                val rates = menu.addSubMenu(R.string.desktop_frame_rate)
                rates.item.setIcon(R.drawable.ic_frame_rate)
                for (rate in listOf(10, 20, 30)) {
                    rates.add(1, 200 + rate, rate, "$rate FPS").apply { isCheckable = true; isChecked = rate == fps }
                }
                rates.setGroupCheckable(1, true, true)
                for ((id, title) in listOf(100 to R.string.desktop_auto, 101 to R.string.desktop_direct, 102 to R.string.desktop_system)) {
                    menu.add(0, id, id, title).setIcon(if (id == 100) R.drawable.ic_settings else R.drawable.ic_desktop).apply { isCheckable = true; isChecked = id - 100 == listOf("auto", "native", "system").indexOf(backend) }
                }
                menu.add(0, 103, 103, R.string.desktop_forget_password).setIcon(R.drawable.ic_shield)
                menu.add(0, 1, 0, if (scrolling) R.string.desktop_pan else R.string.desktop_scroll)
                    .setIcon(if (scrolling) R.drawable.ic_pan else R.drawable.ic_scroll).isEnabled = connected
                for ((id, label) in listOf(53 to "Esc", 48 to "Tab", 51 to "⌫", 36 to "Enter")) menu.add(0, id, id, label).setIcon(R.drawable.ic_desktop_keyboard).apply { isEnabled = connected }
                com.termbridge.android.ui.MenuAppearance.apply(context, menu)
                setOnMenuItemClickListener { item -> when (item.itemId) { 210, 220, 230 -> send("fps", item.itemId - 200); 103 -> send("forgetCredentials", null); 100, 101, 102 -> send("backend", listOf("auto", "native", "system")[item.itemId - 100]); 1 -> send("scrollMode", null); else -> send("key", item.itemId) }; true }; show()
            }
        }
        update(JSONObject())
    }
    private fun submit() { if (connected && input.text.isNotEmpty()) { send("text", input.text.toString()); input.text.clear() } }
    private fun showDisplays() {
        if (displays.isEmpty()) return
        PopupMenu(context, display, Gravity.START, 0, R.style.Widget_Termbridge_DesktopPopupMenu).apply {
            setForceShowIcon(true)
            displays.forEach { (id, name) -> menu.add(0, id, 0, name).setIcon(R.drawable.ic_desktop).apply { isCheckable = true; isChecked = id == selectedDisplay } }
            com.termbridge.android.ui.MenuAppearance.apply(context, menu)
            setOnMenuItemClickListener { send("display", it.itemId); true }; show()
        }
    }
    fun update(state: JSONObject) {
        fps = state.optInt("fps", 10)
        backend = state.optString("backend", "auto")
        connected = state.optBoolean("connected"); scrolling = state.optBoolean("scroll", true)
        selectedDisplay = state.optInt("displayId")
        displays = state.optJSONArray("displays")?.let { list -> (0 until list.length()).map { list.getJSONObject(it).let { d -> d.getInt("id") to d.optString("name", context.getString(R.string.desktop_display)) } } } ?: emptyList()
        display.text = displays.firstOrNull { it.first == selectedDisplay }?.second ?: context.getString(R.string.desktop_display)
        display.isEnabled = connected && displays.isNotEmpty()
        actions.forEach { it.isEnabled = connected }
        fit.text = "${state.optInt("zoom", 100)}%"
        val selected = state.optBoolean("drag")
        drag.isSelected = selected
        drag.backgroundTintList = ColorStateList.valueOf(if (selected) context.getColor(R.color.working_tint) else android.graphics.Color.TRANSPARENT)
        reconnect.visibility = if (state.optBoolean("retry")) View.VISIBLE else View.GONE
        if (!connected && typing.visibility == View.VISIBLE) {
            typing.visibility = View.GONE; input.text.clear()
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
        }
    }
}
