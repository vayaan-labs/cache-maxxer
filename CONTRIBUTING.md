# Contributing to Cache Maxxer

Thanks for helping make it better.

## Reporting a bug

Open an [issue](https://github.com/vayaan-labs/cache-maxxer/issues/new/choose) and say what you saw and what you expected. Include your Claude Code version (`claude --version`), whether it was the terminal or the Claude desktop app, and your operating system. A screenshot of the band helps a lot.

A security problem goes through [SECURITY.md](SECURITY.md) instead, never a public issue.

## Making a change

1. Fork the repository and branch from `main`.
2. Try your change without installing it: `claude --plugin-dir /path/to/cache-maxxer`.
3. Before you open a pull request, run both checks and make sure they pass:

   ```
   claude plugin validate --strict .claude-plugin/plugin.json
   claude plugin test
   ```

4. If a user would notice the change, add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
5. Open the pull request against `main` and say what changed and why. Pull requests are squash-merged, so the title becomes the commit message: write it as a short instruction, such as "Show the hit rate in the hidden chip".

The [guide](docs/guide.md) explains how each part of the band works.

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
