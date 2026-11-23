package com.termbridge.android.desktop

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.R
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Opt-in real-Mac rendering probe. Credentials arrive over an ADB-forwarded loopback socket, never arguments/files. */
@RunWith(AndroidJUnit4::class)
class DesktopSystemRenderingTest {
    @Test fun realSystemSharingRendersAndStaysConnected() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("desktopSystemLive") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val old = SettingsStore.load(context)
        fun children(v: View): List<View> = listOf(v) + if (v is ViewGroup) (0 until v.childCount).flatMap { children(v.getChildAt(it)) } else emptyList()
        val credentials = ServerSocket(38645, 1, InetAddress.getByName("127.0.0.1")).use { server ->
            server.soTimeout = 60000
            server.accept().use { socket -> socket.soTimeout = 5000; JSONObject(socket.getInputStream().bufferedReader().readLine()) }
        }
        val fixture = ConnectionSettings(credentials.optString("relayUrl", "ws://10.0.2.2:38643"), credentials.optString("hostId", "desktop-system-fixture"), credentials.optString("secret", "desktop-fixture-pairing-key"), credentials.optString("tlsPin", ""), "Mac rendering probe")
        require(SettingsStore.profiles(context).none { it.profileKey == fixture.profileKey && it.hostName != "Mac rendering probe" }) { "Use an isolated profile for this probe" }
        val store = DesktopCredentialStore(context, fixture)
        store.save(DesktopCredentialStore.Credentials(credentials.getString("username"), credentials.getString("password")))
        credentials.remove("password"); SettingsStore.save(context, fixture)
        try {
            ActivityScenario.launch<RemoteDesktopActivity>(RemoteDesktopActivity.intent(context, fixture.hostId)).use { scenario ->
                var ready = false
                val deadline = SystemClock.uptimeMillis() + 60000
                while (!ready && SystemClock.uptimeMillis() < deadline) {
                    scenario.onActivity { activity -> ready = children(activity.window.decorView).any { it.contentDescription == context.getString(R.string.desktop_keyboard) && it.isEnabled } }
                    SystemClock.sleep(100)
                }
                // Connection events precede the first framebuffer. Verify the stream remains alive after rendering.
                SystemClock.sleep(3000)
                val done = CountDownLatch(1); var result = ""
                scenario.onActivity { activity ->
                    children(activity.window.decorView).filterIsInstance<WebView>().first().evaluateJavascript("JSON.stringify({status:document.getElementById('status').textContent,width:document.querySelector('canvas')?.width,height:document.querySelector('canvas')?.height,visible:document.getElementById('screen').style.visibility,pixel:Array.from(document.querySelector('canvas')?.getContext('2d').getImageData(100,100,1,1).data ?? [])})") { result = it; done.countDown() }
                    ready = children(activity.window.decorView).any { it.contentDescription == context.getString(R.string.desktop_keyboard) && it.isEnabled }
                }
                assertTrue(done.await(5, TimeUnit.SECONDS))
                java.io.File(context.getExternalFilesDir(null), "desktop-system-state.json").writeText(result)
                instrumentation.uiAutomation.takeScreenshot().also { bitmap ->
                    java.io.File(context.getExternalFilesDir(null), "desktop-system-rendered.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle()
                }
                val state = JSONObject(org.json.JSONTokener(result).nextValue() as String)
                assertEquals("A connected socket and allocated canvas are insufficient: the frame must have opaque pixels", 255, state.getJSONArray("pixel").getInt(3))
                assertTrue("Viewer must remain connected after the first framebuffer: $result", ready)
                // Real WebView touch dispatch: pinch around the image centre, then pan.
                val bounds = IntArray(4)
                scenario.onActivity { activity ->
                    val web = children(activity.window.decorView).filterIsInstance<WebView>().first()
                    val location = IntArray(2); web.getLocationOnScreen(location)
                    bounds[0] = location[0]; bounds[1] = location[1]; bounds[2] = web.width; bounds[3] = web.height
                }
                val cx = bounds[0] + bounds[2] / 2f; val cy = bounds[1] + bounds[3] / 2f
                val down = SystemClock.uptimeMillis()
                fun touch(action: Int, xs: FloatArray, ys: FloatArray) {
                    val properties = Array(xs.size) { index -> android.view.MotionEvent.PointerProperties().apply { id = index; toolType = android.view.MotionEvent.TOOL_TYPE_FINGER } }
                    val points = Array(xs.size) { index -> android.view.MotionEvent.PointerCoords().apply { x = xs[index]; y = ys[index]; pressure = 1f; size = 1f } }
                    val event = android.view.MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, xs.size, properties, points, 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
                    assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true)); event.recycle()
                }
                val radius = bounds[2] / 20f
                touch(android.view.MotionEvent.ACTION_DOWN, floatArrayOf(cx-radius), floatArrayOf(cy))
                touch(android.view.MotionEvent.ACTION_POINTER_DOWN or (1 shl android.view.MotionEvent.ACTION_POINTER_INDEX_SHIFT), floatArrayOf(cx-radius,cx+radius), floatArrayOf(cy,cy))
                for (step in 1..12) { val r = radius * (1 + step / 4f); touch(android.view.MotionEvent.ACTION_MOVE,floatArrayOf(cx-r,cx+r),floatArrayOf(cy,cy)); SystemClock.sleep(20) }
                touch(android.view.MotionEvent.ACTION_POINTER_UP or (1 shl android.view.MotionEvent.ACTION_POINTER_INDEX_SHIFT),floatArrayOf(cx-radius*4,cx+radius*4),floatArrayOf(cy,cy))
                touch(android.view.MotionEvent.ACTION_UP,floatArrayOf(cx-radius*4),floatArrayOf(cy))
                touch(android.view.MotionEvent.ACTION_DOWN,floatArrayOf(cx),floatArrayOf(cy))
                for (step in 1..10) { touch(android.view.MotionEvent.ACTION_MOVE,floatArrayOf(cx-step*10),floatArrayOf(cy-step*5)); SystemClock.sleep(20) }
                touch(android.view.MotionEvent.ACTION_UP,floatArrayOf(cx-100),floatArrayOf(cy-50))
                SystemClock.sleep(3000)
                val zoomDone = CountDownLatch(1); var zoomState = ""
                scenario.onActivity { activity -> children(activity.window.decorView).filterIsInstance<WebView>().first().evaluateJavascript("JSON.stringify({zoom:document.getElementById('fit').textContent,status:document.getElementById('status').textContent,transform:document.getElementById('screen').style.transform})") { zoomState = it; zoomDone.countDown() } }
                assertTrue(zoomDone.await(5, TimeUnit.SECONDS))
                java.io.File(context.getExternalFilesDir(null), "desktop-system-zoom.json").writeText(zoomState)
                instrumentation.uiAutomation.takeScreenshot().also { bitmap -> java.io.File(context.getExternalFilesDir(null), "desktop-system-zoom.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle() }
                val zoomResult = JSONObject(org.json.JSONTokener(zoomState).nextValue() as String)
                assertTrue("Pinch must actually zoom: $zoomState", zoomResult.getString("zoom").removeSuffix("%").toInt() >= 300)
                assertEquals("已连接", zoomResult.getString("status"))
                if (InstrumentationRegistry.getArguments().getString("desktopPointerFixture") == "true") {
                    val projectionDone = CountDownLatch(1); var projection = ""
                    scenario.onActivity { activity -> children(activity.window.decorView).filterIsInstance<WebView>().first().evaluateJavascript("JSON.stringify((()=>{const r=document.getElementById('screen').getBoundingClientRect();return {x:r.left+r.width*800/1280,y:r.top+r.height*400/720,vw:innerWidth,vh:innerHeight}})())") { projection = it; projectionDone.countDown() } }
                    assertTrue(projectionDone.await(5, TimeUnit.SECONDS))
                    val projected = JSONObject(org.json.JSONTokener(projection).nextValue() as String)
                    val x = projected.getDouble("x"); val y = projected.getDouble("y")
                    assertTrue(x > 0 && x < projected.getDouble("vw") && y > 0 && y < projected.getDouble("vh"))
                    val px = bounds[0] + (x * bounds[2] / projected.getDouble("vw")).toFloat()
                    val py = bounds[1] + (y * bounds[3] / projected.getDouble("vh")).toFloat()
                    touch(android.view.MotionEvent.ACTION_DOWN,floatArrayOf(px),floatArrayOf(py))
                    SystemClock.sleep(50)
                    touch(android.view.MotionEvent.ACTION_UP,floatArrayOf(px),floatArrayOf(py))
                    SystemClock.sleep(1000)
                    java.io.File(context.getExternalFilesDir(null), "desktop-pointer-expected.json").writeText("{\"x\":800,\"y\":400,\"width\":1280,\"height\":720}")
                }


            }
        } finally { store.clear(); SettingsStore.remove(context, fixture.profileKey); SettingsStore.select(context, old.profileKey) }
    }
}
