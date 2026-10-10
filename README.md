# VoiceChannelPanel

A [Vencord](https://vencord.dev) userplugin that puts a small floating panel above Discord's
bottom-left user area, showing **who is in the voice channel you are connected to right now** —
plus a running log of who joined and who left, with the time.

Built for the case where you sit in a call with friends but keep another server open: someone
quietly drops out and you would otherwise have to switch servers to find out who.

## What it shows

- The channel name and how many people are in it, in the panel header.
- One row per member: avatar, nickname (falling back to global name, then username), and badges
  for self/server mute, self/server deafen, streaming, and camera.
- A log under the list: `bobby left - 14:32`, `Carol joined - 14:35`, newest first.
- Nothing at all when you are not connected to a voice channel.

## Important: it follows *this* client only

The panel reads the voice session of the machine it is installed on
(`SelectedChannelStore.getVoiceChannelId()`). Being in a call on another device with the same
account does **not** show up here, and the panel stays hidden on a client that is not itself in a
voice channel. One client, one call, nothing else.

## Requirements

Vencord built from source. A normal Vencord install cannot load userplugins.

- git, Node.js 22+, pnpm
- Your own Vencord checkout (`git clone https://github.com/Vendicated/Vencord`)

## Install

```bash
git clone https://github.com/AkashAppari/vencord-voice-panel Vencord/src/userplugins/voiceChannelPanel
cd Vencord
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

Then restart Discord and enable **VoiceChannelPanel** in Settings → Vencord → Plugins.
After any change to the plugin, re-run `pnpm build` and restart Discord.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `offsetLeft` | `76` | Distance from the left edge of the window, in pixels |
| `offsetBottom` | `120` | Distance from the bottom edge, in pixels |
| `width` | `220` | Width of the panel, in pixels |
| `logSize` | `8` | How many join and leave entries to keep |
| `showJoins` | `true` | Log when someone joins as well as leaves |
| `showLog` | `true` | Show the log under the member list |

## Moving it

Drag the panel by its header. The position is written back to the settings, so it survives a
restart, and it is clamped to the viewport so you cannot lose it off-screen.

The default `offsetBottom` of 120px clears both Discord's account panel and the voice-status box
that sits above it while you are connected. If your layout differs (compact mode, a theme), drag it
where you want it.

## How it works, and what it does not touch

- **No patches.** The plugin declares no `patches` at all, so it never rewrites Discord's own code.
  It mounts one `position: fixed` div into the document body and renders React into it, and it reads
  voice state from `VoiceStateStore`, user data from `UserStore`, nicknames from `GuildMemberStore`,
  and join/leave events from the `VOICE_STATE_UPDATES` flux event.
- Because it patches nothing, Discord updates will not break it the way a patch-based plugin breaks;
  only a rename inside Discord's stores would.
- Clicking anywhere outside the panel behaves normally; the panel only occupies its own card.

## Tests

`test/` renders the plugin in Node with the Vencord modules stubbed, against a real DOM, and drives
real voice-state events through it — member list, nickname fallback, mute badge, leave/join log
text and ordering, your own transitions being ignored, dragging and its clamping, and the panel
disappearing when you disconnect.

```bash
cd test
pnpm install
node harness.mjs
```

It is a stubbed harness, not a Discord client: it proves the plugin's own logic and rendering, not
that Discord's live stores match these stubs.

## Licence

GPL-3.0-or-later, matching Vencord. Not affiliated with or endorsed by Discord Inc.
