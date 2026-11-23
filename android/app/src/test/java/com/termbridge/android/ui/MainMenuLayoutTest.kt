package com.termbridge.android.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

class MainMenuLayoutTest {
    private val resources = listOf(File("src/main/res"), File("app/src/main/res"))
        .first { it.isDirectory }
    private val androidNs = "http://schemas.android.com/apk/res/android"

    private fun elements(path: String, tag: String): List<Element> {
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val nodes = factory.newDocumentBuilder().parse(File(resources, path)).getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    @Test fun createLivesInIconMenuNotFloatingOverSessions() {
        assertTrue(elements("layout/activity_main.xml",
            "com.google.android.material.floatingactionbutton.FloatingActionButton").isEmpty())
        val toolbar = elements("menu/main_menu.xml", "item")
        assertTrue(toolbar.any { it.getAttributeNS(androidNs, "id") == "@+id/action_more" })
        val actions = elements("menu/main_overflow.xml", "item")
        assertEquals(setOf("@+id/action_desktop", "@+id/action_new_session", "@+id/action_settings"),
            actions.map { it.getAttributeNS(androidNs, "id") }.toSet())
        assertTrue(actions.all { it.getAttributeNS(androidNs, "icon").isNotBlank() })
        val create = actions.first { it.getAttributeNS(androidNs, "id") == "@+id/action_new_session" }
        assertEquals(1, create.getElementsByTagName("menu").length)
    }

    @Test fun listDoesNotReserveFloatingButtonSpace() {
        val list = elements("layout/activity_main.xml", "androidx.recyclerview.widget.RecyclerView").single()
        assertEquals("16dp", list.getAttributeNS(androidNs, "paddingBottom"))
    }
}
