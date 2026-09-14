package com.skyupcrm

import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * SecureScreenModule
 * ─────────────────────────────────────────────────────────────────────────
 * Exposes FLAG_SECURE toggling to JS so individual screens can opt in to
 * blocking screenshots / screen recording / the Recent Apps thumbnail
 * WITHOUT applying it app-wide (which would break normal usability, e.g.
 * sharing a dashboard screenshot).
 *
 * Intended callers (see src/services/secureScreen.js):
 *   - RecordingsScreen (call recording audio is sensitive conversation data)
 *   - LeadDetailScreen (customer PII: phone numbers, notes, remarks)
 *
 * Safe by design:
 *   - No-ops (does not throw) if called before an Activity is attached, or
 *     off the main thread — every call is posted to the UI thread via
 *     runOnUiThread.
 *   - Does not affect any other screen or global app behavior.
 *   - Purely a client-side UX/privacy hardening measure; it is NOT an
 *     authorization control and enforces nothing on its own.
 */
class SecureScreenModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "SecureScreenModule"

  @ReactMethod
  fun enable() {
    val activity = currentActivity ?: return
    activity.runOnUiThread {
      try {
        activity.window.setFlags(
          WindowManager.LayoutParams.FLAG_SECURE,
          WindowManager.LayoutParams.FLAG_SECURE
        )
      } catch (_: Exception) {
        // Never crash the app over a screen-privacy toggle.
      }
    }
  }

  @ReactMethod
  fun disable() {
    val activity = currentActivity ?: return
    activity.runOnUiThread {
      try {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } catch (_: Exception) {
        // Never crash the app over a screen-privacy toggle.
      }
    }
  }
}
