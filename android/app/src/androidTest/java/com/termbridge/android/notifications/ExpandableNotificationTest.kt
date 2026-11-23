package com.termbridge.android.notifications

import android.app.Notification
import android.app.NotificationManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.R
import com.termbridge.android.watch.WatchNotificationPayload
import com.termbridge.android.watch.ZeppBridgeAlert
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ExpandableNotificationTest {
    @Test fun platformTemplatesRenderTitleAndExpandableParagraphs() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val title = "让通知显示标题与内容"
        val body = "**通知已更新**，现在可以直接看到任务标题和回复内容。\n\n" +
            "展开后会显示更多详情，保留段落。点击通知可以回到对应会话继续查看。\n\n" +
            "任务状态和设备名称放在次要位置，方便辨认提醒来自哪里。"
        val notification = ExpandableNotification.apply(context,
            NotificationCompat.Builder(context, "fixture").setSmallIcon(R.drawable.ic_notification),
            title, body, "Agent 已完成 · 测试 Mac").build()
        instrumentation.runOnMainSync {
            val builder = Notification.Builder.recoverBuilder(context, notification)
            fun render(expanded: Boolean): View {
                val remote = if (expanded) builder.createBigContentView() else builder.createContentView()
                val view = remote.apply(context, FrameLayout(context))
                val width = (360 * context.resources.displayMetrics.density).toInt()
                val maxHeight = (400 * context.resources.displayMetrics.density).toInt()
                view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST))
                view.layout(0, 0, width, view.measuredHeight)
                val bitmap = Bitmap.createBitmap(width, view.height, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bitmap)
                canvas.drawColor(android.graphics.Color.WHITE)
                view.draw(canvas)
                val name = if (expanded) "expanded" else "collapsed"
                File(context.cacheDir, "notification-$name.png").outputStream().use {
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                }
                bitmap.recycle()
                return view
            }
            fun texts(view: View): List<TextView> = when (view) {
                is TextView -> listOf(view)
                is ViewGroup -> (0 until view.childCount).flatMap { texts(view.getChildAt(it)) }
                else -> emptyList()
            }
            val compact = render(false)
            val expanded = render(true)
            assertTrue(texts(compact).any { it.text.toString() == title })
            assertTrue(texts(expanded).any { it.text.toString() == title })
            val answer = texts(expanded).first { it.text.contains("展开后会显示更多详情") }
            assertTrue(answer.lineCount > 2)
            assertTrue(expanded.height > compact.height)
        }
    }

    @Test fun collapsedAndExpandedViewsContainQuestionAndFullFormattedAnswer() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val body = "第一段：**已修复通知**。\n\n" + "这段详细说明应该保留。".repeat(35)
        val notification = ExpandableNotification.apply(context,
            NotificationCompat.Builder(context, "fixture").setSmallIcon(R.drawable.ic_notification),
            "让通知显示标题与内容", body, "Agent 已完成 · 测试 Mac").build()
        assertEquals("让通知显示标题与内容", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("让通知显示标题与内容", notification.extras.getCharSequence(Notification.EXTRA_TITLE_BIG).toString())
        val compact = notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString()
        val expanded = notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString()
        assertEquals(compact, expanded)
        assertTrue(expanded.contains("第一段：已修复通知。"))
        assertTrue(expanded.endsWith("这段详细说明应该保留。"))
        assertTrue(expanded.length > 240)
        assertEquals("Agent 已完成 · 测试 Mac", notification.extras.getCharSequence(Notification.EXTRA_SUB_TEXT).toString())
        assertTrue(notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        assertEquals("android.app.Notification\$BigTextStyle", notification.extras.getString(Notification.EXTRA_TEMPLATE))
    }

    @Test fun updatesKeepActionsAndRouteButNeverRecreateDismissedOrReplacedNotifications() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.uiAutomation.executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS").close()
        val manager = context.getSystemService(NotificationManager::class.java)
        val route = CompletionNotificationRoute("notification-fixture", "herdr:notification-fixture")
        fun current() = manager.activeNotifications.firstOrNull { it.id == route.requestCode }?.notification
        try {
            AgentMonitorService.publishCompletion(context, WatchNotificationPayload(route.hostId, route.sessionId,
                "初始会话名", "初始预览", 1), detailsToken = "current")
            SystemClock.sleep(200)
            val initial = current()!!
            assertEquals("初始会话名", initial.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
            assertEquals("初始预览", initial.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
            ExpandableNotification.updateIfCurrent(context, route.requestCode, "old", AgentNotificationContent("错误标题", "错误正文"))
            assertEquals("初始会话名", current()!!.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
            ExpandableNotification.updateIfCurrent(context, route.requestCode, "current", AgentNotificationContent("当前任务", "完整回复\n\n第二段"))
            SystemClock.sleep(200)
            val updated = current()!!
            assertEquals("当前任务", updated.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
            assertEquals("完整回复\n\n第二段", updated.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString())
            assertEquals(initial.contentIntent, updated.contentIntent)
            assertEquals(initial.actions.map { it.actionIntent }, updated.actions.map { it.actionIntent })
            assertEquals(initial.channelId, updated.channelId)
            manager.cancel(route.requestCode); SystemClock.sleep(200)
            ExpandableNotification.updateIfCurrent(context, route.requestCode, "current", AgentNotificationContent("迟到", "不能复活"))
            assertNull(current())
        } finally { manager.cancel(route.requestCode) }
    }

    @Test fun blockedAlertUsesConversationTitleAndLongBodyWithoutWatchTruncation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.uiAutomation.executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS").close()
        val manager = context.getSystemService(NotificationManager::class.java)
        val sessionId = "herdr:notification-blocked-fixture"
        val hostId = "notification-fixture"
        val id = "$hostId\u0000$sessionId\u0000blocked".hashCode()
        val body = "需要确认的详细说明。".repeat(60)
        try {
            AgentMonitorService.publishStateAlert(context, hostId,
                ZeppBridgeAlert("fixture", sessionId, "发布应用需要确认", "手表短摘要", "blocked", 1), body)
            SystemClock.sleep(200)
            val notification = manager.activeNotifications.single { it.id == id }.notification
            assertEquals("发布应用需要确认", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
            assertEquals(body, notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString())
            assertNotNull(notification.contentIntent)
            assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
        } finally { manager.cancel(id) }
    }
}
