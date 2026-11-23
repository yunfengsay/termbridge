package com.termbridge.android.brain

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Compile the real AGSL on-device; no microphone, screen capture or network access. */
@RunWith(AndroidJUnit4::class)
class CompactOrbShaderTest {
    @Test fun translucentCompactShaderCompiles() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        VoiceAuraRenderer()
    }
}
