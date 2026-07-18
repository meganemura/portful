# wtshunt

[日本語版](README.ja.md)

`wtshunt` lets one service (say, a frontend dev server) keep hitting a
fixed port for a backend (say, a Rails app) while you juggle several git
worktrees of that backend at once. Each worktree gets its own backend
server on its own port; a small reverse proxy sits on the fixed port and
forwards to whichever worktree is currently "active." Switching takes
effect on the very next request — no restarting the frontend, no editing
`.env`, no `cd`.

The name comes from railway shunting: redirecting rolling stock onto
another track while the rest of the yard keeps moving.

Directory-scoped tools like direnv or shell aliases only affect processes
you start *afterwards* — they cannot re-point a client that is already
running. Redirecting that already-running client is the case wtshunt
exists for.

- Start a server for a worktree in the foreground: `wtshunt serve`
- Run one-off commands inside a worktree without `cd`-ing there: `wtshunt run`
- Flip which worktree the proxy points at: `wtshunt use`
- See what's running across every worktree: `wtshunt status`

## When you don't need this

- You're not using git worktrees at all — there's nothing here for you.
- Your client can be restarted cheaply, or already re-reads its target
  from an env var/config file — just point it at the new port directly.
- You only ever run one worktree's server at a time — plain `cd` and
  start/stop already does the job.

## Requirements

- Node.js 20 or newer (developed on Node 25)
- macOS or Linux — wtshunt relies on POSIX `sh` and process groups, and
  uses `lsof` to diagnose port conflicts
- `git` (worktrees are enumerated with `git worktree list`)
- [peco](https://github.com/peco/peco) is optional; the worktree picker
  falls back to a numbered prompt without it

## Install

```sh
npm install
npm link
```

`npm link` puts a `wtshunt` executable on your `PATH` (backed by
[tsx](https://github.com/privatenumber/tsx), so no build step is needed —
edits to `src/` take effect immediately). To try it out without linking
anything, run `./bin/wtshunt.js <command>` directly from the checkout.

## Quick start

```sh
# 1. Register the backend repo (one-time; see Configuration below)
mkdir -p ~/.config/wtshunt && $EDITOR ~/.config/wtshunt/config.toml

# 2. Warm one server per worktree — one terminal tab each, in the foreground
wtshunt serve b/feature-auth
wtshunt serve b/feature-perf     # in another tab

# 3. Put the proxy on the fixed port (another tab, also foreground)
wtshunt proxy b

# 4. Flip the fixed port between worktrees at will
wtshunt use b                    # opens the picker; applies on the next request
```

The proxy is opt-in: when it isn't running, nothing occupies
`fixed_port`, and every other command keeps working the same way.

## Configuration

Config lives at `$XDG_CONFIG_HOME/wtshunt/config.toml`, falling back to
`~/.config/wtshunt/config.toml`. Define one `[repos.<name>]` table per
backend repo:

```toml
[repos.b]
path = "~/work/b"             # path to the repo's main checkout
fixed_port = 3000              # the port the frontend always talks to
port_range = [3101, 3199]      # ports handed out to individual worktrees
serve = "bundle exec rails s -p {port}"
```

- `path` points at the repo's main checkout and supports `~` expansion.
  wtshunt does not create worktrees — add them yourself with
  `git worktree add`; everything `git worktree list` reports (including
  the main checkout) becomes selectable.
- `serve` is run with `sh -c`, with `{port}` substituted for the port
  assigned to that worktree. This means env-var prefixes work too, e.g.
  `serve = "PORT={port} bin/dev"`. The literal `{port}` placeholder is
  required — config loading fails immediately if it's missing, since
  without it the server would bind whatever port your framework
  defaults to while `status` and the proxy keep believing it's on the
  assigned one.
- Each worktree that ever gets a `wtshunt serve` keeps the same port
  across restarts (a "sticky" assignment), unless wtshunt finds the
  port occupied at assignment time, in which case the next free port in
  `port_range` is used. The occupancy probe binds the IPv4 and IPv6
  wildcard addresses, which catches a foreign listener regardless of
  which interface it bound — see Limitations for what it still can't
  catch.

If the config file is missing, `wtshunt` prints this example and exits.

## Commands

Most commands take an optional `<repo>` or `<repo>/<worktree>` argument.
`<repo>` alone uses the repo's current "active" worktree; a bare
invocation with no repo tries to infer the repo from your current
directory (matching it against each configured repo's main checkout and
all of its worktrees, symlinks included).

### `wtshunt use [repo]`

Pick which worktree of a repo is "active." With `repo/worktree`, sets it
directly. With just `repo` (or nothing, inferred from cwd), opens a
picker: [peco](https://github.com/peco/peco) if it's on your `PATH`,
otherwise a plain numbered prompt. If the proxy is already running, it
immediately starts routing to the newly active worktree — no restart
needed. If no server is running yet for that worktree, `use` warns you
and tells you to run `wtshunt serve`.

### `wtshunt serve [repo]`

Starts the backend server for the active (or given) worktree in the
foreground, in that worktree's directory, on an assigned port. Refuses to
start a second server for a worktree that already has one running.
Forwards `SIGINT`/`SIGTERM` to the child process group, so `Ctrl-C` stops
it cleanly.

### `wtshunt run [repo[/worktree]] <cmd...>`

Runs an arbitrary command inside a worktree's directory, without `cd`-ing
there yourself — e.g. `wtshunt run b bin/rails console` or, from inside
that repo already, just `wtshunt run bin/rails console`. Flags on the
inner command are passed through completely untouched (`wtshunt` does no
option parsing at all for `run`), so `wtshunt run b bin/rails s -p 3105`
works exactly as if you'd run it by hand.

### `wtshunt status`

Shows, for every configured repo: the active worktree, every running
server (worktree, branch, port, pid), and whether the proxy is running
and what it's currently routing to.

### `wtshunt stop [repo]`

Stops the running server for the active (or given) worktree: sends
`SIGTERM` to its process group, then polls for up to 2 seconds to
confirm it actually exited before removing it from `wtshunt status`. If
it's still alive after that, the entry is left in place and `stop` exits
non-zero with a warning (see Limitations).

### `wtshunt proxy [repo]`

Starts the reverse proxy on the repo's `fixed_port`, in the foreground;
stop it with `Ctrl-C`. Every request is forwarded to whatever worktree is
currently active, re-read from disk on every request — so `wtshunt use`
takes effect on the very next new connection, with the proxy left
running. Responses (including error responses) carry an
`X-Wtshunt-Worktree` header naming the worktree that handled (or failed
to handle) the request. If the active worktree has no server running,
the proxy returns `502` with a hint to run `wtshunt serve`. If
`fixed_port` is already in use when starting, it prints the process
occupying it (via `lsof`) and exits. WebSocket and other Upgrade
requests are forwarded too — see Limitations for how that interacts
with `use`.

### `wtshunt help [command]`

Shows the same thing as `wtshunt --help`; with a command name, shows that
command's own help (equivalent to `wtshunt <command> --help`).

## Limitations and troubleshooting

- **WebSockets route on connect, not on switch.** An Upgrade request
  (Rails ActionCable, Vite/webpack HMR) is forwarded to whichever
  worktree is active at the moment it's opened, but an already-open
  connection doesn't move if `use` changes the active worktree
  afterward — only the next new connection picks it up. In practice
  this is rarely noticeable: ActionCable and HMR clients reconnect on
  their own, and land on the new worktree the moment they do. The 101
  handshake response is relayed as-is, so it does not carry an
  `X-Wtshunt-Worktree` header the way ordinary HTTP responses do.
- **`status` reports process liveness, not reachability.** A server
  that failed to bind where wtshunt expected — wrong port flag, wrong
  interface — still shows as running while the proxy answers 502. When
  `status` and reality disagree, `lsof -i :<port>` tells you who is
  actually listening.
- **Port probes can still be fooled.** The free-port check binds the
  IPv4 and IPv6 wildcard addresses, which catches a foreign process
  regardless of which interface it's on, but a sticky port stolen by
  another process in the narrow window between that check and the new
  server's own bind can still make it die instantly with `EADDRINUSE`.
  If a server exits right within a couple of seconds of `wtshunt serve`,
  the hint printed tells you whether the assigned port is now held by
  another process (per `lsof`) or whether this looks like the usual
  missing-`.env` / missing-`node_modules` case.
- **`stop` waits up to 2 seconds, then gives up loudly.** It sends
  `SIGTERM` and polls for the process to actually exit; if it's still
  alive after 2 seconds (traps `SIGTERM`, or is just shutting down
  slowly), the state entry is deliberately left in place — you'll keep
  seeing it in `wtshunt status`, and `stop` exits non-zero with a
  warning rather than silently pretending it worked.
- **Worktrees usually share a dev database.** Running branches with
  diverging migrations against the same database will break one of them;
  consider per-worktree database names if you switch heavily.

## Shell completion

`wtshunt completion` prints a completion script for the shell that's
running it. Completions are computed dynamically on every `<Tab>`, so
newly added repos or worktrees complete right away without reinstalling
anything:

- With nothing typed yet, it suggests command names (`use`, `serve`,
  `run`, `status`, `stop`, `proxy`, `help`, `completion`).
- As the first argument to `use`, `serve`, `stop`, `proxy`, or `run`, it
  suggests every repo name and every `repo/worktree` name, so
  `run <Tab>` lists them all and `run b/<Tab>` narrows to worktrees of
  `b`. As the argument to `help`, it suggests command names instead.
- Anywhere else — a prefix that matches no repo or worktree (e.g.
  `run rails<Tab>`), or the second argument onward for any command (e.g.
  `run b bin/<Tab>`) — it deliberately returns no matches, which lets the
  shell fall back to its normal file/command completion instead of
  getting stuck offering worktree names that can never apply.

zsh:

```sh
wtshunt completion >> ~/.zshrc
```

bash:

```sh
wtshunt completion >> ~/.bashrc
```

Open a new shell (or `source` the rc file) to pick it up. If you add repos
or worktrees later, no reinstall is needed — only the static script (which
command names exist) is appended once; the repo and worktree suggestions
themselves are computed fresh on every `<Tab>`.

The zsh script initializes zsh's completion system itself (it calls
`compinit` if `compdef` isn't already available), so it works even in a
`.zshrc` that never calls `compinit` on its own.

## Development

```sh
npm install
npm test        # node:test; the suite never touches your real config or state
```

There is no build step — the CLI runs the TypeScript in `src/` directly
via tsx. `src/commands/*.ts` hold one subcommand handler each;
`src/proxy.ts` is the reverse-proxy implementation itself
(`src/commands/proxy.ts` is its thin CLI wrapper). Runtime state lives in
`$XDG_STATE_HOME/wtshunt/state.json` (default
`~/.local/state/wtshunt/state.json`).

## License

MIT — see [LICENSE](LICENSE).
