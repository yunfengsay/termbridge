package com.termbridge.android.desktop

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.data.ConnectionSettings
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DesktopCredentialStoreTest {
    @Test fun keystoreRoundTripIsEncryptedScopedAndRemovable() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("desktopCredentialsFixture") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val profile = ConnectionSettings("wss://desktop-credentials-fixture.invalid", "test-host", "test-pairing", "")
        val store = DesktopCredentialStore(context, profile)
        val otherHost = DesktopCredentialStore(context, profile.copy(hostId = "other-test-host"))
        val otherPairing = DesktopCredentialStore(context, profile.copy(secret = "another-pairing"))
        val before = context.noBackupFilesDir.listFiles().orEmpty().map { it.name }.toSet()
        try {
            store.clear(); otherHost.clear(); otherPairing.clear()
            store.save(DesktopCredentialStore.Credentials("fixture-user", "fixture-secret-中文"))
            val saved = DesktopCredentialStore(context, profile).load()!!
            assertEquals("fixture-user", saved.username)
            assertEquals("fixture-secret-中文", saved.password)
            assertNull(otherHost.load()); assertNull(otherPairing.load())
            val encrypted = context.noBackupFilesDir.listFiles().orEmpty().single { it.name !in before && it.name.startsWith("desktop-login-") }
            assertFalse(encrypted.readBytes().toString(Charsets.UTF_8).contains("fixture-secret"))
            // A corrupted record must fail closed, never surface or use partial credentials.
            val bytes = encrypted.readBytes(); bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); encrypted.writeBytes(bytes)
            assertNull(store.load())
            store.clear(); assertNull(store.load())
        } finally { store.clear(); otherHost.clear(); otherPairing.clear() }
    }
}
