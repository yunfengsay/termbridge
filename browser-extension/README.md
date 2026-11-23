# TermBridge Chrome extension

One Manifest V3 extension is shared by the macOS and Windows apps. The installer includes the extension files and registers a per-user Native Messaging host. The browser connects over framed stdio to a token-authenticated local Unix socket / Windows named pipe. There is no HTTP listener and no direct Relay connection in the extension.

## Install and use

- Windows installer registers the bundled `tb.exe` as `com.termbridge.browser`. Settings provides registration, extension directory and connection status.
- macOS app bundles `Resources/Browser`. Once its CLI runtime is available, it registers the Native Messaging component. Settings → Chrome can repeat registration and inspect the connection.
- The extension is **not yet published to Chrome Web Store**. For development, load the extension directory shown in settings through `chrome://extensions` → Developer mode → Load unpacked. Production installation still requires a Store listing and user confirmation; app installation does not silently enable the extension.
- Click the extension and enable browser assistance. Chrome asks for site access. Turning assistance off rejects pending responses and subsequent commands; closing Chrome also disconnects the native host.

```sh
tb browser install
tb browser status
tb browser call tabs
tb browser call read '{"tabId":123}'
tb browser call type '{"tabId":123,"selector":"#name","text":"中文"}'
tb browser call click '{"tabId":123,"selector":"#submit"}'
tb browser call screenshot '{"tabId":123}'
tb browser call open '{"url":"https://example.com"}'
```

The source CLI includes these commands, and the Windows bundled `tb.exe` handles them directly. Previously published npm CLI versions do not gain this command until a CLI release; the macOS app uses its bundled browser component independently.

`read` returns bounded visible text and selectors for interactive elements. Password field values are not returned. Only HTTP/HTTPS tabs can be operated on; arbitrary JavaScript, browser settings pages and local files are not exposed. Screenshot requires the target tab to be active. Chrome's screenshot API requires `<all_urls>` permission; the executable operation allowlist still rejects non-HTTP(S) pages.

A paired Agent can use the existing peer exec envelope with an exact argv of `tb browser status` or `tb browser call <operation> [JSON]`. Windows accepts only that bounded browser command, independently of general desktop assistance; the extension must be enabled. The macOS app additionally requires its Peer connection to be enabled. Other shell commands retain their existing separate authorization. No new wire message types are introduced.

## Verification

```sh
node --test browser-extension/tests/native.test.mjs
node browser-extension/tests/chrome-e2e.mjs
```

The latter launches a fresh, isolated real Chrome profile and tests Native Messaging, permission gating, tabs, read, Chinese input, click, screenshot and revocation. Its **test-only manifest** grants the same site permission at install time because headless Chrome cannot accept the native permission prompt. It does not validate Chrome Web Store distribution or the production first-install consent UI.
