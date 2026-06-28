package com.skyupcrm

import android.os.Bundle
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "SkyUpCRMTemp"

  // ── Block screenshots & screen recording across the entire app ──────────────
  // FLAG_SECURE tells Android to treat every screen in this activity as secure:
  //   • screenshots and screen recordings are blocked (the OS shows a black
  //     frame / "can't take screenshot" message),
  //   • the app's preview in the recent-apps switcher is hidden,
  //   • casting/mirroring the screen shows black.
  // This protects customer data (masked numbers, contact details) from being
  // captured and shared. Set once in onCreate so it applies app-wide and stays
  // on for the whole session.
  override fun onCreate(savedInstanceState: Bundle?) {
    window.setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE
    )
    super.onCreate(savedInstanceState)
  }

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}