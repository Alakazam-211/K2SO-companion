// FCM entry points. DORMANT-SAFE: this service is manifest-registered
// but FCM never binds it unless a default FirebaseApp exists — which
// requires google-services.json + the google-services gradle plugin
// (activation steps, docs/push-activation.md). Until then this class is
// dead code that merely has to compile (hence the firebase-messaging
// dependency staying in build.gradle.kts).

package com.alakazamlabs.k2so.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

private const val CHANNEL_ID = "k2-push"

class K2FirebaseMessagingService : FirebaseMessagingService() {
  /** Vendor token rotation → JS re-runs register-device (the daemon
   *  upserts by deviceId, so rotation is absorbed). */
  override fun onNewToken(token: String) {
    K2PushPlugin.notifyTokenRefresh(token)
  }

  /** Background notification-messages are tray-rendered by the system
   *  (tap → launcher intent with the data extras, handled by the
   *  plugin). This callback fires for FOREGROUND deliveries — render a
   *  local notification so the push isn't silently dropped. */
  override fun onMessageReceived(message: RemoteMessage) {
    val notification = message.notification ?: return
    try {
      val manager = NotificationManagerCompat.from(this)
      if (!manager.areNotificationsEnabled()) return
      ensureChannel()

      // Content intent mirrors the tray path: launcher activity + data
      // extras, so one tapFromIntent() handles both.
      val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
      launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
      for ((key, value) in message.data) launch.putExtra(key, value)
      val contentIntent = PendingIntent.getActivity(
        this,
        (System.currentTimeMillis() and 0x7fffffff).toInt(),
        launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )

      val built = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(applicationInfo.icon)
        .setContentTitle(notification.title ?: "K2")
        .setContentText(notification.body ?: "")
        .setAutoCancel(true)
        .setContentIntent(contentIntent)
        .build()
      manager.notify((System.currentTimeMillis() and 0x7fffffff).toInt(), built)
    } catch (_: Throwable) {
      // Display is best-effort; never crash the process for a push.
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "K2 notifications", NotificationManager.IMPORTANCE_DEFAULT)
    )
  }
}
