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
import java.util.concurrent.Executors

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
 * ─────────────────────────────────────────────────────────────────────────────
 * ANR FIX ("SkyUp CRM isn't responding"):
 *   PREVIOUS BUG: saveContact() ran AccountManager.getAccountsByType() and a
 *   multi-operation contentResolver.applyBatch() DIRECTLY on the React Native
 *   bridge's native-modules queue. Both are synchronous, blocking IPC calls
 *   into the system ContactProvider / AccountManager. A single applyBatch into
 *   a Google-account-backed provider can take 1–5 seconds, and when leads are
 *   saved in quick succession (auto-save on the lead/report screen) these
 *   calls serialized and held the queue long enough to freeze the UI →
 *   the not-responding dialog.
 *
 *   FIX: All blocking work (permission/account lookup + applyBatch) now runs on
 *   a dedicated single-thread background executor. The @ReactMethod returns
 *   immediately; the Promise is resolved/rejected from the worker thread.
 *   Promise resolution is thread-safe and the result is marshalled back to JS
 *   internally. No behaviour or reject-code changes — only the thread it runs on.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ACCOUNT RULES (unchanged):
 *   • accountEmail empty/blank  → reject NO_ACCOUNT_CONFIGURED.
 *   • accountEmail not a Google acct signed in on device → reject ACCOUNT_NOT_ON_DEVICE.
 *   • accountEmail matches a signed-in Google account → insert into it.
 *
 * PERMISSIONS:
 *   WRITE_CONTACTS + READ_CONTACTS for the insert; GET_ACCOUNTS to enumerate
 *   device Google accounts.
 */
class ContactsModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ContactsModule"

  // ── ANR FIX: single background worker for all blocking provider IPC ──────────
  // Single-thread so concurrent saveContact calls serialize off the UI/bridge
  // thread (correct for provider writes) without ever blocking the JS thread.
  private val worker = Executors.newSingleThreadExecutor()

  private fun hasPermission(perm: String): Boolean =
    ContextCompat.checkSelfPermission(reactContext, perm) == PackageManager.PERMISSION_GRANTED

  private fun hasWritePermission(): Boolean =
    hasPermission(Manifest.permission.WRITE_CONTACTS)

  /**
   * Returns the device's signed-in Google account name (email) that matches
   * `wanted` case-insensitively, or null if none is signed in.
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
    phone: String?,
    email: String?,
    company: String?,
    accountEmail: String?,
    promise: Promise
  ) {
    // ANR FIX: hop the entire blocking body onto the background worker.
    worker.execute {
      try {
        if (!hasWritePermission()) {
          promise.reject("PERMISSION_DENIED", "WRITE_CONTACTS permission not granted")
          return@execute
        }

        // 1. An account must be configured.
        val wanted = accountEmail?.trim().orEmpty()
        if (wanted.isEmpty()) {
          promise.reject("NO_ACCOUNT_CONFIGURED", "No contacts account configured for this user")
          return@execute
        }

        // 2. That account must be a Google account signed in on this device.
        val matchedAccount = findGoogleAccount(wanted)
        if (matchedAccount == null) {
          promise.reject(
            "ACCOUNT_NOT_ON_DEVICE",
            "Configured account ($wanted) is not signed in on this device"
          )
          return@execute
        }

        val ops = ArrayList<ContentProviderOperation>()

        // Index 0 — the raw contact row, bound to the matched Google account.
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

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    try { worker.shutdown() } catch (_: Exception) {}
  }
}