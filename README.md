# Cache Maxxer

**See your Claude Code prompt cache, and stop it expiring on you.**

Claude Code keeps your conversation in a prompt cache, so each new message does not pay full price to re-read everything said before it. That cache runs out after an idle spell, and Claude Code never tells you. The next message then pays to write the whole conversation again, which costs more and answers slower. Cache Maxxer puts the cache's countdown and hit rate above your input box like a status line, tells you why whenever the cache breaks or expires, and can keep it warm to cut your Claude Code cost.

![The Cache Maxxer band above the input box in a terminal: a green countdown at 58:53 with a track that drains, a 1 hour cache, a 97% hit rate on the last request, and the buttons Keep warm: off, Warm now and More.](assets/band.png)

## Why the cache matters

While the cache is warm, each request reads your conversation at a small fraction of the normal input price. Once it expires, the next message writes the whole conversation back in. At Anthropic's prices for Opus 5.5 ($4 per million tokens of plain input, $0.20 to read from the cache and $8 to write to an hour-long cache), a 180K token conversation costs about 4 cents to read and about $1.44 to write again after a lapse. A cache lives for either an hour or five minutes. Cache Maxxer uses your `ttl` setting if you set one, and otherwise reads the length from your session: the newest cache write in the session transcript, or the length Claude Code reports when you switch model. Until it has seen one it assumes an hour.

## Know where your cache stands

A band appears above the input box as soon as your conversation has a cache. It is one line: a status dot, a countdown to expiry with a track that drains as time passes, how long your cache lives, and the hit rate of the last request. Beside it are three buttons: Keep warm, Warm now (Compact once the cache has expired) and More.

The countdown is green while the cache is warm, amber in the last sixth of its life and red in the last thirtieth, where the band also says "expiring soon", and grey once it has expired. When it has expired the band says what your next message will re-write and roughly what that costs. The colors are your Claude Code theme's own, so the band matches the rest of your terminal.

Press More, or run `/cache-maxxer`, and the band opens in place to show the detail under that line:

- **This session**: the hit rate, the number of requests, the tokens read from the cache, written to it and sent uncached, the size of the context your next message sends, and, for models with a known price, the dollars saved and spent on writes. The saved figure goes negative early in a session, while the writes have not yet been paid back by reads.
- **Requests**: one bar for each of the last requests, newest on the right, colored by what most of it was (read, written or uncached), with a mark for each break.
- **Last break**: when the cache last broke, how much was re-written, roughly what that cost and why, and how many breaks came before it. It is absent while there are none.

Press Less to close it again. Whether the detail is open is remembered for new sessions.

![The band opened: the same first line, then This session with the hit rate, requests and tokens, Requests with a row of bars and its legend, and Last break with its time, size, cost and cause.](assets/band-open.png)

The band reflows to the room it has instead of cutting anything off. Where the status and the buttons do not fit side by side the buttons move to a line of their own; the cache length shortens to "1h cache"; in a narrow terminal each label moves above its values. Whatever other plugins draw in the same spot stays, shown under the band. While the band has the keyboard (click it, or press ctrl+x tab), K toggles keep warm, W warms now, C compacts and M opens or closes the detail. The Desktop app draws the same band, with the countdown and the request bars as small graphics.

Dollar figures use the price table Anthropic publishes, matched by model id. Cache Maxxer reads it when Claude Code starts, at most once a day, so a new model or a price change shows up without an update; until that read has worked it uses a copy of the same table it ships with, which covers every current Claude model. A model priced by prompt length, such as Haiku 5.5, is priced at the rate for each request's own size. For a model in neither table Cache Maxxer shows tokens only and never guesses a price.

## See why a cache broke

Whenever the cache is rebuilt you get one notice, such as "Cache rebuilt · 182K tokens re-written · expired after 63m idle". The cause is one of: the cache expired while you were away, the model was switched, the conversation was compacted, `/clear` ran, or otherwise the system prompt, tools or MCP servers changed.

A cache break is a request that wrote more than 20K tokens and read less than half of what the request before it had cached, which means the cached start of the conversation was lost. A big new message sent on top of a cache that was read, such as a large file early in a session, is not a break. The first request of a fresh session has nothing to lose, so it is not counted as one.

With keep warm off, you also get one notice when the cache is about to run out: "Cache expires in 4m · Warm now to keep it".

## Keep it warm on purpose

Keep warm is off by default. When it is on, your session is idle and the cache is about to run out, Cache Maxxer sends one very short request over your conversation asking for a one-word reply. That request reads the cached context, which resets the cache's timer, and Cache Maxxer notes the ping and what it cost. It sends one at a time, never while Claude is working, and does not retry in a loop if one fails: it tells you why and leaves that expiry alone. Warm now does the same once, when you ask. Either way you get a notice in plain words, such as "Cache kept warm · a background request read 57K tokens from it, so the timer restarted".

A ping costs about the size of your context times the cache-read price. For a 180K token Opus 5.5 conversation that is a few cents, against well over a dollar to re-write the same context after a lapse. With a five minute cache it pings every few minutes, so it adds up much faster than with an hour cache. If a ping finds the cache had already lapsed, it rebuilt the cache instead: the notice says so with what was written and what it cost, the cache is warm again, and the band's keep-warm row counts it as a rebuild rather than as a ping that kept the cache warm.

Keep warm stops once you have not sent anything for the idle cap (three hours unless you change it), and the band says so, so a session you walked away from does not keep spending. It starts again when you send your next message.

While keep warm is on, the band shows its own row, open or closed: how long before expiry to ping and when to stop after you have been idle, as buttons that end in an arrow, such as "Ping: automatically before expiry ▾". Click one and its options appear as buttons in the same row: click one, or Cancel to leave it as it was. Beside them is a count of the pings so far, the tokens those background requests read from the cache and what they cost, and, if keep warm has stopped because you were idle, that it has paused. Where the room is short the choices use shorter wording, "Ping: auto ▾", and the ping details continue on the next line.

![The band with keep warm on: the first line with Keep warm: on highlighted, and a Keep warm row with the buttons "Ping: automatically before expiry" and "Stop: after 3 hours idle", and "No pings yet."](assets/band-keep-warm.png)

## Get started

1. **Add the Vayaan Labs catalogue.** In the Claude desktop app, open the Directory, choose Plugins, press the + button at the top right and choose Add marketplace, then Add from a repository ("Sync a plugin marketplace from a GitHub repository or Git URL"). Enter `vayaan-labs/claude-plugins`, or the full link `https://github.com/vayaan-labs/claude-plugins`.

   ![The Add marketplace dialog in the Claude desktop app, with two choices: Browse Anthropic sources, and Add from a repository, which syncs a plugin marketplace from a GitHub repository or Git URL.](assets/add-marketplace.png)

   In a terminal, run `claude plugin marketplace add vayaan-labs/claude-plugins` instead.

2. **Install Cache Maxxer.** In the Desktop app, find Cache Maxxer in the Vayaan Labs catalogue and install it. In a terminal, run `claude plugin install cache-maxxer@vayaan-labs`.

3. **Send a message.** The band appears above the input box once your conversation has a cache, which is after your first reply. If Claude Code was already open when you installed, run `/reload-plugins` in that session first, or start a new one.

Tested with Claude Code 2.1.289 on macOS, in the terminal. The Desktop app route follows the app's own labels, but its band has not been run by us yet.

## Commands

`/cache-maxxer` opens the band's detail (and shows the band before your first message, to say there is no cache yet), or prints a one-line summary where nothing can be drawn (a `claude -p` run). `/cache-maxxer less` closes the detail. `/cache-maxxer warm` sends one ping. `/cache-maxxer keep on` and `/cache-maxxer keep off` set the keep-warm toggle, which is remembered as the default for new sessions. They run immediately, even while Claude is working. A ping never goes out during a turn, so `/cache-maxxer warm` then tells you Claude is working and sends nothing.

## Settings

Cache Maxxer has four settings, each a choice from a short list. In a terminal, `claude plugin configure cache-maxxer@vayaan-labs` shows them. Or put them in your settings file, using the plugin's id:

```json
{
  "pluginConfigs": {
    "cache-maxxer@vayaan-labs": { "ttl": "1h", "lead": "auto", "idle_cap": "3h", "live_prices": "on" }
  }
}
```

`ttl` is how long the cache lives: `auto` (the default) reads it from the newest cache write in your session transcript, looking again every 15 seconds until it has seen one (the transcript can lag a moment behind the reply) and then after a turn at most every 10 minutes, or from the length Claude Code reports when you switch model, and assumes an hour, shown as "1 hour cache, assumed", until it knows. `1h` and `5m` fix it.

`lead` is how long before expiry the notice and the ping come: `auto` is 4 minutes for an hour cache and 40 seconds for five minutes, or pick 1, 2, 4 or 8 minutes (never more than half the cache's life).

`idle_cap` is how long you can be idle before keep warm stops: 1h, 3h (the default), 8h or none.

`live_prices` is whether Cache Maxxer reads Anthropic's price table once a day: `on` (the default) or `off`, which keeps the prices it shipped with.

## Privacy

Cache Maxxer has no server, account or analytics. Its one network request of its own reads Anthropic's public pricing page (`https://platform.claude.com/docs/en/about-claude/pricing.md`) when Claude Code starts, at most once a day, to learn current prices; it sends nothing about you, your session or your usage, and `live_prices` set to `off` stops it. Everything else that leaves your machine because of it is a request Claude Code makes for you, to the same place all your messages already go. One is the keep-warm ping: Cache Maxxer asks Claude Code to send one very short request ("Reply with exactly one word: ok. Do not use any tools.") over your conversation. It sends one only when keep warm is on and the cache is about to expire, or when you press Warm now or run `/cache-maxxer warm`. It counts toward your usage like any other request. The other is the compaction you start by pressing Compact.

Everything else stays local, and this is all it runs or reads:

- To learn the cache length, it runs `find` to locate your session's transcript under your Claude config folder (`CLAUDE_CONFIG_DIR`, or `~/.claude`) and `tail` to read at most the last 256 KiB of it, which is the whole file when the transcript is shorter than that. It looks only at the cache-write token counts in what it reads, and it only does this when `ttl` is `auto`.
- When you press Compact, it asks Claude Code to compact the conversation, which is a request to the model.
- It remembers the keep-warm toggle, whether the band's detail is open and the last price table it read in the plugin's own saved data. Everything else it tracks (the numbers behind the band) lives in memory for the session.

## Updating and removing

Update with `claude plugin marketplace update vayaan-labs` and then `claude plugin update cache-maxxer@vayaan-labs`, and restart Claude Code to apply it. To remove the plugin, run `claude plugin uninstall cache-maxxer@vayaan-labs`. To remove the whole catalogue, run `claude plugin marketplace remove vayaan-labs`.

## Troubleshooting

**No band.** The band appears once your conversation has a cache, which is after the first reply, and only when the plugin is enabled (`claude plugin list` shows it). If Claude Code was open when you installed, run `/reload-plugins`. If it still does not appear, update Claude Code, since this plugin is tested on 2.1.289 only.

**The band says "assumed".** Cache Maxxer has not yet seen how long your cache lives and is assuming an hour. It looks in your session every 15 seconds until it finds a cache write, or you can set `ttl` yourself.

**No dollar figures.** The model is in neither Anthropic's price table nor the copy Cache Maxxer ships with, which is the case for a model released after your copy and before the daily read has worked (or with `live_prices` off). You get token counts and no dollar amounts until a read of the page lists it.

**`/cache-maxxer` is missing.** Another plugin may have taken the name. The band and the buttons still work.

## Get help

Open an issue at https://github.com/vayaan-labs/cache-maxxer/issues. To report a security problem privately, see [SECURITY.md](SECURITY.md).

## Development

```
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin test
```

To try a change without installing, run `claude --plugin-dir /path/to/cache-maxxer`. The type declarations Claude Code writes into `.claude-plugin/types/` are not committed.

MIT licensed. Built by @YaanFPV.
