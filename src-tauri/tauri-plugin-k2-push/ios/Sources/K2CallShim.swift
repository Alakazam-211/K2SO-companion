// The system side of a voice-room call (gap list §6, Rosson 2026-11-03):
// CallKit shows the call (status-bar pill, Dynamic Island, Lock Screen) and
// owns the audio session; its buttons come back here as actions.
//
// Rooms only for now (Rosson 2026-11-04): joining from the app is an
// OUTGOING CallKit call. Ringing (PushKit, incoming calls) comes later and
// would add `reportNewIncomingCall` beside `start`.
//
// The engine's state is the truth. This file never decides a call's state on
// its own: it reports what it's told (`connecting`, `connected`,
// `reconnecting`, `ended`) and passes the system's requests (end, mute, hold)
// and the audio session's changes (activated, interruption, route) to
// `onEvent`, which reaches Rust (and the app's UI). An action is fulfilled at
// once: the engine answers with a state change, and a mute the engine
// refuses is put back with `setMuted`.
//
// Audio session: configured before the call starts and NEVER activated here.
// CallKit activates it and says so in `didActivate`; kessel-audio starts its
// VoiceProcessingIO unit only then (`start_when_session_active`).

import AVFoundation
import CallKit
import Foundation
import Network
import UIKit

// The app's minimum is iOS 15; the plugin package builds for 13.
@available(iOS 14.0, *)
public final class K2CallShim: NSObject {
  public static let shared = K2CallShim()

  /// `{"event": …}` for Rust and the UI. Set once by the plugin.
  public var onEvent: (([String: Any]) -> Void)?

  /// Video calls (Sew's native video): turn on when video ships. Until then
  /// the system shows every call as audio, whatever `report` says.
  static let videoCalls = false

  private var provider: CXProvider
  private var controller = CXCallController()
  private let queue = DispatchQueue(label: "k2.call-shim")
  /// The one call (rooms: never two at once).
  private var call: UUID?
  private var room = ""
  private var muted = false
  /// The call has video (the engine's `video_changed`), and its name as shown.
  private var video = false
  private var shown = ""
  /// The speaker is on because video turned it on (`autoSpeaker`), not by
  /// the person's choice. A route change ends it.
  private var autoSpeakerOn = false
  private var observers: [NSObjectProtocol] = []
  private var path: NWPathMonitor?
  /// The names the app gave the next call (`label`): the engine knows only ids.
  private var labels: (room: String, server: String)?

  override init() {
    provider = Self.makeProvider()
    super.init()
    provider.setDelegate(self, queue: queue)
  }

  private static func makeProvider() -> CXProvider {
    let config = CXProviderConfiguration()
    config.supportsVideo = Self.videoCalls
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    // A room call isn't a phone call: keep it out of the Phone app's Recents.
    config.includesCallsInRecents = false
    return CXProvider(configuration: config)
  }

  /// The system lost track of our provider (`unknownCallProvider`, seen after
  /// the app sat suspended for an hour): a fresh provider and controller.
  /// On `queue`, with no call up.
  private func renewProvider() {
    provider.invalidate()
    provider = Self.makeProvider()
    provider.setDelegate(self, queue: queue)
    controller = CXCallController()
  }

  // ── Engine → system ────────────────────────────────────────────────

  /// The room's and server's names for the next `start` (the app sets them
  /// just before it joins; the engine, which starts the call, has only ids).
  public func label(room: String, server: String) {
    queue.async { self.labels = (room, server) }
  }

  /// Joining a room: an outgoing call named for the room (the `label`, else
  /// `room` as given). Fails when a call is already up.
  public func start(room: String, server: String, completion: @escaping (String?) -> Void) {
    queue.async { self.start(room: room, server: server, retried: false, completion: completion) }
  }

  /// On `queue`. A start the system refuses with `unknownCallProvider` is
  /// tried once more on a fresh provider.
  private func start(room: String, server: String, retried: Bool, completion: @escaping (String?) -> Void) {
    do {
      guard self.call == nil else { return completion("call_in_progress") }
      let room = self.labels?.room ?? room
      let server = self.labels?.server ?? server
      do {
        try Self.configureSession()
      } catch {
        return completion("audio_session")
      }
      let id = UUID()
      self.call = id
      self.room = room
      self.shown = room
      self.muted = false
      self.video = false
      self.autoSpeakerOn = false
      let handle = CXHandle(type: .generic, value: server.isEmpty ? room : "\(room) · \(server)")
      let action = CXStartCallAction(call: id, handle: handle)
      action.contactIdentifier = room
      self.controller.request(CXTransaction(action: action)) { error in
        self.queue.async {
          if let error = error {
            if self.call == id { self.call = nil }
            let ns = error as NSError
            if !retried, ns.domain == CXErrorDomainRequestTransaction,
              ns.code == CXErrorCodeRequestTransactionError.Code.unknownCallProvider.rawValue
            {
              self.emit(["event": "provider_renewed"])
              self.renewProvider()
              return self.start(room: room, server: server, retried: true, completion: completion)
            }
            let code = "callkit: \(ns.code)"
            self.emit(["event": "start_failed", "error": code])
            completion(code)
          } else {
            completion(nil)
          }
        }
      }
    }
  }

  /// The engine's state. `reconnecting` keeps the call and says so in its
  /// name; `ended` takes it off the system UI. `video` with no state updates
  /// the call in place.
  public func report(state: String, reason: String? = nil, video: Bool? = nil) {
    queue.async {
      guard let id = self.call else { return }
      if let video = video, video != self.video {
        self.video = video
        if state.isEmpty { self.rename(self.shown) }
      }
      switch state {
      case "connecting":
        self.provider.reportOutgoingCall(with: id, startedConnectingAt: nil)
        self.rename(self.room)
      case "connected":
        self.provider.reportOutgoingCall(with: id, connectedAt: nil)
        self.rename(self.room)
      case "reconnecting":
        self.rename("\(self.room) · Reconnecting…")
      case "ended":
        self.call = nil
        self.labels = nil
        self.video = false
        self.autoSpeakerOn = false
        self.provider.reportCall(with: id, endedAt: nil, reason: Self.endReason(reason))
        self.stopObserving()
      default:
        break
      }
    }
  }

  /// A recording, or anything else worth showing in the call's name.
  public func setTitle(_ title: String) {
    queue.async { self.rename(title) }
  }

  /// Mute changed in the app or by the engine: the system's button follows.
  public func setMuted(_ on: Bool) {
    queue.async {
      guard let id = self.call, self.muted != on else { return }
      self.muted = on
      self.controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: on))) { _ in }
    }
  }

  /// The app left or the call failed before the engine said anything.
  public func end() {
    queue.async {
      guard let id = self.call else { return }
      self.controller.request(CXTransaction(action: CXEndCallAction(call: id))) { error in
        if error != nil { self.report(state: "ended", reason: "failed") }
      }
    }
  }

  public var active: Bool { queue.sync { call != nil } }

  private func rename(_ name: String) {
    guard let id = call else { return }
    let update = CXCallUpdate()
    update.localizedCallerName = name
    update.supportsHolding = true
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    update.hasVideo = Self.videoCalls && video
    shown = name
    provider.reportCall(with: id, updated: update)
  }

  // ── Audio session ──────────────────────────────────────────────────

  static func configureSession() throws {
    let s = AVAudioSession.sharedInstance()
    // Rooms are group calls: speaker by default, the person picks the route.
    // `.allowBluetoothHFP`: a headset's mic. A2DP has no mic, so it stays off.
    try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
  }

  /// The microphone permission, asking the first time: `granted` or
  /// `denied`. Asked before the call starts, so the prompt never lands in
  /// the middle of CallKit's (kessel-audio only reads it; a refusal still
  /// plays, and the person can listen).
  public static func microphone(_ completion: @escaping (String) -> Void) {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return completion("granted")
      case .denied: return completion("denied")
      default:
        AVAudioApplication.requestRecordPermission { completion($0 ? "granted" : "denied") }
      }
    } else {
      let s = AVAudioSession.sharedInstance()
      switch s.recordPermission {
      case .granted: return completion("granted")
      case .denied: return completion("denied")
      default: s.requestRecordPermission { completion($0 ? "granted" : "denied") }
      }
    }
  }

  /// Speaker on, or back to the default route (receiver, or a headset).
  public func setSpeaker(_ on: Bool) -> Bool {
    do {
      try AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
      // The person's choice now, not video's.
      queue.sync { autoSpeakerOn = false }
      return true
    } catch {
      return false
    }
  }

  /// Video turned the speaker on (Rust decides when: `speaker_for` in
  /// voice.rs), or off again: off undoes only an override made here.
  public func autoSpeaker(_ on: Bool) -> Bool {
    queue.sync {
      guard on || autoSpeakerOn else { return true }
      do {
        try AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
        autoSpeakerOn = on
        return true
      } catch {
        return false
      }
    }
  }

  /// The speaker is on because of video (see `autoSpeaker`).
  public var autoSpeakerActive: Bool { queue.sync { autoSpeakerOn } }

  /// Where audio goes now: `speaker`, `receiver`, `bluetooth`, `headphones`,
  /// `carplay`, `airplay`, or `other`.
  public static func currentRoute() -> String {
    guard let port = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType else { return "other" }
    switch port {
    case .builtInSpeaker: return "speaker"
    case .builtInReceiver: return "receiver"
    case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return "bluetooth"
    case .headphones, .usbAudio: return "headphones"
    case .carAudio: return "carplay"
    case .airPlay: return "airplay"
    default: return "other"
    }
  }

  private func observe() {
    stopObserving()
    watchNetwork()
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers.append(
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let reason = raw.flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
        // A category change is our own doing; the rest can change the rate.
        guard reason != .categoryChange else { return }
        let route = Self.currentRoute()
        // A new route (headphones in, the person's pick) drops the
        // system's override: video's speaker is gone with it.
        if route != "speaker" { self?.queue.async { self?.autoSpeakerOn = false } }
        self?.emit(["event": "route_changed", "route": route])
      })
    // Siri, an alarm, another app's audio. A cellular call comes as a hold.
    observers.append(
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        guard let kind = raw.flatMap({ AVAudioSession.InterruptionType(rawValue: $0) }) else { return }
        if kind == .began {
          self?.emit(["event": "suspend", "why": "interruption"])
        } else {
          let opts = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map {
            AVAudioSession.InterruptionOptions(rawValue: $0)
          }
          if opts?.contains(.shouldResume) == true { self?.emit(["event": "resume", "why": "interruption"]) }
        }
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) {
        [weak self] _ in
        // The audio server restarted: everything must be set up again.
        try? Self.configureSession()
        self?.queue.async { self?.autoSpeakerOn = false }
        self?.emit(["event": "media_reset"])
      })
    // The app left the screen or came back: the engine stops and restarts
    // video (no camera in the background). Not an audio interruption: the
    // call goes on.
    observers.append(
      center.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
        self?.emit(["event": "app_scene", "scene": "background"])
      })
    observers.append(
      center.addObserver(forName: UIScene.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
        self?.emit(["event": "app_scene", "scene": "foreground"])
      })
  }

  private func stopObserving() {
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers.removeAll()
    path?.cancel()
    path = nil
  }

  /// The network under the call: `network_changed` when the primary
  /// interface changes (Wi-Fi to cellular and back), so the engine moves
  /// the media at once instead of waiting out a dead path. Not the first
  /// answer, and not a change that keeps the interface (cost, constrained,
  /// DNS): each one would restart ICE for nothing.
  private func watchNetwork() {
    let monitor = NWPathMonitor()
    var last: String?
    monitor.pathUpdateHandler = { [weak self] p in
      guard p.status == .satisfied, let primary = p.availableInterfaces.first else { return }
      let now = "\(primary.type):\(primary.name)"
      defer { last = now }
      guard let before = last, before != now else { return }
      self?.emit(["event": "network_changed", "interface": "\(primary.type)"])
    }
    monitor.start(queue: queue)
    path = monitor
  }

  private func emit(_ event: [String: Any]) {
    var e = event
    if let id = call { e["call"] = id.uuidString }
    onEvent?(e)
  }

  static func endReason(_ reason: String?) -> CXCallEndedReason {
    switch reason {
    case nil, "left", "user": return .remoteEnded
    case "credential_lost", "elsewhere": return .answeredElsewhere
    default: return .failed
    }
  }
}

@available(iOS 14.0, *)
extension K2CallShim: CXProviderDelegate {
  public func providerDidReset(_ provider: CXProvider) {
    // CallKit dropped every call (rare: the call daemon restarted).
    guard call != nil else { return }
    call = nil
    stopObserving()
    emit(["event": "end_requested", "why": "reset"])
  }

  public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    observe()
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
    action.fulfill()
    emit(["event": "started"])
  }

  public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let mine = action.callUUID == call
    action.fulfill()
    guard mine else { return }
    // The engine leaves and then reports `ended`, which clears `call`.
    emit(["event": "end_requested", "why": "system"])
  }

  public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    action.fulfill()
    guard action.callUUID == call, action.isMuted != muted else { return }
    muted = action.isMuted
    emit(["event": "mute_requested", "muted": action.isMuted])
  }

  public func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    action.fulfill()
    guard action.callUUID == call else { return }
    // A cellular call put the room on hold, or took it back.
    emit(["event": action.isOnHold ? "suspend" : "resume", "why": "hold"])
  }

  public func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
    action.fail()
  }

  public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    emit(["event": "session_activated", "route": Self.currentRoute()])
  }

  public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    emit(["event": "session_deactivated"])
  }
}
