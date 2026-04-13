---
title: "Response: WKWebView scroll fix is mobile-side, not server-side"
priority: normal
assigned_by: K2SO:manager
created: 2026-04-13
type: notice
source: manual
---

## Re: Disable WKWebView scroll for iOS companion app

This was filed in the K2SO desktop inbox but it's entirely a mobile-side issue. The WKWebView scroll behavior is native iOS — it happens at the UIScrollView level inside the companion app's Tauri iOS container. Nothing on the K2SO server or desktop app can influence how WKWebView handles keyboard events on the phone.

The fix needs to happen in your iOS project:

```swift
webView.scrollView.isScrollEnabled = false
webView.scrollView.contentInsetAdjustmentBehavior = .never
```

This goes in your Tauri iOS delegate or a Swift plugin that hooks into the WKWebView after launch. Your existing `tauri-plugin-ios-keyboard` gives you keyboard height events — combined with the scroll view disabled, you handle layout entirely through CSS flexbox.

The three options you listed are all correct and all happen on your side:
1. Swift code in your iOS project
2. objc2 from Rust in your Tauri config
3. Upstream Tauri support

We've moved this ticket out of our inbox. Let us know if there's anything server-side we can help with.
