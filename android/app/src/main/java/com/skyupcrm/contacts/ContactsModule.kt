package com.skyupcrm.contacts

import android.Manifest
import android.content.ContentProviderOperation
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * ContactsModule — silently inserts a contact into the device address book.
 *
 * WHY THIS EXISTS:
 *   The previous "Save to Contacts" used an ACTION_INSERT intent via
 *   Linking.openURL, which only OPENED the New Contact screen pre-filled — the
 *   user still had to tap Save manually, and many reported it "not saving".
 *   react-native-contacts is not installed. This tiny native module writes the
 *   contact directly through the ContentResolver, so the save is automatic.
 *
 * PERMISSION:
 *   Requires WRITE_CONTACTS (and READ_CONTACTS, which the JS layer requests
 *   together). If the permission is missing the promise rejects with
 *   "PERMISSION_DENIED" so JS can prompt / route to Settings.
 *
 * RESULT:
 *   Resolves with the created raw-contact name on success; rejects with a
 *   descriptive code otherwise. No UI is shown.
 */
class ContactsModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ContactsModule"

  private fun hasWritePermission(): Boolean =
    ContextCompat.checkSelfPermission(reactContext, Manifest.permission.WRITE_CONTACTS) ==
      PackageManager.PERMISSION_GRANTED

  /**
   * Insert a contact. Returns the display name on success.
   *
   * @param name    contact display name (e.g. "John 4567")
   * @param phone   phone number (stored as MOBILE)
   * @param email   optional email ("" to skip)
   * @param company optional company/org ("" to skip)
   */
  @ReactMethod
  fun saveContact(name: String, phone: String, email: String?, company: String?, promise: Promise) {
    try {
      if (!hasWritePermission()) {
        promise.reject("PERMISSION_DENIED", "WRITE_CONTACTS permission not granted")
        return
      }

      val ops = ArrayList<ContentProviderOperation>()

      // Index 0 — the raw contact row everything else attaches to.
      ops.add(
        ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
          .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
          .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
          .build()
      )

      // Display name
      ops.add(
        ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
          .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
          .withValue(ContactsContract.Data.MIMETYPE,
            ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
          .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
          .build()
      )

      // Phone (mobile)
      if (!phone.isNullOrBlank()) {
        ops.add(
          ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE,
              ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
            .withValue(ContactsContract.CommonDataKinds.Phone.TYPE,
              ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
            .build()
        )
      }

      // Email (optional)
      if (!email.isNullOrBlank()) {
        ops.add(
          ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE,
              ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
            .withValue(ContactsContract.CommonDataKinds.Email.TYPE,
              ContactsContract.CommonDataKinds.Email.TYPE_WORK)
            .build()
        )
      }

      // Company / organization (optional)
      if (!company.isNullOrBlank()) {
        ops.add(
          ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(ContactsContract.Data.MIMETYPE,
              ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE)
            .withValue(ContactsContract.CommonDataKinds.Organization.COMPANY, company)
            .withValue(ContactsContract.CommonDataKinds.Organization.TYPE,
              ContactsContract.CommonDataKinds.Organization.TYPE_WORK)
            .build()
        )
      }

      reactContext.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
      promise.resolve(name)
    } catch (e: Exception) {
      promise.reject("SAVE_FAILED", e.message ?: "Failed to save contact", e)
    }
  }
}