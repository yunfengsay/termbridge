package com.termbridge.android.update

import android.app.Application
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.MutableLiveData
import com.termbridge.android.peer.PeerApkInstaller
import com.termbridge.android.peer.PeerInstallState
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.Future

internal enum class UpdatePhase { IDLE, CHECKING, CURRENT, AVAILABLE, UNSUPPORTED, DOWNLOADING, READY, INSTALLING, ERROR }
internal data class UpdateState(val phase: UpdatePhase = UpdatePhase.IDLE, val release: UpdateArtifact? = null,
    val progress: Int = 0, val error: String? = null)

/** Retains download and progress through rotation; no background polling or automatic APK download. */
class AppUpdateModel(app: Application) : AndroidViewModel(app) {
    internal val state = MutableLiveData(UpdateState())
    @Suppress("DEPRECATION") private val installed = app.packageManager.getPackageInfo(app.packageName, 0)
    val currentVersion: String = "${installed.versionName} (${PackageInfoCompat.getLongVersionCode(installed)})"
    private val repository = UpdateRepository(app)
    private val executor = Executors.newSingleThreadExecutor()
    private var job: Future<*>? = null
    private var downloaded: File? = null
    private var generation = 0
    private var artifactId: String? = null
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private val stopObservingInstaller = PeerInstallState.observe(app) { main.post { refreshInstaller() } }

    fun check() = perform(UpdateState(UpdatePhase.CHECKING)) { publish ->
        val release = repository.check()
        val phase = when {
            release.minSdk > Build.VERSION.SDK_INT -> UpdatePhase.UNSUPPORTED
            release.newerThan(PackageInfoCompat.getLongVersionCode(installed), Build.VERSION.SDK_INT) -> UpdatePhase.AVAILABLE
            else -> UpdatePhase.CURRENT
        }
        publish(UpdateState(phase, release))
    }

    fun download() {
        val release = state.value?.release ?: return
        perform(UpdateState(UpdatePhase.DOWNLOADING, release)) { publish ->
            downloaded = repository.download(release) { publish(UpdateState(UpdatePhase.DOWNLOADING, release, it)) }
            publish(UpdateState(UpdatePhase.READY, release, 100))
        }
    }

    fun install() {
        val release = state.value?.release ?: return
        val file = downloaded ?: return
        perform(UpdateState(UpdatePhase.INSTALLING, release)) { publish ->
            repository.validatePackage(file, release)
            val id = "update-${release.sha256.take(24)}"
            artifactId = id
            val result = PeerApkInstaller.install(getApplication(), id, file)
            check(result["status"] == "submitted") { "Install permission required" }
            publish(UpdateState(UpdatePhase.INSTALLING, release))
        }
    }

    fun refreshInstaller() {
        if (state.value?.phase != UpdatePhase.INSTALLING) return
        val id = artifactId ?: return
        val receipt = PeerInstallState.read(getApplication(), id)
        if (receipt["status"] == "failed") state.value = UpdateState(UpdatePhase.ERROR, state.value?.release,
            error = receipt["message"]?.toString()?.take(160))
        else if (receipt["status"] == "installed") state.value = UpdateState(UpdatePhase.CURRENT, state.value?.release)
    }

    fun cancel() {
        generation++
        repository.cancel(); job?.cancel(true)
        state.value = state.value?.release?.let { UpdateState(UpdatePhase.AVAILABLE, it) } ?: UpdateState()
    }

    private fun perform(initial: UpdateState, action: ((UpdateState) -> Unit) -> Unit) {
        if (job?.isDone == false) return
        val current = ++generation
        state.value = initial
        val publish: (UpdateState) -> Unit = { next -> main.post { if (generation == current) state.value = next } }
        job = executor.submit {
            try { action(publish) }
            catch (error: Exception) { publish(UpdateState(UpdatePhase.ERROR, initial.release, error = error.message?.take(160))) }
        }
    }

    override fun onCleared() {
        stopObservingInstaller()
        generation++; repository.cancel(); job?.cancel(true); executor.shutdownNow(); main.removeCallbacksAndMessages(null)
    }
}
