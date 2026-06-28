package com.skyupcrm.contacts

import android.Manifest
import android.accounts.AccountManager
import android.content.ContentProviderOperation
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * ContactsModule — silently inserts a contact into a SPECIFIC Google account
 * on the device.
 *
 * WHY THIS EXISTS:
 *   Leads are auto-saved as phone contacts. To make them sync to the right
 *   Gmail, the contact must be inserted into a Google account that is actually
 *   signed in on this device. The target account email is configured per
 *   employee in the CRM and passed in as `accountEmail`.
 *
 * ACCOUNT RULES (matches the JS/product decision):
 *   • accountEmail empty/blank        → reject NO_ACCOUNT_CONFIGURED.
 *       (JS alerts the agent to ask their admin to set it.)
 *   • accountEmail not a Google acct
 *     signed in on this device         → reject ACCOUNT_NOT_ON_DEVICE.
 *       (JS alerts the agent to add the account in Android settings.)
 *   • accountEmail matches a signed-in
 *     Google account                   → insert into that account → syncs to
 *                                         that Gmail.
 *
 * PERMISSIONS:
 *   WRITE_CONTACTS + READ_CONTACTS (requested by JS) for the insert.
 *   GET_ACCOUNTS to read which Google accounts are on the device.
 *
 * RESULT:
 *   Resolves with the created display name on success; rejects with a
 *   descriptive code otherwise. No UI is shown.
 */
class ContactsModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ContactsModule"

  private fun hasPermission(perm: String): Boolean =
    ContextCompat.checkSelfPermission(reactContext, perm) == PackageManager.PERMISSION_GRANTED

  private fun hasWritePermission(): Boolean =
    hasPermission(Manifest.permission.WRITE_CONTACTS)

  /**
   * Returns the device's signed-in Google account name (email) that matches
   * `wanted` case-insensitively, or null if none is signed in.
   *
   * Falls back gracefully: if GET_ACCOUNTS isn't granted we can't enumerate, so
   * we return null (treated as "not on device") rather than guessing.
   */
  private fun findGoogleAccount(wanted: String): String? {
    if (!hasPermission(Manifest.permission.GET_ACCOUNTS)) return null
    return try {
      val am = AccountManager.get(reactContext)
      val googleAccounts = am.getAccountsByType("com.google")
      googleAccounts
        .firstOrNull { it.name.equals(wanted, ignoreCase = true) }
        ?.name
    } catch (e: Exception) {
      null
    }
  }

  /**
   * Insert a contact into the employee's configured Google account.
   *
   * @param name         contact display name (e.g. "John 4567")
   * @param phone        phone number (stored as MOBILE)
   * @param email        optional email ("" to skip)
   * @param company      optional company/org ("" to skip)
   * @param accountEmail REQUIRED target Google account email. "" → rejects.
   */
  @ReactMethod
  fun saveContact(
    name: String,
    phone: String,
    email: String?,
    company: String?,
    accountEmail: String?,
    promise: Promise
  ) {
    try {
      if (!hasWritePermission()) {
        promise.reject("PERMISSION_DENIED", "WRITE_CONTACTS permission not granted")
        return
      }

      // 1. An account must be configured.
      val wanted = accountEmail?.trim().orEmpty()
      if (wanted.isEmpty()) {
        promise.reject("NO_ACCOUNT_CONFIGURED", "No contacts account configured for this user")
        return
      }

      // 2. That account must be a Google account signed in on this device.
      val matchedAccount = findGoogleAccount(wanted)
      if (matchedAccount == null) {
        promise.reject(
          "ACCOUNT_NOT_ON_DEVICE",
          "Configured account ($wanted) is not signed in on this device"
        )
        return
      }

      val ops = ArrayList<ContentProviderOperation>()

      // Index 0 — the raw contact row, bound to the matched Google account so
      // it syncs to that Gmail.
      ops.add(
        ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
          .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, "com.google")
          .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, matchedAccount)
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