package com.termbridge.android.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

class ActionIconStyleTest {
    @Test fun actionIconsKeepOneGridAndRoundedStrokeWithoutTouchingBrandAssets() {
        val directory = listOf(File("src/main/res/drawable"), File("app/src/main/res/drawable"))
            .first { it.isDirectory }
        val names = listOf(
            "ic_settings",
            "ic_add",
            "ic_arrow_back",
            "ic_chevron_right",
            "ic_more",
            "ic_refresh",
            "ic_attach",
            "ic_send",
            "ic_mic",
            "ic_volume_up",
            "ic_volume_off",
            "ic_call",
            "ic_call_end",
            "ic_history",
            "ic_new_chat",
            "ic_delete",
            "ic_screen_capture",
            "ic_qr_code",
            "ic_termbridge_watch",
            "ic_brain_tools",
            "ic_account_tree",
            "ic_view_list",
            "ic_agent_shell",
            "ic_folder",
            "ic_folder_open",
            "ic_folder_source",
            "ic_file_default",
        )
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val ns = "http://schemas.android.com/apk/res/android"
        for (name in names) {
            val vector = factory.newDocumentBuilder().parse(File(directory, "$name.xml")).documentElement
            assertEquals(name, "24", vector.getAttributeNS(ns, "viewportWidth"))
            assertEquals(name, "24", vector.getAttributeNS(ns, "viewportHeight"))
            val paths = vector.getElementsByTagName("path")
            assertTrue(name, paths.length > 0)
            for (index in 0 until paths.length) {
                val path = paths.item(index) as Element
                assertEquals(name, "1.7", path.getAttributeNS(ns, "strokeWidth"))
                assertEquals(name, "round", path.getAttributeNS(ns, "strokeLineCap"))
                assertEquals(name, "round", path.getAttributeNS(ns, "strokeLineJoin"))
                assertEquals(name, "@android:color/transparent", path.getAttributeNS(ns, "fillColor"))
                assertTrue(name, path.getAttributeNS(ns, "strokeColor").isNotBlank())
            }
        }
    }
}
