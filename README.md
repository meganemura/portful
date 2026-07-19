# wtshunt

[日本語版](README.ja.md)

Git worktrees let you develop several branches in parallel, but the
client that talks to your server (say, a frontend dev server) still hits
a single port — so every switch means stopping the running server and
starting it again from another worktree. `wtshunt` removes that
restart: each worktree keeps its own backend server (say, a Rails app)
warm on its own port, and a small reverse proxy on the fixed port
forwards to whichever worktree is currently "active." Switching takes
effect on the very next request — no restarting the client, no editing
`.env`, no `cd`.

The name is short for **worktree shunt**. A shunt is the railway
maneuver of redirecting rolling stock onto another track while the rest
of the yard keeps moving — which is exactly what wtshunt does with your
traffic.

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
- A picker ([peco](https://github.com/peco/peco) or
  [fzf](https://github.com/junegunn/fzf)) is optional; whichever is on
  your `PATH` is used for worktree selection, with a numbered prompt as
  the fallback

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
wtshunt serve api/feature-x
wtshunt serve api/feature-y      # in another tab

# 3. Put the proxy on the fixed port (another tab, also foreground)
wtshunt proxy api

# 4. Flip the fixed port between worktrees at will
wtshunt use api                  # opens the picker; applies on the next request
```

The proxy is opt-in: when it isn't running, nothing occupies
`fixed_port`, and every other command keeps working the same way.

## Configuration

Config lives at `$XDG_CONFIG_HOME/wtshunt/config.toml`, falling back to
`~/.config/wtshunt/config.toml`. Define one `[repos.<name>]` table per
repo:

```toml
[repos.api]
path = "~/work/api"            # path to the repo's main checkout
fixed_port = 3000               # the port other services always talk to
port_range = [3101, 3199]       # ports handed out to individual worktrees
serve = "bundle exec rails s -p {port}"

[repos.front]
path = "~/work/front"
fixed_port = 8080
port_range = [8101, 8199]
serve = "API_URL=http://127.0.0.1:{api.port} PORT={port} npm run dev"
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
- `serve` can also reference another registered repo's port with
  `{<repo>.port}` — `front`'s template above resolves `{api.port}` to
  whatever port `api`'s active worktree is using, allocating one if it
  doesn't have one yet. This is what lets multiple repos' worktrees stay
  wired together; see Tasks below for the full workflow.
- Each worktree that ever gets a `wtshunt serve` keeps the same port
  across restarts (a "sticky" assignment), unless wtshunt finds the
  port occupied at assignment time, in which case the next free port in
  `port_range` is used. The occupancy check has limits — see
  Limitations.

The picker `use` and `task add` open for worktree selection can be
swapped via a `[picker]` table:

```toml
[picker]
command = "fzf --height 40% --reverse"
```

Any command that reads candidate lines from stdin and prints the
selected line to stdout works. When unset, peco and then fzf are
auto-detected, falling back to the numbered prompt.

If the config file is missing, `wtshunt` prints the two-repo example
above and exits.

## Commands

Most commands take an optional `<repo>` or `<repo>/<worktree>` argument.
`<repo>` alone uses the repo's current "active" worktree; a bare
invocation with no repo tries to infer the repo from your current
directory (matching it against each configured repo's main checkout and
all of its worktrees, symlinks included).

### `wtshunt use [repo]`

Pick which worktree of a repo is "active." With `repo/worktree`, sets it
directly. With just `repo` (or nothing, inferred from cwd), opens a
picker: the `[picker]` command from config if set, otherwise
auto-detected peco or fzf, otherwise a plain numbered prompt (see
Configuration). If the proxy is already running, it
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
there yourself — e.g. `wtshunt run api bin/rails console` or, from
inside that repo already, just `wtshunt run bin/rails console`. Flags on
the inner command are passed through completely untouched (`wtshunt`
does no option parsing at all for `run`), so
`wtshunt run api bin/rails s -p 3105` works exactly as if you'd run it
by hand.

### `wtshunt status`

Shows, for every configured repo: the active worktree, every running
server (worktree, branch, port, pid), and whether the proxy is running
and what it's currently routing to. `wtshunt status --json` prints the
same data as machine-readable JSON instead, e.g.:

```sh
wtshunt status --json | jq '.repos[] | {name, active}'
```

It also lists any defined tasks — see
[Tasks (experimental)](#tasks-experimental) below.

### `wtshunt stop [repo]`

Stops the running server for the active (or given) worktree: sends
`SIGTERM` to its process group, then polls for up to 2 seconds to
confirm it actually exited before removing it from `wtshunt status`. If
it's still alive after that, the entry is left in place and `stop` exits
`1` with a warning (see Limitations).

### `wtshunt proxy [repo]`

Starts the reverse proxy on the repo's `fixed_port`, in the foreground;
stop it with `Ctrl-C`. Every request is forwarded to whatever worktree is
currently active, re-read from disk on every request — so `wtshunt use`
takes effect on the very next new connection, with the proxy left
running. Ordinary HTTP responses (including error responses) carry an
`X-Wtshunt-Worktree` header naming the worktree that handled (or failed
to handle) the request — the WebSocket handshake response is the one
exception (see Limitations). If the active worktree has no server running,
the proxy returns `502` with a hint to run `wtshunt serve`. If
`fixed_port` is already in use when starting, it prints the process
occupying it (via `lsof`) and exits. WebSocket and other Upgrade
requests are forwarded too — see Limitations for how that interacts
with `use`.

### `wtshunt task ...`

Experimental multi-repo presets — see
[Tasks (experimental)](#tasks-experimental) below.

### `wtshunt ui`

An interactive terminal UI: navigate every repo's worktrees (and any
defined tasks) with `j`/`k` or the arrow keys, and act on the selected row
without leaving the screen:

- `u` / Enter — set the active worktree (on a worktree row), or apply a
  task (on a task row).
- `s` — start a server for the selected worktree.
- `x` — stop it.
- `r` — restart it (stop, then start, skipping the start if the stop
  timed out).
- `p` — toggle the proxy for that row's repo: stop it if running, start
  it otherwise.
- `q` / `Ctrl-C` — quit.

The screen refreshes automatically every couple of seconds and right
after every action. `serve`/`proxy` are opened in a separate pane, tab,
or window — never in the same process as the UI itself — using whichever
multiplexer is available; with none detected, the command is printed for
you to run by hand instead. See "Opening panes from `wtshunt ui`" for
how the multiplexer is chosen. Requires an interactive terminal (TTY).

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
  regardless of which interface it's on. What remains is the narrow
  window between that check and the new server's own bind: a sticky
  port stolen there can still make it die instantly with `EADDRINUSE`.
  If a server exits right within a couple of seconds of `wtshunt serve`,
  the hint printed tells you whether the assigned port is now held by
  another process (per `lsof`) or whether this looks like the usual
  missing-`.env` / missing-`node_modules` case.
- **`stop` waits up to 2 seconds, then gives up loudly.** It sends
  `SIGTERM` and polls for the process to actually exit; if it's still
  alive after 2 seconds (traps `SIGTERM`, or is just shutting down
  slowly), its entry is deliberately kept — you'll keep seeing it in
  `wtshunt status`, and `stop` exits `1` with a warning rather than
  silently pretending it worked.
- **Worktrees usually share a dev database.** Running branches with
  diverging migrations against the same database can break one of them;
  consider per-worktree database names if you switch heavily.

## Shell completion

`wtshunt completion` prints a completion script for the shell that's
running it. Completions are computed dynamically on every `<Tab>`, so
newly added repos or worktrees complete right away without reinstalling
anything:

- With nothing typed yet, it suggests command names (`use`, `serve`,
  `run`, `status`, `stop`, `proxy`, `task`, `ui`, `help`, `completion`).
- As the first argument to `use`, `serve`, `stop`, `proxy`, or `run`, it
  suggests every repo name and every `repo/worktree` name, so
  `run <Tab>` lists them all and `run api/<Tab>` narrows to worktrees of
  `api`. As the argument to `help`, it suggests command names instead.
- After `task`, it suggests `add`/`use`/`list`/`rm`; after `task use` or
  `task rm`, it suggests defined task names. After `task add <name>`, it
  falls through to the same repo/worktree suggestions as `run` and the
  rest.
- Anywhere else — a prefix that matches no repo or worktree (e.g.
  `run rails<Tab>`), or the second argument onward for any command (e.g.
  `run api bin/<Tab>`) — it deliberately returns no matches, which lets
  the shell fall back to its normal file/command completion instead of
  getting stuck offering worktree names that can never apply.

zsh:

```sh
wtshunt completion >> ~/.zshrc
```

bash:

```sh
wtshunt completion >> ~/.bashrc
```

Open a new shell (or `source` the rc file) to pick it up. Only the
static script (which command names exist) lives in the rc file; the
suggestions themselves come from running `wtshunt` on every `<Tab>`.

The zsh script initializes zsh's completion system itself (it calls
`compinit` if `compdef` isn't already available), so it works even in a
`.zshrc` that never calls `compinit` on its own.

## Opening panes from `wtshunt ui`

When `wtshunt ui` opens `serve` or `proxy` for a row (`s`/`r`/`p`), it
launches them as a separate foreground process in a new pane, tab, or
window — the same kind of process a plain `wtshunt serve`/`wtshunt
proxy` invocation would be, just started for you. It picks how to open
that pane in this order:

1. A `[ui]` section in `config.toml`, if present, always wins:

   ```toml
   [ui]
   open = "my-launcher --name {title} {cmd}"
   ```

   `{title}`, `{cmd}`, and `{cwd}` are substituted (each shell-quoted for
   safety) and the result is run with `sh -c`, so this can point at any
   multiplexer or launcher whose CLI can open a new pane running a given
   command.
2. Otherwise, [herdr](https://herdr.dev) is used if it's detected (its
   `HERDR_ENV`/`HERDR_SOCKET_PATH` environment variables are set).
3. Otherwise, [cmux](https://cmux.app) is used if it's detected
   (`CMUX_SOCKET_PATH`/`CMUX_WORKSPACE_ID` are set and `cmux` is on
   `$PATH`) — a new workspace is opened without stealing focus.
4. Otherwise, [tmux](https://github.com/tmux/tmux) is used if detected
   (`$TMUX` is set) — a new window is added to the current session.
5. Otherwise, `wtshunt ui` prints the command to run by hand in another
   terminal, instead of opening anything.

Either way, the command run always references wtshunt's own resolved
executable path directly, rather than a bare `wtshunt` that depends on
`$PATH` being set up the same way in the new pane.

## Tasks (experimental)

Tasks are wtshunt's advanced multi-repo layer — everything above works
without them. The feature is experimental: expect its behavior to
change as real-world feedback comes in.

A single repo's worktrees only get you so far once a change spans more
than one repo — say, an `api` branch and the `front` branch that talks
to it. A **task** is a named preset that bundles one worktree per repo,
so the whole group switches together:

```sh
wtshunt task add feature-x api/feature-x front/feature-x
wtshunt task use feature-x
```

- `wtshunt task add <name> [repo/worktree ...]` creates a task. Repos
  named explicitly use the given worktree; every other registered repo
  gets prompted for via the picker, with a leading option to leave that
  repo out of the task entirely.
- `wtshunt task use <name>` validates every member's worktree still
  exists — if even one doesn't, nothing is applied and an error is
  reported — then switches all of them at once. Reports which members
  have no server running yet, and warns about any already-running
  server whose `{<repo>.port}` wiring no longer matches (see below).
- `wtshunt task list` lists tasks and their members, marking with `*`
  any task whose members all match the current active worktrees.
- `wtshunt task rm <name>` removes a task.

### How the wiring works

The fixed-port proxy in front of a service re-reads `state.json`
(wtshunt's on-disk record of what's running) on every request, so *that*
part always reflects whichever worktree is currently active — no
restart needed.

A `serve` template's `{<repo>.port}` reference is different: it's
substituted once, into the literal shell command run when that server
starts, so it's fixed for as long as that process keeps running.
Switching `api`'s active worktree doesn't retroactively change what an
already-running `front` process is connected to — it keeps talking to
`api`'s old port until you restart it. This is exactly what `task use`
checks for: if a server is still running with `{<repo>.port}` wiring
that no longer matches, it prints a warning telling you to
`wtshunt stop <repo> && wtshunt serve <repo>` to pick up the new one. A
worktree that was never running in the first place picks up the correct
wiring automatically the first time you `serve` it.

Suppose `front` also has a checked-in `.env` that sets its own
`API_URL`. The `API_URL={api.port}` prefix in the `serve` template
still wins only if your framework's `.env` loader treats already-set
environment variables as authoritative and doesn't overwrite them —
the common default for most dotenv implementations, but worth
confirming once for your stack.

Because the proxy's host:port never changes across a switch, any
cookies your client already holds carry over automatically. Whether the
session they represent stays valid depends on whether the worktrees
involved share a session store — see the shared-dev-database note under
Limitations above.

## Development

```sh
npm install
npm test        # node:test; the suite never touches your real config or state
```

There is no build step — the CLI runs the TypeScript in `src/` directly
via tsx. `src/commands/*.ts` hold one subcommand handler each;
`src/proxy.ts` is the reverse-proxy implementation itself
(`src/commands/proxy.ts` is its thin CLI wrapper). `src/portRefs.ts`
resolves `{<repo>.port}` references, `src/tasks.ts` holds the wiring-
mismatch and task-matching logic, and `src/picker.ts` is the worktree
picker shared by `use` and `task add` (the `[picker]` command, else
auto-detected peco/fzf, else the numbered prompt). `src/overview.ts`
collects the data behind both `status` and `status --json`; `src/mux.ts`
implements the multiplexer adapters `wtshunt ui` opens `serve`/`proxy`
through; `src/ui/` holds `wtshunt ui`'s row-model, key-dispatch, and
rendering logic (`src/commands/ui.ts` is its thin terminal/event-loop
wrapper). Runtime state lives in `$XDG_STATE_HOME/wtshunt/state.json`
(default `~/.local/state/wtshunt/state.json`).

## License

MIT — see [LICENSE](LICENSE).
