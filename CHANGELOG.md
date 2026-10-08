# Changelog

All notable changes to Cache Maxxer are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Dollar figures follow Anthropic's own price table, read when Claude Code starts and at most once a day, so every current Claude model and any new one is priced without an update. Haiku 5.5 is priced at the rate for each request's prompt size. The `live_prices` setting turns the read off, and a page that does not read cleanly never replaces the last good table.

### Added

- An MIT licence, a security policy that points to private vulnerability reporting, and licence, homepage, repository and keyword fields in the plugin manifest.
- A README for first-time readers: the Desktop and terminal install routes, screenshots of the band closed, open and with keep warm on, settings, what the plugin reads and sends, updating, removing and troubleshooting.

### Changed

- Everything is in the band above the input box: the Details pane is gone. The band is one line by default, the countdown, the cache length, the last request's hit rate and three buttons, and More opens the session's numbers, the recent requests and the latest break under it, in place; Less closes it, and the choice is remembered for new sessions. `/cache-maxxer` opens it and `/cache-maxxer less` closes it.
- The band draws in your Claude Code theme's colors instead of fixed ones.
- While keep warm is on, the band shows its choices and pings in a row of their own, whether the detail is open or not. The choices are buttons that end in an arrow, such as "Ping: automatically before expiry ▾"; clicking one lists its options as buttons in the same row, and Cancel closes them.
- The band reflows to its width instead of cutting anything: the buttons move to their own line where they do not fit beside the status, wordings shorten, and in a narrow terminal each label moves above its values. No piece is ever left out.
- The band's buttons have keys while it has the focus: K for keep warm, W for warm now, C for compact and M for the detail.
- The slash command is `/cache-maxxer`, in place of `/cache`: `/cache-maxxer`, `/cache-maxxer less`, `/cache-maxxer warm` and `/cache-maxxer keep on|off`.
- Warm now and the keep-warm notices say in plain words that a background request read N tokens from the cache and the timer restarted, or that it found the cache expired and rebuilt it. The ping count says the same, and dollar figures under a cent read "under $0.01".
- The cache length setting's description and the README say where the length comes from: your `ttl` setting, the newest cache write in the session transcript, or the length Claude Code reports on a model switch, with an hour assumed until one is seen.

### Fixed

- With `ttl` on auto, the band showed the cache length as assumed for the whole session when the transcript did not yet hold the first write as the turn ended, or the first look came within 15 seconds of the session starting. It now looks again every 15 seconds until it has seen the write.
- The README says the plugin reads at most the last 256 KiB of the session transcript, which is the whole file when the transcript is shorter than that.
- The README lists the Compact request among the things that reach the model.
