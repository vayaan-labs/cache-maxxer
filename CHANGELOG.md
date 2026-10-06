# Changelog

All notable changes to Cache Maxxer are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An MIT licence, a security policy that points to private vulnerability reporting, and licence, homepage, repository and keyword fields in the plugin manifest.
- A README for first-time readers: the Desktop and terminal install routes, screenshots of the band and the Details pane, settings, what the plugin reads and sends, updating, removing and troubleshooting.

### Changed

- The Details pane takes at most five lines in a terminal 80 columns wide or more, down from about 25, including when Claude Code docks it at the side of a wide terminal. The first line holds the countdown, cache length, state and the Warm now, Keep warm and Compact buttons, then one line of session numbers and one row of request history.
- The pane shows the latest cache break on one line, with a count of earlier ones where there is room, and shows the keep-warm pickers only while Keep warm is on, so every control and the latest break stay reachable inside the five lines.
- The keep-warm line keeps the two pickers on one row, using shorter picker wording and dropping the ping details from the end where the room is short, the count last.
- On a narrow pane the first line shortens the cache length, then drops it and the state word. Where the buttons still do not fit beside the status they take a line below it, and where they do not fit on one line they share two lines with the status. When that makes two lines and both a latest break and the keep-warm line show, the history row is left out.
- The latest break line shortens in steps (the cause, the count of earlier breaks, the cost, then the wording) so it never wraps in a narrow pane.
- The terminal pane no longer draws its own Close button, since the pane frame already has one. The Desktop pane keeps Close.
- The cache length setting's description and the README say where the length comes from: your `ttl` setting, the newest cache write in the session transcript, or the length Claude Code reports on a model switch, with an hour assumed until one is seen.

### Fixed

- The README says the plugin reads at most the last 256 KiB of the session transcript, which is the whole file when the transcript is shorter than that.
- The README lists the Compact request among the things that reach the model.
