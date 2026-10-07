# Changelog

All notable changes to Cache Maxxer are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An MIT licence, a security policy that points to private vulnerability reporting, and licence, homepage, repository and keyword fields in the plugin manifest.
- A README for first-time readers: the Desktop and terminal install routes, screenshots of the band and the Details pane, settings, what the plugin reads and sends, updating, removing and troubleshooting.

### Changed

- The slash command is `/cache-maxxer`, in place of `/cache`: `/cache-maxxer`, `/cache-maxxer warm` and `/cache-maxxer keep on|off`.
- The Details pane takes five lines where it is wide (about 120 columns or more) and flows onto more lines as it narrows, instead of cutting anything: the status and buttons share lines or take one each, the session numbers continue on the next line, the legend drops below the bars, and the latest break continues on a second line with its cause cut at spaces.
- The band flows onto a second line and then more in a narrow terminal, keeping its pieces and its buttons whole, and leaves pieces out only past five lines. What an expired cache's next message re-writes shortens its wording before it overflows.
- The keep-warm pickers are buttons that end in an arrow, such as "Ping: automatically before expiry ▾", with a hint to click or press Enter. Pressing one lists its options as buttons that a click or Enter chooses, and Cancel closes the list.
- Keep warm is one button drawn the same way in the band and the pane, and every press goes through one toggle that flips the setting where it stands, so the pickers show exactly while it is on, however many times it is pressed.
- Warm now and the keep-warm notices say in plain words that a background request read N tokens from the cache and the timer restarted, or that it found the cache expired and rebuilt it. The pane's ping count says the same, and dollar figures under a cent read "under $0.01".
- The terminal pane no longer draws its own Close button, since the pane frame already has one. The Desktop pane keeps Close.
- The cache length setting's description and the README say where the length comes from: your `ttl` setting, the newest cache write in the session transcript, or the length Claude Code reports on a model switch, with an hour assumed until one is seen.

### Fixed

- With `ttl` on auto, the band showed "1h?" and the pane "1 hour (assumed)" for the whole session when the transcript did not yet hold the first write as the turn ended, or the first look came within 15 seconds of the session starting. It now looks again every 15 seconds until it has seen the write.
- The README says the plugin reads at most the last 256 KiB of the session transcript, which is the whole file when the transcript is shorter than that.
- The README lists the Compact request among the things that reach the model.
