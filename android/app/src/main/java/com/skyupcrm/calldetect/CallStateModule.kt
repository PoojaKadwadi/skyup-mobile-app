package com.skyupcrm.calldetect

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
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
 * ─────────────────────────────────────────────────────────────────────────────
 * ANR FIX ("SkyUp CRM isn't responding"):
 *   PREVIOUS BUGS that froze the UI:
 *     1. registerModernCallback() delivered TelephonyCallback events on
 *        reactContext.mainExecutor — i.e. the MAIN (UI) THREAD. Every call
 *        state transition ran onCallStateChanged + a bridge emit on the UI
 *        thread. On some OEMs the first registration callback also does a
 *        synchronous system query, and routing it onto the UI thread risked
 *        blocking a draw frame → ANR.
 *     2. getCurrentState() was isBlockingSynchronousMethod = true. It is
 *        called from JS at startup (callStateService.startCallStateListener)
 *        and synchronously blocked the JS thread on a TelephonyManager system
 *        call. Under contention (startup, while other native work was queued)
 *        this stalled long enough to trigger the not-responding dialog.
 *
 *   FIX:
 *     • Telephony callbacks are now delivered on a dedicated background
 *       HandlerThread executor — NEVER the UI thread. The emit hop to the JS
 *       thread is handled internally by DeviceEventManagerModule and is
 *       thread-safe from any thread.
 *     • getCurrentState() is no longer a blocking synchronous method. JS reads
 *       the initial state from the "CallStateChanged" event that start() emits
 *       on registration (callStateService already listens for it), so no
 *       synchronous bridge call is needed. getCurrentStateAsync() is provided
 *       as a Promise-based fallback that runs off the UI/JS thread.
 * ─────────────────────────────────────────────────────────────────────────────
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
 *
 * BATTERY:
 *   Telephony listeners are event-driven by the OS — they consume zero CPU
 *   when no call is active. There is NO polling, NO timer, NO wake lock.
 *   The single background HandlerThread is cheap (parked when idle) and is
 *   torn down on stop()/destroy.
 */
class CallStateModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CallStateModule"

  // Holds the active listener so we can unregister cleanly. Two fields because
  // the type differs by API level — only one is non-null at any time.
  private var legacyListener: PhoneStateListener? = null
  private var modernCallback: TelephonyCallback?  = null

  // ── ANR FIX: dedicated background thread for telephony callback delivery ──
  // We never want OS callbacks (or the bridge emit they trigger) running on
  // the UI thread. A single HandlerThread + executor is created lazily and
  // reused; it is quit on stop()/onCatalystInstanceDestroy().
  private var handlerThread: HandlerThread? = null
  private var bgExecutor: Executor? = null

  @Synchronized
  private fun backgroundExecutor(): Executor {
    var exec = bgExecutor
    if (exec == null) {
      val ht = HandlerThread("CallStateModule-bg").apply { start() }
      val handler = Handler(ht.looper)
      exec = Executor { command -> handler.post(command) }
      handlerThread = ht
      bgExecutor = exec
    }
    return exec
  }

  @Synchronized
  private fun shutdownBackgroundThread() {
    handlerThread?.quitSafely()
    handlerThread = null
    bgExecutor = null
  }

  // Required for NativeEventEmitter on JS side.
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

    // Emit current state on registration so JS gets the initial state without
    // any synchronous bridge call. This is the channel callStateService uses
    // to seed its local cache.
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
    shutdownBackgroundThread()
  }

  /**
   * ANR FIX: Async, Promise-based replacement for the old blocking
   * getCurrentState(). Runs the TelephonyManager query on the background
   * executor so it never blocks the JS thread. JS should normally rely on the
   * "CallStateChanged" event emitted by start() and only use this as a fallback.
   */
  @ReactMethod
  fun getCurrentStateAsync(promise: com.facebook.react.bridge.Promise) {
    backgroundExecutor().execute {
      try {
        if (!hasPhoneStatePermission()) { promise.resolve("idle"); return@execute }
        val tm = reactContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        promise.resolve(if (tm != null) stateToString(tm.callState) else "idle")
      } catch (e: Exception) {
        promise.resolve("idle")
      }
    }
  }

  // ── API 31+ implementation ────────────────────────────────────────────────
  // ANR FIX: deliver callbacks on the background executor, NOT mainExecutor.
  private fun registerModernCallback(tm: TelephonyManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return  // for compiler

    val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
      override fun onCallStateChanged(state: Int) {
        emit(stateToString(state), System.currentTimeMillis())
      }
    }
    tm.registerTelephonyCallback(backgroundExecutor(), cb)
    modernCallback = cb
  }

  // ── API 24-30 implementation ──────────────────────────────────────────────
  // PhoneStateListener delivers on the thread of the Looper it was created on.
  // Construct it on the background HandlerThread so callbacks never land on the
  // UI thread.
  @Suppress("DEPRECATION")
  private fun registerLegacyListener(tm: TelephonyManager) {
    val ht = (handlerThread ?: run { backgroundExecutor(); handlerThread!! })
    val handler = Handler(ht.looper)
    handler.post {
      val listener = object : PhoneStateListener() {
        override fun onCallStateChanged(state: Int, phoneNumber: String?) {
          emit(stateToString(state), System.currentTimeMillis())
        }
      }
      tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
      legacyListener = listener
    }
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
      putDouble("timestamp", timestamp.toDouble())
    }
    if (reactContext.hasActiveCatalystInstance()) {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("CallStateChanged", params)
    }
  }

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    stop()  // ensure we don't leak a system-level telephony listener or thread
  }
}