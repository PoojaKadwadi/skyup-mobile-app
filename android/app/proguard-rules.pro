# ─────────────────────────────────────────────────────────────────────────────
# ProGuard / R8 keep rules
# Required because PERF FIX in build.gradle enabled minifyEnabled = true.
# Without these rules R8 strips classes referenced only by native code or
# reflection (which it can't see), and the app crashes at startup with
# ClassNotFoundException.
# ─────────────────────────────────────────────────────────────────────────────

# ── React Native core ────────────────────────────────────────────────────────
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep,allowobfuscation @interface com.facebook.proguard.annotations.KeepGettersAndSetters
-keep,allowobfuscation @interface com.facebook.common.internal.DoNotStrip
-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keep @com.facebook.common.internal.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
    @com.facebook.common.internal.DoNotStrip *;
}
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# ── Hermes ───────────────────────────────────────────────────────────────────
-keep class com.facebook.hermes.unicode.** { *; }
-keep class com.facebook.jni.** { *; }

# ── Reanimated ───────────────────────────────────────────────────────────────
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# ── Vector Icons ─────────────────────────────────────────────────────────────
-keep class com.oblador.vectoricons.** { *; }

# ── Notifee ──────────────────────────────────────────────────────────────────
-keep class io.invertase.notifee.** { *; }

# ── react-native-call-log ────────────────────────────────────────────────────
-keep class com.wkh237.fetchblob.** { *; }
-keep class com.reactnative.calllog.** { *; }

# ── react-native-fs ──────────────────────────────────────────────────────────
-keep class com.rnfs.** { *; }

# ── react-native-keychain & encrypted-storage ────────────────────────────────
-keep class com.oblador.keychain.** { *; }
-keep class com.emekalites.react.** { *; }

# ── react-native-document-picker ─────────────────────────────────────────────
-keep class com.reactnativedocumentpicker.** { *; }

# ── Misc ─────────────────────────────────────────────────────────────────────
-keep class com.horcrux.svg.** { *; }
-dontwarn com.facebook.react.**
-dontwarn com.facebook.hermes.**

# ── Keep JS-callable native methods ──────────────────────────────────────────
-keepclassmembers class * extends com.facebook.react.bridge.JavaScriptModule { *; }
-keepclassmembers class * extends com.facebook.react.bridge.NativeModule {
    @com.facebook.react.bridge.ReactMethod <methods>;
}
-keep,includedescriptorclasses class * extends com.facebook.react.bridge.NativeModule { *; }
-keep,includedescriptorclasses class * extends com.facebook.react.uimanager.ViewManager { *; }
-keepclassmembers,includedescriptorclasses class * extends com.facebook.react.uimanager.ViewManager {
    public <methods>;
}

# ── Suppress warnings for okhttp + okio (used internally) ────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
