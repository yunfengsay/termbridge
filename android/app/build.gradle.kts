plugins {
    id("com.android.application")
}

android {
    namespace = "com.termbridge.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.termbridge.android"
        minSdk = 24
        targetSdk = 36
        versionCode = 22
        versionName = "0.1.37"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "DEFAULT_RELAY_URL", "\"ws://10.0.2.2:7400\"")
        buildConfigField("String", "DEFAULT_HOST_ID", "\"\"")
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    androidResources {
        noCompress += "onnx"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/DEPENDENCIES",
            "META-INF/LICENSE",
            "META-INF/LICENSE.txt",
            "META-INF/NOTICE",
            "META-INF/NOTICE.txt",
        )
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    implementation("com.google.android.material:material:1.13.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    implementation("io.github.jaredmdobson:concentus:1.0.2")
    implementation("io.noties.markwon:syntax-highlight:4.6.2") {
        exclude(group = "org.jetbrains", module = "annotations-java5")
    }
    implementation("io.noties:prism4j:2.0.0") {
        exclude(group = "org.jetbrains", module = "annotations-java5")
    }
    implementation("org.msgpack:msgpack-core:0.9.12")
    implementation(files("libs/sherpa-onnx-1.13.6-arm64.aar"))

    annotationProcessor("io.noties:prism4j-bundler:2.0.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
