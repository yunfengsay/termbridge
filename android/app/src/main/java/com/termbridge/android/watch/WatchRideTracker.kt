package com.termbridge.android.watch

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

data class RidePoint(
    val latitude: Double,
    val longitude: Double,
    val altitudeMeters: Double,
    val accuracyMeters: Float,
    val speedMetersPerSecond: Float,
    val timeMillis: Long,
)

class RideAccumulator(private val clock: () -> Long = System::currentTimeMillis) {
    var active = false
        private set
    var manuallyPaused = false
        private set
    private var lastAccountedAt = 0L
    private var elapsedMillis = 0L
    private var autoPaused = true
    private var hasAcceptedPoint = false
    private var previous: RidePoint? = null
    private var distanceMeters = 0.0
    private var lastPoint: RidePoint? = null

    fun start() {
        active = true
        manuallyPaused = false
        lastAccountedAt = clock()
        elapsedMillis = 0
        autoPaused = true
        hasAcceptedPoint = false
        previous = null
        lastPoint = null
        distanceMeters = 0.0
    }

    fun pause() {
        if (!active || manuallyPaused) return
        accountElapsed(clock())
        manuallyPaused = true
        previous = null
    }

    fun resume() {
        if (!active || !manuallyPaused) return
        manuallyPaused = false
        autoPaused = false
        lastAccountedAt = clock()
        previous = null
    }

    fun stop() {
        accountElapsed(clock())
        manuallyPaused = false
        active = false
    }

    fun add(point: RidePoint): Boolean {
        if (!active || manuallyPaused || !point.isUsable()) return false
        val now = clock()
        hasAcceptedPoint = true
        val moving = point.speedMetersPerSecond >= AUTO_PAUSE_SPEED_METERS_PER_SECOND
        if (!moving) {
            autoPaused = true
            lastAccountedAt = now
            previous = null
            lastPoint = point
            return true
        }
        if (autoPaused) {
            autoPaused = false
            lastAccountedAt = now
            previous = null
        } else {
            accountElapsed(now)
        }
        previous?.let { prior ->
            val segment = distance(prior.latitude, prior.longitude, point.latitude, point.longitude)
            if (segment in 0.5..200.0) distanceMeters += segment
        }
        previous = point
        lastPoint = point
        return true
    }

    fun snapshot(heartRate: Int = 0, cadence: Int = 0): WatchActivitySnapshot {
        val now = clock()
        val running = if (active && !manuallyPaused && !autoPaused) (now - lastAccountedAt).coerceAtLeast(0) else 0
        val elapsed = (elapsedMillis + running) / 1_000
        val point = lastPoint
        val paused = manuallyPaused || (hasAcceptedPoint && autoPaused)
        return WatchActivitySnapshot(
            active = active,
            paused = paused,
            elapsedSeconds = elapsed,
            speedCentiKph = (if (paused) 0f else (point?.speedMetersPerSecond ?: 0f) * 360)
                .roundToInt().coerceAtLeast(0),
            distanceMeters = distanceMeters.roundToInt().coerceAtLeast(0),
            elevationDecimeters = ((point?.altitudeMeters ?: 0.0) * 10).roundToInt()
                .coerceIn(-100_000, 100_000),
            gpsAccuracyDecimeters = ((point?.accuracyMeters ?: 0f) * 10).roundToInt().coerceAtLeast(0),
            heartRate = heartRate,
            cadence = cadence,
            label = if (active) "骑行" else "",
        )
    }

    private fun accountElapsed(now: Long) {
        if (active && !manuallyPaused && !autoPaused) {
            elapsedMillis += (now - lastAccountedAt).coerceAtLeast(0)
        }
        lastAccountedAt = now
    }

    private fun RidePoint.isUsable(): Boolean =
        latitude.isFinite() && longitude.isFinite() && altitudeMeters.isFinite() &&
            accuracyMeters.isFinite() && speedMetersPerSecond.isFinite() &&
            latitude in -90.0..90.0 && longitude in -180.0..180.0 &&
            accuracyMeters in 0f..60f && speedMetersPerSecond >= 0f

    private fun distance(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val earth = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
            sin(dLon / 2) * sin(dLon / 2)
        return earth * 2 * asin(sqrt(a))
    }

    private companion object {
        const val AUTO_PAUSE_SPEED_METERS_PER_SECOND = 0.35f
    }
}

class WatchRideTracker(
    private val context: Context,
    private val onSnapshot: (WatchActivitySnapshot) -> Unit,
) : LocationListener {
    private val locationManager = context.getSystemService(LocationManager::class.java)
    private val accumulator = RideAccumulator()
    private var journal: BufferedWriter? = null
    private var journalFile: File? = null
    private var heartRate = 0
    private var cadence = 0

    @SuppressLint("MissingPermission")
    fun start() {
        accumulator.start()
        openJournal()
        locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1_000L, 2f, this)
        onSnapshot(accumulator.snapshot(heartRate, cadence))
    }

    fun pause() { accumulator.pause(); onSnapshot(accumulator.snapshot(heartRate, cadence)) }
    fun resume() { accumulator.resume(); onSnapshot(accumulator.snapshot(heartRate, cadence)) }

    fun stop(discard: Boolean = false) {
        locationManager.removeUpdates(this)
        accumulator.stop()
        closeJournal(finalize = !discard)
        if (discard) journalFile?.delete()
        onSnapshot(accumulator.snapshot(heartRate, cadence))
    }

    fun snapshot(): WatchActivitySnapshot = accumulator.snapshot(heartRate, cadence)

    fun updateFitnessSensors(heartRate: Int, cadence: Int) {
        this.heartRate = heartRate
        this.cadence = cadence
        onSnapshot(accumulator.snapshot(heartRate, cadence))
    }

    override fun onLocationChanged(location: Location) {
        val point = RidePoint(
            location.latitude, location.longitude, location.altitude,
            location.accuracy, location.speed.coerceAtLeast(0f), location.time,
        )
        if (accumulator.add(point)) journal?.apply {
            append("<trkpt lat=\"${point.latitude}\" lon=\"${point.longitude}\"><ele>${point.altitudeMeters}</ele>")
            append("<time>${gpxTime(point.timeMillis)}</time></trkpt>\n")
            flush()
        }
        onSnapshot(accumulator.snapshot(heartRate, cadence))
    }

    @Deprecated("Deprecated Android provider callback")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    private fun openJournal() {
        val directory = File(context.filesDir, "rides").apply { mkdirs() }
        journalFile = File(directory, "ride-${System.currentTimeMillis()}.gpx.part")
        journal = BufferedWriter(FileWriter(journalFile!!, false)).apply {
            append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
            append("<gpx version=\"1.1\" creator=\"TermBridge\" xmlns=\"http://www.topografix.com/GPX/1/1\"><trk><name>TermBridge Ride</name><trkseg>\n")
            flush()
        }
    }

    private fun closeJournal(finalize: Boolean) {
        runCatching { journal?.append("</trkseg></trk></gpx>\n")?.flush() }
        runCatching { journal?.close() }
        journal = null
        if (finalize) {
            journalFile?.let { partial ->
                val complete = File(partial.parentFile, partial.name.removeSuffix(".part"))
                if (partial.renameTo(complete)) journalFile = complete
            }
        }
    }

    private fun gpxTime(timestamp: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(timestamp))

    companion object {
        fun repairIncompleteJournals(context: Context) {
            val directory = File(context.filesDir, "rides")
            directory.listFiles { file -> file.name.endsWith(".gpx.part") }.orEmpty().forEach { partial ->
                runCatching {
                    val tail = partial.inputStream().buffered().use { input ->
                        if (partial.length() > GPX_TAIL_BYTES) input.skip(partial.length() - GPX_TAIL_BYTES)
                        input.readBytes().decodeToString()
                    }
                    if (!tail.contains("</gpx>")) {
                        FileWriter(partial, true).use { it.append("</trkseg></trk></gpx>\n") }
                    }
                    partial.renameTo(File(directory, partial.name.removeSuffix(".part")))
                }
            }
        }

        private const val GPX_TAIL_BYTES = 128L
    }
}
