package com.termbridge.android.assistant

import android.os.Bundle
import android.service.voice.VoiceInteractionService

class TermbridgeVoiceInteractionService : VoiceInteractionService() {
    override fun onLaunchVoiceAssistFromKeyguard() {
        showSession(Bundle.EMPTY, 0)
    }
}
