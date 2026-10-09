<p align="center">
  <img src="assets/icon.svg" width="128" height="128" alt="Cache Maxxer icon: a green countdown ring around a dot">
</p>

<h1 align="center">Cache Maxxer</h1>

<p align="center"><b>A Claude Code plugin that shows your prompt cache's countdown and hit rate, and can keep the cache warm so you stop paying to rebuild it.</b></p>

<p align="center">
  <a href="#get-started">Install</a> · <a href="docs/guide.md">Guide</a> · <a href="#privacy">Privacy</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="https://github.com/vayaan-labs/cache-maxxer/issues">Report a bug</a>
</p>

<p align="center">
  <a href="https://github.com/vayaan-labs/cache-maxxer/actions/workflows/ci.yml"><img src="https://github.com/vayaan-labs/cache-maxxer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/vayaan-labs/cache-maxxer/releases/latest"><img src="https://img.shields.io/github/v/release/vayaan-labs/cache-maxxer?style=flat-square&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/Claude_Code-2.1.289+-d97757?style=flat-square" alt="Claude Code 2.1.289 or later">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/vayaan-labs/cache-maxxer?style=flat-square" alt="MIT licence"></a>
  <a href="https://github.com/vayaan-labs/cache-maxxer/stargazers"><img src="https://img.shields.io/github/stars/vayaan-labs/cache-maxxer?style=flat-square" alt="GitHub stars"></a>
</p>

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/band-desktop-closed-dark.png">
  <img src="assets/band-desktop-closed-light.png" alt="The Cache Maxxer band in the Claude desktop app: a large 58:16 countdown over a draining bar, 1 hour cache, Warm, a ring for each hit rate at 99.91% last request and 99.58% this session, and the buttons Keep warm: off, Warm now, More and Hide.">
</picture>
</p>
<p align="center"><i>The band in the Claude desktop app, right above the input box.</i></p>

Claude Code caches your conversation so each message doesn't pay full price to re-read everything before it. That cache quietly expires after an idle spell, and your next message pays to write the whole conversation again: slower, and on a long Opus session well over a dollar. Cache Maxxer puts the countdown right above your input box, tells you why every time the cache breaks, and can keep it warm for you.

## Get started

1. **Add the Vayaan Labs catalogue.** In the Claude desktop app, open the Directory, choose Plugins, press + and choose Add marketplace, then Add from a repository, and enter `vayaan-labs/claude-plugins`. In a terminal:

   ```
   claude plugin marketplace add vayaan-labs/claude-plugins
   ```

2. **Install Cache Maxxer.** Find it in the Vayaan Labs catalogue and install it, or in a terminal:

   ```
   claude plugin install cache-maxxer@vayaan-labs
   ```

3. **Send a message.** The band shows up once your conversation has a cache, which is after your first reply. If Claude Code was already open, run `/reload-plugins` first.

Press **More** for the session's numbers, the last 10 requests with any cache break marked, and the latest break with its cost and cause. Press **Keep warm** to turn on the pings. Everything else, from the settings to the `/cache-maxxer` command, is in the [guide](docs/guide.md).

## What you get

- **A countdown you can see.** Time left on the cache, a bar that drains, and a color that turns amber, then red, as expiry gets close.
- **Your real cache hit rate.** The last request's and the whole session's, to two decimals, so 99.86% never pretends to be 100%.
- **Every cache break explained.** One notice saying what was re-written and why: you were idle, you switched model, compacted, cleared, or the system prompt, tools or MCP servers changed.
- **Keep warm, on your terms.** One tiny ping just before expiry resets the timer for a few cents, and it stops by itself once you've walked away.
- **What it saves and costs.** Tokens read from the cache and written to it, and dollars from Anthropic's own price table, read once a day so new models just work.
- **At home in both apps.** A compact band in the terminal, and in the Claude desktop app a drawn one with a large countdown, hit-rate rings and native menus that follows your light or dark appearance and shrinks to fit a narrow window.

<p align="center">
  <img src="assets/band.png" alt="The Cache Maxxer band in a terminal: a green countdown at 59:47 beside a bar that drains, 1 hour cache, hit 95.33% last request and 68.19% this session, and the buttons Keep warm: off, Warm now and More.">
</p>
<p align="center"><i>The same band in a terminal, on one line.</i></p>

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/band-desktop-keep-warm-open-dark.png">
  <img src="assets/band-desktop-keep-warm-open-light.png" alt="The desktop band opened with keep warm on: this session at a 99.58% hit rate over about 550 requests, 300M tokens read, about $10 of cache writes and about $1,100 saved; the last 10 requests with no cache break; the last break, compacted at 22:29, 78K re-written for about $0.62; the menus Warm before expiry: automatic and Stop after idle: 3 hours with 3 warm pings, 1.5M tokens read and about $11.63 saved; and the first line with the countdown and both hit rates.">
</picture>
</p>
<p align="center"><i>Opened with More and keep warm on: what the session cost, what it saved, and what the pings saved.</i></p>

## Supported

- Claude Code 2.1.289 or later, in the terminal and in the Claude desktop app, on macOS.
- Every current Claude model. Prices come from Anthropic's public price table; a model not in it gets token counts and no dollar figures.
- One-hour and five-minute caches, read from your session or set by you.

## Privacy

Cache Maxxer has no server, account or analytics. It makes one network request of its own: it reads Anthropic's public pricing page (`platform.claude.com/docs/en/about-claude/pricing.md`) at most once a day, sending nothing about you or your session. Set `live_prices` to `off` and it never does.

Two other things leave your machine because of it, and both are ordinary Claude Code requests to the place your messages already go. The keep-warm ping asks for a one-word reply over your conversation, only when keep warm is on or you press Warm now, and counts toward your usage like any other request. Compact, when you press it, compacts the conversation.

On your machine, while the cache length is set to `auto`, it reads the last 256 KiB of your session transcript to learn how long the cache lives, looking only at the cache-write token counts in it. It saves four things in the plugin's own data: the keep-warm toggle, whether the detail is open, whether the Desktop band is tucked away, and the last price table. Everything else lives in memory for the session.

## Contributing

Bug reports and pull requests are welcome. Run `claude plugin validate --strict .claude-plugin/plugin.json` and `claude plugin test` before sending a change, and see the [guide](docs/guide.md#development) to try it without installing. To report a security problem privately, see [SECURITY.md](SECURITY.md).

## Licence

MIT. Built by [@YaanFPV](https://github.com/yaanfpv).
