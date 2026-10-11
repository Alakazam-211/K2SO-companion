package com.alakazamlabs.k2so.companion

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // Bottom system-bar inset in CSS px. Android's WebView reports
  // env(safe-area-inset-bottom) as 0 while we draw edge-to-edge, so the
  // web side reads the real value from here (main.tsx → --safe-bottom).
  @Volatile private var safeBottomCss = 0f

  // Back goes to the web layer first (our callback below), not straight
  // to WebView history: Zen's sheets and thread aren't history entries.
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    // The app is dark everywhere: light status/nav icons over transparent
    // bars. The default (auto) follows the system theme, which put dark
    // icons on our black header and a light scrim under 3-button nav.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // System Back: the topmost open Zen layer closes first (window.__k2Back,
    // src/lib/androidBack.ts); otherwise router history; otherwise exit.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("window.__k2Back ? window.__k2Back() : false") { handled ->
          if (handled == "true") return@evaluateJavascript
          if (webView.canGoBack()) {
            webView.goBack()
          } else {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    })

    webView.addJavascriptInterface(object {
      @JavascriptInterface fun safeBottom(): Float = safeBottomCss
    }, "K2Insets")

    // Listen on the content parent, not the WebView: a listener on the
    // WebView replaces its own inset handling and env(safe-area-inset-top)
    // drops to 0. The parent still dispatches the insets on to it.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      // A docked keyboard covers the nav bar, so the inset is 0 while it's
      // up. Compare heights, not ime visibility: a floating keyboard or
      // toolbar counts as visible but leaves the bar exposed.
      val navPx = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      val imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val bottomPx = if (imePx > navPx) 0 else navPx
      val css = bottomPx / v.resources.displayMetrics.density
      if (css != safeBottomCss) {
        safeBottomCss = css
        // Live updates (rotation, nav-mode change); the initial value is
        // pulled through K2Insets on boot in case this fires before load.
        webView.post {
          webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('k2-insets',{detail:{bottom:$css}}))", null
          )
        }
      }
      ViewCompat.onApplyWindowInsets(v, insets)
    }
    ViewCompat.requestApplyInsets(content)
  }
}
