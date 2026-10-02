import java.util.Properties

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val apiBaseUrl = providers.gradleProperty("apiBaseUrl")
val debugApiBaseUrl = apiBaseUrl.orElse("http://10.0.2.2:8787").get()
val releaseApiBaseUrl = apiBaseUrl.orElse("https://remo-api.just-do-it-my-life.workers.dev").get()
val localProperties = Properties().apply {
    val propertiesFile = rootProject.file("local.properties")
    if (propertiesFile.isFile) propertiesFile.inputStream().use(::load)
}
val mapsApiKey = providers.gradleProperty("mapsApiKey")
    .orElse(providers.environmentVariable("MAPS_API_KEY"))
    .orElse(providers.provider { localProperties.getProperty("mapsApiKey", "") })
    .get()

// Release signing comes from gradle properties, environment variables or
// local.properties (releaseStoreFile, releaseStorePassword, releaseKeyAlias,
// releaseKeyPassword). Without them, release builds fall back to the debug key
// so they stay installable for local verification only.
fun signingValue(name: String): String? = providers.gradleProperty(name)
    .orElse(providers.environmentVariable("REMO_" + name.replace(Regex("([A-Z])"), "_$1").uppercase()))
    .orElse(providers.provider { localProperties.getProperty(name) ?: "" })
    .get().takeIf(String::isNotBlank)
val releaseStoreFile = signingValue("releaseStoreFile")

fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

android {
    namespace = "com.remo.app"
    compileSdk = 36

    defaultConfig {
        applicationId = providers.gradleProperty("applicationId").orElse("com.remo.app").get()
        minSdk = 24
        targetSdk = 36
        // Each store upload needs a higher code: pass -PversionCode=<n> (and
        // -PversionName=<x.y.z>) from the release pipeline.
        versionCode = providers.gradleProperty("versionCode").map(String::toInt).orElse(1).get()
        versionName = providers.gradleProperty("versionName").orElse("0.1.0").get()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        manifestPlaceholders["MAPS_API_KEY"] = mapsApiKey
    }

    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile)
                storePassword = signingValue("releaseStorePassword")
                keyAlias = signingValue("releaseKeyAlias")
                keyPassword = signingValue("releaseKeyPassword")
            }
        }
    }

    buildTypes {
        debug { buildConfigField("String", "API_BASE_URL", buildConfigString(debugApiBaseUrl)) }
        release {
            buildConfigField("String", "API_BASE_URL", buildConfigString(releaseApiBaseUrl))
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = if (releaseStoreFile != null) signingConfigs.getByName("release") else {
                logger.warn("Release signing is not configured; signing the release build with the debug key (not for distribution).")
                signingConfigs.getByName("debug")
            }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
    buildFeatures { buildConfig = true; compose = true }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.play.services.maps)
    implementation(libs.play.services.location)
    implementation(libs.androidx.work.runtime)
    testImplementation(libs.junit)
    // android.jar only has org.json stubs; the golden test parses the shared fixture.
    testImplementation("org.json:json:20250517")
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    debugImplementation(libs.androidx.compose.ui.tooling)
}
