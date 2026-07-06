// K2 Companion push plugin — Android half (Companion C6; feedback PRD §8.2).
//
// DORMANT-FIRST: the FCM SDK is a plain gradle dependency (NO
// google-services plugin, NO google-services.json in this slice), so all
// Firebase classes exist at compile time but the default FirebaseApp is
// never initialized. `isAvailable` therefore answers false via
// `FirebaseApp.getApps().isEmpty()` — and every Firebase touch is
// additionally wrapped in a catch-all so even a stripped/odd build
// degrades to "unavailable" instead of crashing.
//
// Taps: FCM notification-messages tapped from the system tray launch the
// main activity with the payload's data keys as intent extras. We read
// them from the launch intent in `load` (cold start → buffered for
// `getLaunchTap`) and from `onNewIntent` (warm tap → `tap` event).

package com.alakazamlabs.k2so.push

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

private const val PUSH_PERMISSION_ALIAS = "postNotifications"

/** Deep-link data keys the relay's content-free payload may carry. */
private val TAP_KEYS = listOf("kind", "feedbackId", "groupId", "subdomain")

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = PUSH_PERMISSION_ALIAS)
  ]
)
class K2PushPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    @Volatile private var instance: K2PushPlugin? = null
    @Volatile private var pendingTap: JSObject? = null

    /** Called by K2FirebaseMessagingService.onNewToken (only ever fires
     *  once Firebase is live, i.e. post-activation). */
    fun notifyTokenRefresh(token: String) {
      val plugin = instance ?: return
      try {
        val data = JSObject()
        data.put("token", token)
        data.put("platform", "fcm")
        plugin.trigger("tokenRefresh", data)
      } catch (_: Throwable) {
        // JS not listening yet — the next app launch re-registers anyway.
      }
    }

    /** Called by K2FirebaseMessagingService for foreground-delivered
     *  taps routed through the local-notification content intent. */
    fun notifyTap(tap: JSObject) {
      pendingTap = tap
      try {
        instance?.trigger("tap", tap)
      } catch (_: Throwable) {}
    }
  }

  override fun load(webView: WebView) {
    instance = this
    // Cold-start tap: the tray notification's content intent launched the
    // activity with the data keys as extras. Buffer for getLaunchTap().
    tapFromIntent(activity.intent)?.let { pendingTap = it }
  }

  override fun onNewIntent(intent: Intent) {
    val tap = tapFromIntent(intent) ?: return
    pendingTap = tap
    try {
      trigger("tap", tap)
    } catch (_: Throwable) {}
  }

  // ── Commands ─────────────────────────────────────────────────────────

  @Command
  fun isAvailable(invoke: Invoke) {
    val (available, reason) = firebaseAvailability()
    val res = JSObject()
    res.put("available", available)
    res.put("platform", "android")
    if (reason != null) res.put("reason", reason)
    invoke.resolve(res)
  }

  @Command
  fun requestPermission(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      // Pre-13 there is no runtime permission — report the notification
      // toggle state instead.
      resolveGranted(invoke, NotificationManagerCompat.from(activity).areNotificationsEnabled())
      return
    }
    if (getPermissionState(PUSH_PERMISSION_ALIAS) == PermissionState.GRANTED) {
      resolveGranted(invoke, true)
      return
    }
    requestPermissionForAlias(PUSH_PERMISSION_ALIAS, invoke, "pushPermissionCallback")
  }

  @PermissionCallback
  fun pushPermissionCallback(invoke: Invoke) {
    resolveGranted(invoke, getPermissionState(PUSH_PERMISSION_ALIAS) == PermissionState.GRANTED)
  }

  @Command
  fun getToken(invoke: Invoke) {
    val (available, reason) = firebaseAvailability()
    if (!available) {
      invoke.reject(reason ?: "Firebase unavailable")
      return
    }
    try {
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        if (task.isSuccessful && task.result != null) {
          val res = JSObject()
          res.put("token", task.result)
          res.put("platform", "fcm")
          invoke.resolve(res)
        } else {
          invoke.reject("FCM token fetch failed: ${task.exception?.message ?: "unknown"}")
        }
      }
    } catch (t: Throwable) {
      invoke.reject("FCM token fetch failed: ${t.message}")
    }
  }

  @Command
  fun getLaunchTap(invoke: Invoke) {
    val tap = pendingTap
    pendingTap = null
    val res = JSObject()
    res.put("tap", tap ?: JSONObject.NULL)
    invoke.resolve(res)
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** The dormancy gate: no initialized default FirebaseApp (no
   *  google-services.json / gradle plugin yet) → unavailable. The
   *  catch-all keeps even a Firebase-stripped build crash-free. */
  private fun firebaseAvailability(): Pair<Boolean, String?> {
    return try {
      if (FirebaseApp.getApps(activity).isEmpty()) {
        false to "Firebase not configured (google-services.json absent — see docs/push-activation.md)"
      } else {
        true to null
      }
    } catch (t: Throwable) {
      false to "Firebase classes unavailable: ${t.message}"
    }
  }

  private fun resolveGranted(invoke: Invoke, granted: Boolean) {
    val res = JSObject()
    res.put("granted", granted)
    invoke.resolve(res)
  }

  private fun tapFromIntent(intent: Intent?): JSObject? {
    val extras = intent?.extras ?: return null
    if (!extras.containsKey("kind")) return null
    val tap = JSObject()
    for (key in TAP_KEYS) {
      extras.getString(key)?.let { tap.put(key, it) }
    }
    return tap
  }
}
