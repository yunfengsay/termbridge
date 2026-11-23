package com.termbridge.android.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

class TerminalKeyStyleTest {
    private val res = listOf(File("src/main/res"), File("app/src/main/res")).first { it.isDirectory }
    @Test fun bothSessionViewsUseOneFilledStatefulKeyStyle() {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, "values/terminal_styles.xml"))
        val style = document.getElementsByTagName("style").item(0) as Element
        assertEquals("Widget.Material3.Button", style.getAttribute("parent"))
        val items = style.getElementsByTagName("item")
        val values = (0 until items.length).associate {
            val element = items.item(it) as Element
            element.getAttribute("name") to element.textContent
        }
        assertEquals("48dp", values["android:layout_height"])
        assertEquals("1dp", values["strokeWidth"])
        assertEquals("@color/composer_key_background", values["backgroundTint"])
        for (layout in listOf("view_chat_keys", "activity_terminal")) {
            assertTrue(File(res, "layout/$layout.xml").readText().contains("@style/Widget.Termbridge.TerminalKey"))
        }
        val selector = File(res, "color/composer_key_background.xml").readText()
        assertTrue(selector.contains("state_checked"))
        assertTrue(selector.contains("state_pressed"))
    }
}
