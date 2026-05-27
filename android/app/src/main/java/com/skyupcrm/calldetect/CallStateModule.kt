package com.skyupcrm.calldetect

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.Executor

/**
 * CallStateModule — native bridge that emits telephony state changes to JS.
 *
 * WHY THIS EXISTS:
 *   The previous AttendanceWidget would auto-trigger an idle break after 5
 *   minutes of no app interaction. While a user is on a phone call (which
 *   takes the app to background and is the dominant "no interaction" case),
 *   they would get incorrectly marked idle. This module emits real-time call
 *   state events so JS can pause idle detection while a call is in progress.
 *
 * API-VERSION-AWARE IMPLEMENTATION:
 *   API 31+ (Android 12+):   uses TelephonyCallback (current, non-deprecated)
 *   API 24-30 (Android 7-11): uses PhoneStateListener (deprecated but only
 *                             option below 31)
 *   The behaviour and emitted events are identical from JS's perspective.
 *
 * EVENTS EMITTED:
 *   "CallStateChanged" with payload { state: String, timestamp: Long }
 *   state ∈ { "idle", "ringing", "offhook" }
 *     - idle:    no active call
 *     - ringing: incoming call, not yet answered
 *     - offhook: call in progress (incoming answered or outgoing made)
 *
 * BATTERY:
 *   Telephony listeners are event-driven by the OS — they consume zero CPU
 *   when no call is active. There is NO polling, NO timer, NO wake lock.
 *   Total cost when idle is the listener registration only.
 *
 * THREADING:
 *   Callbacks arrive on a system-managed thread. The bridge call to emit
 *   the JS event is thread-safe — DeviceEventManagerModule handles the hop
 *   to the JS thread internally.
 */
class CallStateModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CallStateModule"

  // Holds the active listener so we can unregister cleanly. Two fields because
  // the type differs by API level — only one is non-null at any time.
  private var legacyListener: PhoneStateListener? = null
  private var modernCallback: TelephonyCallback?  = null

  // Required for NativeEventEmitter on JS side. Returning these empty stubs
  // prevents the warning "new NativeEventEmitter() was called with a non-null
  // argument without the required addListener method".
  @ReactMethod fun addListener(eventName: String) { /* no-op */ }
  @ReactMethod fun removeListeners(count: Int)    { /* no-op */ }

  /**
   * Begin listening to telephony state changes.
   * Idempotent — calling start() twice is safe (second call is ignored).
   * Gracefully no-ops if READ_PHONE_STATE permission is not granted.
   */
  @ReactMethod
  fun start() {
    if (legacyListener != null || modernCallback != null) return  // already running

    if (!hasPhoneStatePermission()) {
      // Permission not granted — emit one event so JS knows we're disabled.
      // JS treats absence of further events as "permanently idle", which is
      // the correct fallback (idle detection just runs as before).
      emit("idle", System.currentTimeMillis())
      return
    }

    val tm = reactContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      ?: return

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      registerModernCallback(tm)
    } else {
      registerLegacyListener(tm)
    }

    // Emit current state on registration so JS doesn't have to wait for the
    // first transition before knowing the initial state.
    emit(stateToString(tm.callState), System.currentTimeMillis())
  }

  /** Stop listening. Safe to call multiple times. */
  @ReactMethod
  fun stop() {
    val tm = reactContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      modernCallback?.let { tm?.unregisterTelephonyCallback(it) }
      modernCallback = null
    } else {
      @Suppress("DEPRECATION")
      legacyListener?.let { tm?.listen(it, PhoneStateListener.LISTEN_NONE) }
      legacyListener = null
    }
  }

  /**
   * Synchronous getter — returns the current call state without waiting for
   * an event. Used by JS at startup to seed local state before any events
   * have fired. Returns "idle" if permission missing or telephony unavailable.
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getCurrentState(): String {
    if (!hasPhoneStatePermission()) return "idle"
    val tm = reactContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      ?: return "idle"
    return stateToString(tm.callState)
  }

  // ── API 31+ implementation ────────────────────────────────────────────────
  // TelephonyCallback is the modern, non-deprecated replacement for
  // PhoneStateListener. It requires an Executor for delivery — we use the
  // main looper executor since callbacks are extremely infrequent (one per
  // call state change) and the work in onCallStateChanged is just an event
  // emit (microseconds).
  private fun registerModernCallback(tm: TelephonyManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return  // for compiler

    val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
      override fun onCallStateChanged(state: Int) {
        emit(stateToString(state), System.currentTimeMillis())
      }
    }
    val executor: Executor = reactContext.mainExecutor  // Available API 28+
    tm.registerTelephonyCallback(executor, cb)
    modernCallback = cb
  }

  // ── API 24-30 implementation ──────────────────────────────────────────────
  // PhoneStateListener is deprecated as of API 31 but is the only available
  // mechanism on those versions. The deprecation warning is suppressed — we
  // explicitly route to TelephonyCallback when available.
  @Suppress("DEPRECATION")
  private fun registerLegacyListener(tm: TelephonyManager) {
    val listener = object : PhoneStateListener() {
      override fun onCallStateChanged(state: Int, phoneNumber: String?) {
        emit(stateToString(state), System.currentTimeMillis())
      }
    }
    tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
    legacyListener = listener
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private fun stateToString(state: Int): String = when (state) {
    TelephonyManager.CALL_STATE_RINGING -> "ringing"
    TelephonyManager.CALL_STATE_OFFHOOK -> "offhook"
    else                                -> "idle"
  }

  private fun hasPhoneStatePermission(): Boolean =
    ContextCompat.checkSelfPermission(reactContext, Manifest.permission.READ_PHONE_STATE) ==
      PackageManager.PERMISSION_GRANTED

  private fun emit(state: String, timestamp: Long) {
    val params: WritableMap = Arguments.createMap().apply {
      putString("state", state)
      putDouble("timestamp", timestamp.toDouble())  // JS number = double
    }
    // hasActiveCatalystInstance() returns false during teardown — guard against
    // emitting events into a dead bridge, which would crash on some RN versions.
    if (reactContext.hasActiveCatalystInstance()) {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("CallStateChanged", params)
    }
  }

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    stop()  // ensure we don't leak a system-level telephony listener
  }
}
