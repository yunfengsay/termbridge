package com.termbridge.android.brain

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.brain.personalization.PersonalControlStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Isolated test files/preferences only. Never a microphone, private history, or real Host upload. */
@RunWith(AndroidJUnit4::class)
class PersonalControlStoreTest {
    @Test fun contextConsentReviewSyncDeletionAndRestartAreARealStorageLoop() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "learning-test-${UUID.randomUUID()}"
        val directory = File(base.cacheDir, name).apply { mkdirs() }
        val prefs = mutableSetOf<String>()
        val context = object : ContextWrapper(base) {
            override fun getNoBackupFilesDir(): File = directory
            override fun getSharedPreferences(key: String, mode: Int): SharedPreferences {
                val isolated = "$name-$key"; prefs.add(isolated)
                return base.getSharedPreferences(isolated, Context.MODE_PRIVATE)
            }
        }
        try {
            val store = PersonalControlStore(context)
            val features = listOf(.9, .4, .5, .0, 1.0, .0)
            val group = UUID.randomUUID().toString()
            assertFalse(store.record(group, features, text = "private fixture"))
            store.consent(true)
            store.record(group, features, text = "not-consented-text")
            assertFalse(store.snapshot().toString().contains("not-consented-text"))
            store.contextConsent(true)
            store.record(group, features, text = "我最近的", context = "看一下 Agent")
            val observation = store.snapshot().getJSONArray("observations").getJSONObject(1).getString("id")
            assertEquals(0, (store.request(UUID.randomUUID().toString())["samples"] as List<*>).size)
            store.label(observation, "finished", 0)
            val revision = store.snapshot().getLong("revision")
            val request = store.request(UUID.randomUUID().toString())
            assertEquals("我最近的", ((request["samples"] as List<*>)[0] as Map<*, *>)["text"])
            assertTrue(store.needsSync("host-a"))
            assertTrue(store.acknowledge("host-a", revision))
            assertFalse(store.needsSync("host-a")); assertTrue(store.needsSync("host-b"))
            store.record(group, features, text = "新片段")
            assertEquals(revision, store.snapshot().getLong("revision"))
            store.delete(observation)
            assertFalse(store.acknowledge("host-a", revision))
            assertTrue(store.needsSync("host-a"))
            store.contextConsent(false)
            assertFalse(store.snapshot().toString().contains("新片段"))
            store.consent(false)
            val restarted = PersonalControlStore(context)
            assertEquals(0, restarted.snapshot().getJSONArray("observations").length())
            assertFalse(restarted.snapshot().getBoolean("enabled"))
            assertTrue(restarted.needsSync("host-a"))
        } finally {
            directory.deleteRecursively() // Only this test-created unique directory.
            prefs.forEach { base.deleteSharedPreferences(it) }
        }
    }
}
