plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.alakazamlabs.k2so.push"
    compileSdk = 34

    defaultConfig {
        minSdk = 24

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")

    // DORMANT-FIRST: the FCM SDK compiles in WITHOUT the google-services
    // gradle plugin or a google-services.json. Until the app ships those
    // (see docs/push-activation.md), FirebaseApp.getApps() stays empty and
    // K2PushPlugin reports unavailable at runtime. Removing this dependency
    // is the ONE thing that breaks compilation (K2FirebaseMessagingService
    // extends its service class) — keep it.
    implementation("com.google.firebase:firebase-messaging:24.1.0")

    implementation(project(":tauri-android"))
}
