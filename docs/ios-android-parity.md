# iOS/iPadOS and Android capability alignment

Source boundaries: `ios/Termbridge/`, `android/app/src/main/java/com/termbridge/android/`, shared `packages/desktop-ui/`, and `packages/protocol/`.

| Capability | iOS/iPadOS implementation | Remaining gap |
| --- | --- | --- |
| Multiple Host profiles, LAN TLS fingerprint trust, adding/editing connections | Native connection settings; server context menu opens the exact profile and reconnects | Device validation for multiple live endpoints |
| Session discovery, terminal input, native composer, copy/paste, reconnect | Implemented | Native photos/files/pasted-image attachment queue, bounded preparation and upload, explicit retry/remove; terminal and review reconnects pin their opening profile. Physical picker/upload acceptance pending |
| Agent chat, receipts, earlier history, terminal fallback | Shared renderer and native composer | Do not offer unsupported attachments/approvals as successful actions |
| Files, Git changes, branch comparison/switching | Implemented; Unicode highlighter progress fixed | Recheck the user's exact file on iPad |
| Remote desktop, source-coordinate gestures, viewport streaming, display selection, shortcuts | Shared viewer and native SwiftUI controls | Actual throughput depends on endpoint and Host |
| 10/20/30 FPS targets, default 10, remembered preference | Implemented in both clients | Native Host versions before capture-ceiling update remain capped at 12 FPS |
| Remember/forget remote desktop login | Keychain scoped to endpoint, Host, pairing secret and certificate; saved only after authenticated callback | Physical saved-login/rejection verification |
| Global text, history, delegated tasks | Implemented | Not equivalent to Android live voice/silent-call path |
| Global voice, voice enrollment, audio route and lifecycle | Android implementation only | Requires native iOS audio implementation and device acceptance |
| Reverse phone tools (calendar, reminders, photos, alarms, native app actions) | iOS currently explicitly rejects peer requests | Implement only supported platform APIs with accurate capability advertisement and consent |
| Android assistant role, APK installation, Android watch bridge | Android-specific implementations | Do not copy Android system contracts into iOS; determine native equivalents where available |

A compiled binary or successful sideload does not establish user interaction parity.
Real-device acceptance must separately cover navigation, file responsiveness, endpoint
selection, credential lifecycle, and media behavior. Never weaken authentication or
advertise unimplemented peer capabilities to make the platforms appear equivalent.
