# Cache Maxxer

A Claude Code mod for the prompt cache.

The cache decides most of what a long session costs and how fast it answers. While it is warm, each request reads your whole conversation at a small fraction of the normal input price. Once its time runs out (an hour on a subscription, five minutes on many API keys) the next message pays to write the whole conversation again. Cache Maxxer shows where the cache stands, explains every time it broke, and can keep it warm on purpose.

## What it shows

A band sits above the prompt as soon as the conversation has a cache. From left to right it has a status dot, a countdown to expiry with a track that drains as time passes, the hit rate of the last request and of the whole session ("97% now · 94% session"), the size of the context the next message sends ("182K ctx"), what the session has read from and written to the cache ("3.1M read · 410K written"), what the cache has saved in dollars ("saved ~$11.80"), and a small chart of the last 24 requests. The countdown is green while the cache is warm, amber in the last sixth of its life, red in the last thirtieth, and grey once it has expired, at which point the band says what the next message will re-write and roughly what that costs.

In the Code tab of the Desktop app the band is a drawn row with real buttons beside it, and a second line when one cannot hold everything. In the terminal it is one line of text with the buttons under it. When there is less room, pieces drop out in a fixed order: the chart, savings, totals, the track, the context size, then the session hit rate. The countdown and the last request's hit rate always stay.

The buttons are Keep warm (on or off), Warm now while the cache is warm, Compact once it has expired, and Details.

Details opens the pane, which `/cache` opens too. It has the countdown large with the cache length and state, a summary of the session, a stacked chart of the last 48 requests (read, written, uncached, with breaks marked), the last eight breaks with their time, size, cost and cause, and the keep-warm controls.

Whenever the cache is rebuilt you get one notice, such as "Cache rebuilt · 182K tokens re-written · expired after 63m idle". The cause is one of: the cache expired while you were away, the model was switched, the conversation was compacted, `/clear` ran, or otherwise the system prompt, tools or MCP servers changed. A cache break is a request that wrote more than 20K tokens and more than half of what it sent. The first request of a fresh session is not counted as one.

With keep warm off, you get one notice when the cache is about to run out ("Cache expires in 4m · Warm now to keep it").

Dollar figures are known for Opus 5.5, Sonnet 5.5 and Haiku 4.5, matched by model id. For any other model the mod shows tokens only and never guesses a price.

## Keep warm

Keep warm is off by default. When it is on, the session is idle and the cache is about to run out, the mod sends one very short request over your conversation asking for a one-word reply. That request reads the cached context, which resets the cache's timer, and the mod notes the ping and what it cost. It sends one at a time, never while Claude is working, and does not retry in a loop if one fails: it tells you why and leaves that expiry alone. Warm now does the same once, on demand.

A ping costs about the size of your context times the cache-read price. For a 180K token Opus conversation that is a few cents, against well over a dollar to re-write the same context after a lapse. With a five minute cache it pings every few minutes, so it adds up much faster than with an hour cache. Keep warm stops once you have not sent anything for the idle cap (three hours unless you change it), and the band says so, so a session you walked away from does not keep spending.

## Commands

`/cache` opens the pane, or prints a one-line summary where nothing can be drawn (a `claude -p` run). `/cache warm` sends one ping. `/cache keep on` and `/cache keep off` set the toggle, which is remembered as the default for new sessions. They all run at once, even while Claude is working.

## Settings

Three settings, each a choice from a short list. In a session, open `/plugin`, go to the Installed tab and choose Configure options on Cache Maxxer. Or put them in your settings file, using the plugin's id (`cache-maxxer@vayaan-mods` when installed from the marketplace here, `cache-maxxer@inline` when loaded with `--plugin-dir`):

```json
{
  "pluginConfigs": {
    "cache-maxxer@vayaan-mods": { "ttl": "1h", "lead": "auto", "idle_cap": "3h" }
  }
}
```

`ttl` is how long the cache lives: `auto` (the default) reads it from the newest cache write in your session transcript after each turn and assumes an hour, shown as "1h?", until it knows; `1h` and `5m` fix it. `lead` is how long before expiry the notice and the ping come: `auto` is 4 minutes for an hour cache and 40 seconds for five minutes, or pick 1, 2, 4 or 8 minutes (never more than half the cache's life). `idle_cap` is how long you can be idle before keep warm stops: 1h, 3h (the default), 8h or none.

The pane has pickers for the lead time and idle cap too. What you pick there applies to the current session only and starts again from the settings above after `/clear`.

## Install

To try it for one session:

```
claude --plugin-dir /path/to/cache-maxxer
```

To have it in every session, including the Desktop app, add this folder as a local marketplace once and install from it:

```
claude plugin marketplace add /path/to/cache-maxxer
claude plugin install cache-maxxer@vayaan-mods
```

Sessions already open pick it up after `/reload-plugins`. Alternatively set `CLAUDE_CODE_PLUGIN_DIRS` to the folder in the `env` block of `~/.claude/settings.json`, which loads it in every session without installing anything.

## What it can reach

A mod runs with your permissions. This one reads the end of your session transcript (the last 256 KB, with `find` and `tail`) to learn the cache length, asks the model for the pings, can start a compaction when you press Compact, and keeps the keep-warm toggle in its own store file. It makes no network requests of its own and never reads the whole transcript.

## Development

```
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
claude plugin test
```

The type declarations Claude Code writes into `.claude-plugin/types/` are not committed.

Tested with Claude Code 2.1.287.
