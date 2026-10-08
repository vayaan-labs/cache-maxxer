# Changelog

All notable changes to Cache Maxxer are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Dollar figures follow Anthropic's own price table, read when Claude Code starts and at most once a day, so every current Claude model and any new one is priced without an update. Haiku 5.5 is priced at the rate for each request's prompt size. The `live_prices` setting turns the read off, and a page that does not read cleanly never replaces the last good table.

### Added

- An MIT licence, a security policy that points to private vulnerability reporting, and licence, homepage, repository and keyword fields in the plugin manifest.
- A README for first-time readers, with an icon, the Desktop and terminal install routes, screenshots of the band in both apps, what it supports and what it reads and sends, and a guide (`docs/guide.md`) with the band in detail, keep warm, the command, settings, updating, removing and troubleshooting.

### Changed

- Everything is in the band above the input box: the Details pane is gone. The band is one line in a thin frame by default, the countdown with a solid bar, the cache length, the last request's and the session's hit rates to two decimals and three buttons, and More opens the session's numbers, a dot for each of the last 10 requests with any cache break marked, and the latest break above it, the first line staying at the bottom; Less closes it, and the choice is remembered for new sessions. `/cache-maxxer` opens it and `/cache-maxxer less` closes it.
- The band draws in your Claude Code theme's colors instead of fixed ones. In the Desktop app it is drawn for a window instead: a large countdown over a draining bar, a ring for each hit rate, the session's numbers as tiles, the last 10 requests as a row of marks, and the keep-warm choices as the app's own menus, in light and dark and framed like the input box; in a window too narrow for it the drawn rows shrink together rather than wrap. There Warm now reads Warming… until its ping comes back, and every notice appears in the band for a few seconds rather than at the window's corner; Hide tucks it away to a small chip with the countdown and a Show button, remembered for new sessions, and `/cache-maxxer hide` and `show` do the same.
- While keep warm is on, the band shows its choices in a row of their own, whether the detail is open or not, and the count of pings with the detail. The row sits above the first line, and its choices are buttons that end in an arrow, such as "Warm before expiry: automatic ▴"; clicking one lists its options directly above it, one per line, and a pick or a second click closes them.
- The band reflows to its width instead of cutting anything: the buttons move to their own line where they do not fit beside the status, wordings shorten, and in a narrow terminal each label moves above its values. No piece is ever left out.
- The band's buttons have keys while it has the focus: K for keep warm, W for warm now, C for compact and M for the detail.
- The slash command is `/cache-maxxer`, in place of `/cache`: `/cache-maxxer`, `/cache-maxxer more` and `less`, `/cache-maxxer warm` and `/cache-maxxer keep on|off`.
- Warm now and the keep-warm notices say "Cache warmed" with the tokens the ping read and what that saved, or that it found the cache expired and rebuilt it. The keep-warm row counts the warm pings and the tokens they read, and gives what they saved: those tokens at the cache-write price less the cache-read price they paid; dollar figures under a cent read "< $0.01".
- The cache length setting's description and the README say where the length comes from: your `ttl` setting, the newest cache write in the session transcript, or the length Claude Code reports on a model switch, with an hour assumed until one is seen.

### Fixed

- With `ttl` on auto, the band showed the cache length as assumed for the whole session when the transcript did not yet hold the first write as the turn ended, or the first look came within 15 seconds of the session starting. It now looks again every 15 seconds until it has seen the write.
- The README says the plugin reads at most the last 256 KiB of the session transcript, which is the whole file when the transcript is shorter than that.
- The README lists the Compact request among the things that reach the model.
