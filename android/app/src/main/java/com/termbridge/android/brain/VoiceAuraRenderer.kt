package com.termbridge.android.brain

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi

/** GPU-rendered layered voice body on Android 13+. */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
internal class VoiceAuraRenderer {
    private val shader = RuntimeShader(SHADER)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.DITHER_FLAG).apply {
        this.shader = this@VoiceAuraRenderer.shader
    }

    fun draw(
        canvas: Canvas,
        width: Int,
        height: Int,
        centerY: Float,
        baseRadius: Float,
        energy: Float,
        rhythm: Float,
        seconds: Float,
        phase: Float,
        compact: Boolean = false,
    ) {
        val shortSide = minOf(width, height).toFloat()
        shader.setFloatUniform("uResolution", width.toFloat(), height.toFloat())
        shader.setFloatUniform("uCenterY", centerY)
        shader.setFloatUniform("uBaseRadius", baseRadius / shortSide)
        shader.setFloatUniform("uEnergy", energy)
        shader.setFloatUniform("uRhythm", rhythm)
        shader.setFloatUniform("uTime", seconds)
        shader.setFloatUniform("uPhase", phase)
        shader.setFloatUniform("uCompact", if (compact) 1f else 0f)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    }

    private companion object {
        private const val SHADER = """
            uniform float2 uResolution;
            uniform float uCenterY;
            uniform float uBaseRadius;
            uniform float uEnergy;
            uniform float uRhythm;
            uniform float uTime;
            uniform float uPhase;
            uniform float uCompact;

            float2 rotatePoint(float2 point, float angle) {
                float sine = sin(angle);
                float cosine = cos(angle);
                return float2(
                    cosine * point.x - sine * point.y,
                    sine * point.x + cosine * point.y
                );
            }

            float noise(float2 point) {
                float2 cell = floor(point);
                float2 local = fract(point);
                local = local * local * (3.0 - 2.0 * local);
                float a = fract(sin(dot(cell, float2(127.1, 311.7))) * 43758.5453);
                float b = fract(sin(dot(cell + float2(1.0, 0.0), float2(127.1, 311.7))) * 43758.5453);
                float c = fract(sin(dot(cell + float2(0.0, 1.0), float2(127.1, 311.7))) * 43758.5453);
                float d = fract(sin(dot(cell + float2(1.0, 1.0), float2(127.1, 311.7))) * 43758.5453);
                return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
            }

            float cloudNoise(float2 point) {
                float value = noise(point) * 0.64;
                point = rotatePoint(point * 2.03, 0.47) + 11.7;
                value += noise(point) * 0.25;
                point = rotatePoint(point * 2.07, -0.31) + 7.3;
                return value + noise(point) * 0.11;
            }

            float2 layerSpace(
                float2 point,
                float rotation,
                float squash,
                float shear
            ) {
                float2 local = rotatePoint(point, -rotation);
                local.x += local.y * shear;
                local.y /= max(squash, 0.28);
                return local;
            }

            // A soft ellipse clipped by a curved plane. Different transforms make
            // semicircles, leaves and teardrops without bitmap layer assets.
            float lobe(
                float2 point,
                float2 center,
                float2 scale,
                float cut,
                float curve,
                float feather
            ) {
                float2 local = (point - center) / scale;
                float outer = 1.0 - smoothstep(1.0 - feather, 1.0 + feather, length(local));
                float boundary = local.x + curve * local.y * local.y - cut;
                float clipped = smoothstep(-feather * 1.8, feather * 1.8, boundary);
                return outer * clipped;
            }

            float capsule(float2 point, float halfLength, float radius, float feather) {
                float2 nearest = float2(clamp(point.x, -halfLength, halfLength), 0.0);
                float distanceToSegment = length(point - nearest) - radius;
                return 1.0 - smoothstep(-feather, feather, distanceToSegment);
            }

            float3 screenLayer(float3 base, float3 tint, float amount) {
                float3 layer = clamp(tint * amount, 0.0, 1.0);
                return 1.0 - (1.0 - base) * (1.0 - layer);
            }

            half4 main(float2 pixel) {
                float shortSide = min(uResolution.x, uResolution.y);
                float2 uv = pixel / uResolution;
                float aspect = uResolution.x / uResolution.y;
                float2 screenPoint = (uv - float2(0.5, 0.48)) * float2(aspect, 1.0);

                // Large domain-warped fields keep the stage dark but not flat.
                float cloudTime = uTime * 0.055;
                float2 cloudPoint = (uv - 0.5) * float2(aspect, 1.0) * 1.08;
                float cloudWarp = cloudNoise(
                    cloudPoint * 1.02 + float2(cloudTime * 0.31, -cloudTime * 0.19)
                );
                float cloudA = cloudNoise(
                    cloudPoint * 1.26 + float2(cloudWarp * 0.68, -cloudWarp * 0.41) +
                        float2(-cloudTime * 0.17, cloudTime * 0.23)
                );
                float cloudB = cloudNoise(
                    rotatePoint(cloudPoint * 1.10, 1.03) +
                        float2(cloudTime * 0.19, cloudTime * 0.14)
                );
                cloudA = smoothstep(0.24, 0.88, cloudA + cloudWarp * 0.21);
                cloudB = smoothstep(0.27, 0.86, cloudB);
                float vignette = 1.0 - smoothstep(0.26, 0.91, length(screenPoint));
                float3 background = float3(0.0035, 0.0060, 0.0110);
                background += float3(0.008, 0.038, 0.066) * cloudA;
                background += float3(0.062, 0.010, 0.031) * cloudB;
                background += float3(0.022, 0.007, 0.026) * cloudA * cloudB;
                background *= 0.66 + 0.34 * vignette;

                float2 center = float2(uResolution.x * 0.5, uCenterY);
                float2 point = (pixel - center) / shortSide;
                float2 bodyPoint = point / uBaseRadius;
                float time = uPhase;
                // A perceptual response curve keeps idle motion calm while making normal
                // speech visibly drive the body long before the microphone reaches 1.0.
                float voiceDrive = smoothstep(0.045, 0.68, uEnergy);
                float activity = clamp(voiceDrive * 0.86 + uRhythm * 0.62, 0.0, 1.0);

                // The sphere stays round but never mathematically rigid.
                float voiceScale = 1.0 + activity * 0.105 + uRhythm * 0.028;
                bodyPoint /= voiceScale;
                float stretch = 1.0 + 0.018 * sin(time * 0.42) + activity * 0.034;
                bodyPoint /= float2(stretch, 2.0 - stretch);
                float angle = atan(bodyPoint.y, bodyPoint.x);
                float boundary = 1.0 +
                    sin(angle * 3.0 + time * 0.31) * (0.006 + activity * 0.029) +
                    sin(angle * 5.0 - time * 0.22 + 1.4) * (0.004 + activity * 0.019) +
                    sin(angle * 8.0 + time * 0.47 - 0.8) * activity * uRhythm * 0.012;
                float radius = length(bodyPoint) / boundary;
                float inside = 1.0 - smoothstep(0.985, 1.012, radius);
                float depth = sqrt(max(0.0, 1.0 - min(radius * radius, 1.0)));

                // Mild lensing bends every layer together while preserving the rim.
                float lens = 1.0 - 0.105 * max(1.0 - radius * radius, 0.0);
                float2 fieldPoint = bodyPoint * lens;
                float voiceWarp = activity * (0.014 + uRhythm * 0.024);
                fieldPoint += float2(
                    sin(fieldPoint.y * 4.7 + time * 0.83),
                    sin(fieldPoint.x * 4.1 - time * 0.71 + 1.2)
                ) * voiceWarp;
                float spread = 1.0 + activity * 0.15;
                fieldPoint /= spread;

                // Seven independently transformed area layers mirror the source
                // animation's half-disc, leaf, capsule and teardrop construction.
                float2 blueRightPoint = layerSpace(
                    fieldPoint,
                    0.46 + time * 0.29,
                    0.70 + 0.08 * sin(time * 0.21),
                    -0.17 + 0.08 * sin(time * 0.17)
                );
                float blueRight = lobe(
                    blueRightPoint,
                    float2(-0.10, 0.00),
                    float2(1.04, 1.00),
                    -0.03,
                    0.12,
                    0.050
                ) * inside;

                float2 blueMiddlePoint = layerSpace(
                    fieldPoint,
                    -0.98 - time * 0.23,
                    0.47 + 0.08 * cos(time * 0.18),
                    0.24
                );
                float blueMiddle = lobe(
                    blueMiddlePoint,
                    float2(-0.22, 0.02),
                    float2(0.98, 0.82),
                    0.05,
                    -0.20,
                    0.052
                ) * inside;

                float2 pinkTopPoint = layerSpace(
                    fieldPoint,
                    1.56 + time * 0.20,
                    0.58 + 0.07 * sin(time * 0.25 + 1.2),
                    -0.12
                );
                float pinkTop = lobe(
                    pinkTopPoint,
                    float2(-0.27, -0.03),
                    float2(0.91, 0.78),
                    0.31,
                    0.23,
                    0.054
                ) * inside;

                float2 pinkLeftPoint = layerSpace(
                    fieldPoint,
                    -0.42 + time * 0.17,
                    0.78 + 0.06 * cos(time * 0.16),
                    0.20
                );
                float pinkLeft = lobe(
                    pinkLeftPoint,
                    float2(-0.08, 0.02),
                    float2(1.05, 0.90),
                    -0.14,
                    0.34,
                    0.050
                ) * inside;

                float2 greenLeftPoint = layerSpace(
                    fieldPoint,
                    0.92 - time * 0.19,
                    0.67 + 0.09 * sin(time * 0.14 + 2.1),
                    -0.26
                );
                float greenLeft = lobe(
                    greenLeftPoint,
                    float2(-0.10, -0.02),
                    float2(1.03, 0.86),
                    -0.08,
                    -0.31,
                    0.055
                ) * inside;

                // Rotate with wall-clock time too: the layer phase barely advances
                // while idle, and a sharp, still capsule reads as a frozen streak.
                float2 greenRightPoint = layerSpace(
                    fieldPoint,
                    -0.10 + time * 0.13 + uTime * 0.17,
                    0.58 + 0.08 * sin(time * 0.20),
                    0.15
                );
                float greenRight = capsule(
                    greenRightPoint - float2(
                        0.05 + 0.07 * sin(uTime * 0.23),
                        0.05 * cos(uTime * 0.19)
                    ),
                    0.52,
                    0.16 + activity * 0.05,
                    0.085
                ) * inside;

                float2 bottomPinkPoint = layerSpace(
                    fieldPoint,
                    2.34 - time * 0.14,
                    0.52 + 0.06 * cos(time * 0.19),
                    -0.18
                );
                float bottomPink = lobe(
                    bottomPinkPoint,
                    float2(-0.30, 0.03),
                    float2(0.90, 0.78),
                    0.34,
                    -0.15,
                    0.058
                ) * inside;

                float layerShade = 0.54 + depth * 0.38;
                float pulse = 0.92 + activity * 0.43;
                float3 field = float3(0.0);
                field = screenLayer(field, float3(0.050, 0.42, 0.96), blueRight * 0.66 * layerShade * pulse);
                field = screenLayer(field, float3(0.13, 0.64, 1.00), blueMiddle * 0.60 * layerShade * pulse);
                field = screenLayer(field, float3(0.98, 0.13, 0.32), pinkTop * 0.63 * layerShade * pulse);
                field = screenLayer(field, float3(0.80, 0.15, 0.74), pinkLeft * 0.58 * layerShade * pulse);
                field = screenLayer(field, float3(0.13, 0.88, 0.72), greenLeft * 0.48 * layerShade * pulse);
                field = screenLayer(field, float3(0.30, 0.96, 0.88), greenRight * 0.50 * layerShade * pulse);
                field = screenLayer(field, float3(0.94, 0.20, 0.50), bottomPink * 0.42 * layerShade * pulse);

                float overlap =
                    blueRight * pinkLeft +
                    blueMiddle * pinkTop +
                    greenRight * max(blueRight, pinkLeft) +
                    greenLeft * bottomPink;
                float hot = smoothstep(0.52, 1.72, overlap) *
                    exp(-dot(fieldPoint * 1.22, fieldPoint * 1.22));
                field = screenLayer(
                    field,
                    float3(1.0, 0.94, 0.88),
                    hot * (0.30 + activity * 0.34)
                );

                // Controlled diffusion creates volume without erasing the layer edges.
                float fieldEnergy = max(field.r, max(field.g, field.b));
                float volume = exp(-pow(radius / 0.91, 5.0)) * inside;
                float3 light = field;
                light += field * fieldEnergy * (0.13 + activity * 0.15);
                light += float3(0.020, 0.042, 0.082) * volume;

                // Asymmetric glass: colored refraction on the sides, almost no top ring.
                float sideArc = smoothstep(0.30, 0.91, abs(bodyPoint.x) / max(radius, 0.001));
                float rimWidth = mix(0.012, 0.031, sideArc);
                float rim = exp(-pow((radius - 0.992) / rimWidth, 2.0));
                float3 rimTint = mix(
                    float3(0.55, 0.14, 0.45),
                    float3(0.10, 0.48, 0.78),
                    smoothstep(-0.82, 0.82, bodyPoint.x)
                );
                light += rimTint * rim * (0.025 + sideArc * 0.095 + fieldEnergy * 0.055);
                float fresnel = pow(max(0.0, 1.0 - depth), 3.1) * inside;
                light += float3(0.09, 0.17, 0.29) * fresnel * 0.052;

                light = light / (1.0 + light * 0.30);
                float nearGlow = exp(-pow((radius - 1.0) / 0.16, 2.0));
                float farGlow = exp(-pow((radius - 1.0) / 0.34, 2.0));
                float3 glow = mix(float3(0.14, 0.045, 0.12), float3(0.025, 0.11, 0.19), uv.x);
                glow *= nearGlow * (0.018 + fieldEnergy * 0.052 + activity * 0.020) + farGlow * 0.006;

                float3 color = background + glow + light;
                if (uCompact > 0.5) {
                    // Premultiplied translucent glass/light, not an opaque miniature black stage.
                    float edge = 1.0 - smoothstep(0.40, 0.49, length((pixel - uResolution * 0.5) / min(uResolution.x, uResolution.y)));
                    float glass = 0.10 * exp(-radius * radius * 0.42);
                    float3 radiance = clamp(light + glow, 0.0, 1.0);
                    float opacity = clamp(max(max(radiance.r, radiance.g), radiance.b) + glass, 0.0, 0.92);
                    float3 premultiplied = min(radiance + float3(0.40, 0.46, 0.54) * glass, float3(opacity));
                    return half4(half3(premultiplied * edge), half(opacity * edge));
                }
                return half4(half3(clamp(color, 0.0, 1.0)), 1.0);
            }
        """
    }
}
