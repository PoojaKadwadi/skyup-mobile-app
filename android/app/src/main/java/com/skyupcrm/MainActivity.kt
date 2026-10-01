package com.skyupcrm

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * CRASH FIX (some devices only):
   * react-native-screens REQUIRES super.onCreate(null). Without it, whenever
   * Android recreates the Activity from saved state, the app crashes with:
   *   IllegalStateException: Screen fragments should never be restored.
   * This happens on low-RAM / aggressive OEM phones (Xiaomi, Realme, Oppo,
   * Vivo, Samsung M/A series) when the OS kills the app in the background —
   * e.g. while the user is in Settings granting a permission on first launch —
   * and also on font-size / display-size changes and foldable unfold.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "SkyUpCRMTemp"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
