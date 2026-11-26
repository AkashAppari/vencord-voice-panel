# Desktop overlay

A separate transparent, always-on-top window that shows the same member list and join/leave log as
the in-Discord panel, so you can see who is talking while another app is in front. It does not hook
DirectX the way Discord's own overlay does — it is just a small WPF window that polls a file — so it
stays cheap and works over any windowed or borderless app.

## Requirements

- Windows, with Windows PowerShell 5.1 (built in; PowerShell 7 is not needed).
- The voiceChannelPanel plugin enabled with its `overlaySnapshot` setting on. The overlay reads the
  snapshot the plugin writes into Vencord's `settings.json`.

## Run

```
powershell -NoProfile -ExecutionPolicy Bypass -File overlay\overlay.ps1
```

Flags:

| Flag | Effect |
| --- | --- |
| `-Headless` | Print the parsed state to the console instead of opening a window — useful for checking the pipe from the plugin to the overlay |
| `-SnapshotFile <path>` | Draw a fixed test snapshot from a file instead of reading Vencord's settings |
| `-PollMs <n>` | How often to re-read the file, in milliseconds (default `400`) |

## Behaviour

- Hides itself when you are not in a call, and when the snapshot is older than 8 seconds (Discord
  was closed or killed).
- Drag it with the left mouse button.
- The tray icon is the only UI. Its menu has **Click-through (locked)**, which lets clicks pass
  through to the window underneath and stops dragging, **Reset position**, and **Exit**.
- Position, opacity and the other settings persist in `%APPDATA%\VoicePanelOverlay\config.json`.

## Finding settings.json

The overlay looks in two places and uses the first that exists:

- Source build: the checkout's `settings\settings.json` (it checks `C:\Users\<you>\Vencord\settings\settings.json`).
- Installer build: `%APPDATA%\Vencord\settings\settings.json`.

If yours is elsewhere, set `settingsPath` in `%APPDATA%\VoicePanelOverlay\config.json`. Run with
`-Headless` to see which file it picked and what it parsed.

## Start with Windows

Press Win+R, open `shell:startup`, and create a shortcut there with target:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\path\to\overlay\overlay.ps1
```

There is no main window to close it from — use the tray icon's **Exit**.
