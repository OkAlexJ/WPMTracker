# WPMTracker

A [BetterDiscord](https://betterdiscord.app) plugin that estimates how fast people type — words per minute and how many seconds a message took — and shows it right on their messages.

## Features

- **Badge on every tracked message** showing `WPM`, `seconds`, or `WPM · seconds`. Click a badge to cycle between them.
- **Typing time vs. total time** — for your own messages, choose whether seconds means time spent actually typing (pauses excluded) or total time until you hit send.
- **Live counter** above the message box while you type.
- **Color-coded badges** by speed (40 / 70 / 100+ WPM).
- **Per-user stats** — average, best, last WPM and average time, searchable and sortable.
- **Paste detection** — pasted or autocompleted messages don't skew your stats.
- Badges persist across restarts.

## Install

1. Download [`WPMTracker.plugin.js`](WPMTracker.plugin.js).
2. Drop it in your BetterDiscord plugins folder (Settings → Plugins → Open Plugins Folder).
3. Enable it in Settings → Plugins.

## How accurate is it?

- **You:** accurate. The plugin sees your real keystrokes.
- **Everyone else:** an estimate. Discord only sends a "started typing" signal (repeated every ~10s), so time is measured from when they started typing to when the message arrives. Messages that were sitting as drafts, or are implausibly fast (>250 WPM by default), are discarded.

WPM uses the standard 5 characters = 1 word by default; you can switch to counting actual words in settings.
