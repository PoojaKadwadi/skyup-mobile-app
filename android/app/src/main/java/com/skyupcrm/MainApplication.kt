package com.skyupcrm

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.soloader.SoLoader

// PIECE 1 ADDITION: import the custom telephony package so we can register it
// alongside the autolinked packages from PackageList.
import com.skyupcrm.calldetect.CallStatePackage
import com.skyupcrm.contacts.ContactsPackage

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this@MainApplication) {

        // PIECE 1 CHANGE: was a one-liner returning PackageList(...).getPackages().
        // Now we append our custom CallStatePackage to the autolinked list. This
        // is the standard pattern for adding native modules that aren't in
        // node_modules. Existing autolinked packages (notifee, vector-icons,
        // call-log, etc.) are not affected.
        override fun getPackages(): List<ReactPackage> {
          val packages = PackageList(this@MainApplication).packages
          packages.add(CallStatePackage())
          packages.add(ContactsPackage())
          return packages
        }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, false)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      load()
    }
  }
}