package com.termbridge.android

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

data class EncodedImage(
    val mime: String,
    val data: ByteArray,
)

object NativeImageEncoder {
    fun encode(resolver: ContentResolver, uri: Uri): EncodedImage {
        val decoded = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            decodeModern(resolver, uri)
        } else {
            decodeLegacy(resolver, uri)
        } ?: error("Android could not decode this image")

        val scaled = scaleTo(decoded, MAX_DIMENSION)
        val flattened = Bitmap.createBitmap(scaled.width, scaled.height, Bitmap.Config.ARGB_8888).also { output ->
            Canvas(output).apply {
                drawColor(Color.WHITE)
                drawBitmap(scaled, 0f, 0f, null)
            }
        }
        val data = compress(flattened, JPEG_QUALITY)
        if (flattened !== scaled) flattened.recycle()
        if (scaled !== decoded) scaled.recycle()
        decoded.recycle()
        require(data.size <= MAX_UPLOAD_BYTES) { "Converted image is larger than 4 MB" }
        return EncodedImage("image/jpeg", data)
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private fun decodeModern(resolver: ContentResolver, uri: Uri): Bitmap =
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val width = info.size.width
            val height = info.size.height
            val largest = max(width, height)
            if (largest > MAX_DIMENSION) {
                val scale = MAX_DIMENSION.toFloat() / largest
                decoder.setTargetSize((width * scale).roundToInt(), (height * scale).roundToInt())
            }
        }

    private fun decodeLegacy(resolver: ContentResolver, uri: Uri): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Android could not read the image dimensions" }
        var sample = 1
        while (max(bounds.outWidth / sample, bounds.outHeight / sample) > MAX_DIMENSION * 2) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    }

    private fun scaleTo(bitmap: Bitmap, maxDimension: Int): Bitmap {
        val largest = max(bitmap.width, bitmap.height)
        if (largest <= maxDimension) return bitmap
        val scale = maxDimension.toFloat() / largest
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * scale).roundToInt(),
            (bitmap.height * scale).roundToInt(),
            true,
        )
    }

    private fun compress(bitmap: Bitmap, quality: Int): ByteArray =
        ByteArrayOutputStream().use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)) { "Image conversion failed" }
            output.toByteArray()
        }

    private const val MAX_DIMENSION = 1_600
    private const val MAX_UPLOAD_BYTES = 4 * 1024 * 1024
    private const val JPEG_QUALITY = 86
}
