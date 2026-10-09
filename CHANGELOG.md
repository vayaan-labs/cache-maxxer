# Changelog

All notable changes to Cache Maxxer are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-09

The first public release.

### Added

- A band above Claude Code's input box with the time left on your prompt cache, a bar that drains and turns amber and then red as expiry gets close, how long the cache lives, and the last request's and the session's hit rates to two decimals, never rounded up.
- More opens the session's numbers (requests, tokens read from and written to the cache, the write cost and the dollars saved), a mark for each of the last 10 requests with any rebuild flagged, and the latest rebuild with what it re-wrote, roughly what that cost and why.
- One notice whenever the cache is rebuilt, saying how much was re-written and why: it expired while you were away, the model was switched, the conversation was compacted or cleared, or the system prompt, tools or MCP servers changed.
- Keep warm, off until you turn it on. When the session is idle and the cache is about to expire, it sends one very short request that reads the cache and resets its timer, says what that saved, and stops once you have been idle past a cap (three hours unless you change it). Warm now does the same once, when you ask.
- Dollar figures from Anthropic's published price table, read at most once a day, with a copy of the table shipped in the plugin until a read has worked. A model in neither shows tokens only.
- The band in the terminal, in your theme's colours and reflowing to any width without cutting anything, and in the Claude desktop app, drawn for a window in light and dark, with Hide to tuck it into a small chip.
- `/cache-maxxer`, with `more`, `less`, `warm`, `keep on`, `keep off`, `hide` and `show`, and the keys K, W, C and M while the band has the keyboard.
- Four settings: `ttl`, `lead`, `idle_cap` and `live_prices`.
- An MIT licence, a security policy pointing to private vulnerability reporting, a README and a guide.
