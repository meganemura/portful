# portful

[![npm version](https://img.shields.io/npm/v/portful)](https://www.npmjs.com/package/portful)

Git worktrees let you develop several branches in parallel, but the
client that talks to your server (say, a frontend dev server) still hits
a single port, so every switch means stopping the running server and
starting it again from another worktree. `portful` removes that
restart: each worktree keeps its own backend server (say, a Rails app)
warm on its own port, and a small reverse proxy on the fixed port
forwards to whichever worktree is currently "active." Switching takes
effect on the very next request: no restarting the client, no editing
`.env`, no `cd`.

The name answers [portless](https://portless.sh/), which replaces port
numbers with named `.localhost` URLs. Ports are the subject here. One
port stays fixed for every client, and one more port runs behind it for
each worktree. portful borrows portless's commands and config layout
wherever the two tools do the same thing, so a portless user can read
this one without a second manual. See
[Coming from portless](#coming-from-portless).

Directory-scoped tools like direnv or shell aliases only affect processes
you start *afterwards*. They cannot re-point a client that is already
running. Redirecting that already-running client is the case portful
exists for.

- Start this worktree's server: `portful` (or `portful run`)
- Start a named worktree's server: `portful serve api/feature-x`
- Flip which worktree the proxy points at: `portful use`
- See where each fixed port currently goes: `portful list`
- Run one-off commands inside a worktree without `cd`-ing there: `portful exec`

## When you don't need this

- You're not using git worktrees at all, so there's nothing here for you.
- Your client can be restarted cheaply, or already re-reads its target
  from an env var/config file. Just point it at the new port directly.
- You only ever run one worktree's server at a time: plain `cd` and
  start/stop already does the job.

## Coming from portless

[portless](https://github.com/vercel-labs/portless) gives each app a
named `.localhost` URL and routes to it by hostname. portful keeps one
fixed port per repo and routes by which worktree is active, re-read on
every request. The two answer different questions, so many people want
both: point a portless alias at portful's fixed port, and the name comes
from portless while the switching comes from portful.

Commands that mean the same thing carry the same name:

| portless | portful |
| --- | --- |
| `portless` | `portful` |
| `portless run` | `portful run` |
| `portless <name> <cmd...>` | `portful <repo> <cmd...>` |
| `portless list` | `portful list` |
| `portless proxy start` / `stop` | `portful proxy start` / `stop` |
| `portless doctor` | `portful doctor` |
| `portless prune` | `portful prune` |
| `portless clean` | `portful clean` |
| `portless trust` | portful uses the certificates that you configure for its proxy |
| `portless hosts sync` / `hosts clean` | portful routes through its configured fixed ports |
| `portless service install` | run `portful proxy start` in a terminal for each proxy |
| `portless proxy start --lan` / `--tailscale` / `--ngrok` | portful binds the loopback addresses only |
| `portless alias <name> <port>` | `portful use <repo>/<worktree>` selects a worktree by name |
| change each portless alias for a multi-repo context | `portful task add` / `task use` stores and selects that context |
| change to the worktree directory and run the command | `portful exec <repo>/<worktree> <cmd...>` |
| use the portless commands for each operation | `portful ui` provides an interactive terminal interface |
| identify the current app from the directory and `portless list` | `portful whoami` reports the current repo and worktree |
| run the app outside portless, on whatever port it binds | `portful serve --direct` binds the fixed port for one run, with no proxy in front |

The extra portless commands install or update machine resources, such as a CA,
host entries, a service, or network exposure. On the portful side, the extra commands pick
the worktree or the multi-repo context to use now, and act inside it.

Config follows the same layout: a `portful.json` in the repo, or a
`"portful"` key in `package.json`, with the same precedence portless
uses. `PORT`, `HOST`, and `PORTFUL_URL` reach the child process, so a
server that already reads `PORT` starts with no template at all.

Four things stay different, deliberately:

- **The address is a port, not a name.** That is the whole point: a
  client that already holds `http://127.0.0.1:3000` keeps working across
  a switch, cookies included.
- **No privileged port, no CA, no `/etc/hosts`.** portful writes to its
  own config and state directories and binds the ports you configure. A
  managed work laptop can run it without an administrator.
- **`proxy start` runs in the foreground.** One tab per proxy keeps the
  request log visible and makes `Ctrl-C` the stop button.
- **`alias` is absent.** In portless it adds another hostname route; here
  it would have to mean "ignore the active worktree", which is a
  different action. `portful <repo> <cmd...>` covers reaching a server
  portful did not start.

Both tools can switch a client to another worktree while its URL and cookies
stay unchanged. With portless, run `portless list`, copy the assigned port from
the 4000-4999 range, then run `portless alias <name> <port> --force`. With
portful, `portful use` accepts the worktree name and resolves its port internally.

## Requirements

- Node.js 24 or newer (developed on Node 26)
- macOS or Linux, since portful relies on POSIX `sh` and process groups,
  and uses `lsof` to diagnose port conflicts
- `git` (worktrees are enumerated with `git worktree list`)
- A picker ([peco](https://github.com/peco/peco) or
  [fzf](https://github.com/junegunn/fzf)) is optional; whichever is on
  your `PATH` is used for worktree selection, with a numbered prompt as
  the fallback

## Install

```sh
npm install -g portful
```

The published package is a single bundled file with no dependencies of
its own, so the install adds one package and nothing else.

To work on portful from a checkout instead:

```sh
git clone https://github.com/meganemura/portful.git
cd portful
npm install
./bin/portful.js <command>
```

That entry point runs the TypeScript in `src/` through
[tsx](https://github.com/privatenumber/tsx), so an edit takes effect on
the next command with no build in between. `npm link` puts it on your
`PATH` under the name `portful`.

## Quick start

```sh
# 1. Register the repo, once per machine: which repos exist and where they are
mkdir -p ~/.config/portful
cat > ~/.config/portful/config.json <<'JSON'
{ "repos": { "api": { "path": "~/work/api" } } }
JSON

# 2. Give the repo its ports. This file lives in the checkout, so committing
#    it hands the same setup to every contributor.
cat > ~/work/api/portful.json <<'JSON'
{
  "fixedPort": 3000,
  "portRange": [3101, 3199],
  "serve": "bundle exec rails s -p {port}"
}
JSON

# 3. Warm one server per worktree: one terminal tab each, in the foreground
portful serve api/feature-x
portful serve api/feature-y      # in another tab

# 4. Put the proxy on the fixed port (another tab, also foreground)
portful proxy start api

# 5. Flip the fixed port between worktrees at will
portful use api                  # opens the picker; applies on the next request
```

A server that reads the `PORT` environment variable needs no `serve` line
at all. Drop it, and `portful` run from inside a worktree starts that
project's own `dev` script with `PORT` already set.

The same flow as a diagram (the second request lands on feature-y
without anything being restarted):

```mermaid
sequenceDiagram
    participant C as client (always :3000)
    participant P as portful proxy (:3000)
    participant X as api/feature-x (:3101)
    participant Y as api/feature-y (:3102)
    Note over X,Y: both kept running by portful serve
    C->>P: GET /todos
    P->>X: forward (active: feature-x)
    Note over C,Y: $ portful use api/feature-y (flips the active pointer)
    C->>P: GET /todos
    P->>Y: forward (active is re-read on every request)
```

The diagram shows ordinary HTTP requests; a WebSocket connection is
routed once, when it is opened (see Limitations).

The proxy is opt-in: when it isn't running, nothing occupies
`fixedPort`, and every other command keeps working the same way.

## Configuration

Config lives at two levels, the way portless splits its own.

**The user-level file** is `$XDG_CONFIG_HOME/portful/config.json`,
falling back to `~/.config/portful/config.json`. It registers which repos
exist and where their checkouts are, which no file inside a repo can
state about itself:

```json
{
  "repos": {
    "api":   { "path": "~/work/api" },
    "front": { "path": "~/work/front" }
  },
  "picker": { "command": "fzf --height 40% --reverse" }
}
```

**The repo-level file** is `portful.json` at the repo's main checkout, or
a `"portful"` key in its `package.json`. It carries what belongs to the
project:

```json
{
  "fixedPort": 3000,
  "portRange": [3101, 3199],
  "serve": "bundle exec rails s -p {port}"
}
```

Precedence is one rule: the user-level entry wins over both repo-level
sources, and the `package.json` key wins over `portful.json`, matching
portless. Your machine beats the repo's suggestion, because ports are
allocated per machine.

### Keys

- `path` (user level only) points at the repo's main checkout and
  supports `~` expansion. portful does not create worktrees. Add them
  yourself with `git worktree add`; everything `git worktree list`
  reports (including the main checkout) becomes selectable.
- `fixedPort` is the port other services always talk to.
- `portRange` is `[min, max]`, the ports handed out to individual
  worktrees.
- `serve` is optional. When set, it is run with `sh -c`, with `{port}`
  substituted for the port assigned to that worktree, so env-var prefixes
  work too (`"serve": "PORT={port} bin/dev"`). A `serve` that is set must
  contain the literal `{port}`: without it the server binds whatever port
  your framework defaults to, while `status` and the proxy keep believing
  it is on the assigned one.
- `script` names the `package.json` script to run when `serve` is absent,
  defaulting to `dev`. The package manager comes from the lockfile in the
  worktree: `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, then
  `package-lock.json`, falling back to npm.
- `serve` can also reference another registered repo's port with
  `{<repo>.port}`. A `front` template of
  `"API_URL=http://127.0.0.1:{api.port} PORT={port} npm run dev"` resolves
  `{api.port}` to whatever port `api`'s active worktree is using,
  allocating one if it doesn't have one yet. This is what lets multiple
  repos' worktrees stay wired together; see Tasks below for the full
  workflow.
- `name`, if you set it in `portful.json`, must match the name the repo
  is registered under. A mismatch fails config loading, naming both.

Every server portful starts receives `PORT`, `HOST`, and `PORTFUL_URL`
in its environment. `PORTFUL_URL` is the fixed-port address clients use,
not the worktree's own port.

Each worktree that ever gets a `portful serve` keeps the same port across
restarts (a "sticky" assignment), unless portful finds the port occupied
at assignment time, in which case the next free port in `portRange` is
used. The occupancy check has limits (see Limitations).

Ports are checked for collisions across repos when the config loads: two
repos can't share a `fixedPort`, their `portRange`s can't overlap, and no
repo's `fixedPort` may fall inside any repo's `portRange` (including its
own). Each of these fails config loading immediately, naming the repos
involved.

### https

A repo can carry an optional `https` object, for worktree servers that
already run with a mkcert (or similar) certificate:

```json
{
  "fixedPort": 3000,
  "portRange": [3101, 3199],
  "https": {
    "cert": "~/certs/localhost.pem",
    "key": "~/certs/localhost-key.pem",
    "backend": true
  }
}
```

- `cert`/`key` TLS-terminate the fixed-port listener itself. A mkcert-issued
  pair for `localhost`/`127.0.0.1` can usually be pointed at directly, since
  it's the same certificate the worktree servers already trust. They must be
  set together, or both left out entirely; either path not existing or not
  being readable fails config loading immediately, and both paths support
  `~` expansion the same way `path` does.
- `backend` (default `false`) makes the proxy talk to the worktree's own
  server over https instead of http, for setups where the backend itself
  terminates TLS. It's independent of `cert`/`key`: a plain-http listener
  can forward to an https backend, and a TLS-terminating listener can
  forward to a plain-http backend, in any combination.
- With no `https` object at all, the proxy stays plain http in, plain
  http out.

portful generates no certificate authority and touches no system trust
store. Point it at a pair you already have.

### Picker

The picker `use` and `task add` open for worktree selection comes from
the user-level `picker` object shown above. Any command that reads
candidate lines from stdin and prints the selected line to stdout works.
When unset, peco and then fzf are auto-detected, falling back to a plain
numbered prompt.

If the config file is missing, `portful` prints a sample and exits.

## Commands

Most commands take an optional `<repo>` or `<repo>/<worktree>` argument.
`<repo>` alone uses the repo's current "active" worktree; a bare
invocation with no repo tries to infer the repo from your current
directory (matching it against each configured repo's main checkout and
all of its worktrees, symlinks included).

### `portful` and `portful run`

Starts a server for the worktree you are standing in. This is the
portless-shaped entry point: `portful` on its own is the same as
`portful run`, and `portful run --name <repo>` names the repo instead of
inferring it.

What it runs, in order: the repo's `serve` template when one is set,
otherwise the `package.json` script named by `script` (default `dev`),
run through the package manager the worktree's lockfile indicates. A
script that the project does not define is reported along with the
scripts it does define.

`run` takes the worktree from the current directory. `serve` follows the
repo's active pointer instead, which is the pointer this tool exists to
switch, so the two verbs answer two different questions.

### `portful <repo> <cmd...>`

Starts a server for `<repo>` running the command you give, replacing the
`serve` template, the way `portless <name> <cmd...>` starts an app:

```sh
portful api bundle exec rails s
portful api/feature-x npm run dev
```

The worktree comes from the current directory, or from the active
pointer when you are standing outside the repo. The command is spawned
directly rather than through a shell, so its arguments reach it exactly
as typed, and it reads its port from `PORT`.

Every command name listed in this section is reserved, so a repo named
`status` or `list` needs `portful serve status` rather than the
positional form.

### `portful use [repo]`

Pick which worktree of a repo is "active." With `repo/worktree`, sets it
directly. With just `repo` (or nothing, inferred from cwd), opens a
picker: the `picker` command from config if set, otherwise
auto-detected peco or fzf, otherwise a plain numbered prompt (see
Configuration). If the proxy is already running, it
immediately starts routing to the newly active worktree, no restart
needed. If no server is running yet for that worktree, `use` warns you
and tells you to run `portful serve`.

### `portful serve [repo]`

Starts the backend server for the active (or given) worktree in the
foreground, in that worktree's directory, on an assigned port. Refuses to
start a second server for a worktree that already has one running.
Forwards `SIGINT`/`SIGTERM` to the child process group, so `Ctrl-C` stops
it cleanly.

`portful serve [repo] --direct` substitutes the repo's `fixedPort` for
`{port}` instead of the usual sticky worktree port, for running that
worktree exactly as it'd look bound in production, no proxy in front of
it. It's a one-off, temporary substitution: the sticky ports map is left
completely untouched. Refuses to start if the repo's proxy is already
running (stop it first, since otherwise both would fight over `fixedPort`),
or if something else already occupies `fixedPort` (reported via `lsof`,
the same way `portful proxy start`'s own occupied-port check does). The
resulting server entry in `portful status`/`portful ui` shows `fixedPort`
as its port, same as any other running server.

### `portful exec [repo[/worktree]] <cmd...>`

Runs an arbitrary command inside a worktree's directory, without `cd`-ing
there yourself, e.g. `portful exec api bin/rails console` or, from
inside that repo already, just `portful exec bin/rails console`. Flags on
the inner command are passed through completely untouched (`portful`
does no option parsing at all for `exec`), so
`portful exec api bin/rails s -p 3105` works exactly as if you'd run it
by hand. If the target worktree comes from the repo's active pointer
(repo omitted, or given bare with no `/worktree`) and your cwd is
actually inside a *different* worktree of that repo, both `exec` and
`serve` print a one-line warning to stderr before running. Passing
`repo/worktree` explicitly always suppresses it, since that's you
choosing on purpose.

The name is `exec` rather than `run` because portless's `run` already
means "start the app through the proxy", and portful's `run` means the
same thing. `docker exec` and `kubectl exec` use `exec` for this action.

### `portful status`

Shows, for every configured repo: the active worktree, every running
server (worktree, branch, port, pid), and whether the proxy is running
and what it's currently routing to. A server whose `{<repo>.port}`
wiring has gone stale (see Tasks below) is marked inline, e.g.
`(stale wiring: api)`, and one whose worktree no longer exists is marked
`(worktree gone)`, with a reminder at the bottom to run `portful prune`
when that happens. `portful status --json` prints the same data as
machine-readable JSON instead: each server entry also gets a
`staleWiring` array and a `worktreeGone: true` field with the same
information (both omitted when they don't apply), e.g.:

```sh
portful status --json | jq '.repos[] | {name, active}'
```

It also lists any defined tasks (see
[Tasks (experimental)](#tasks-experimental) below).

### `portful list`

One row per repo: the address clients use, the worktree it currently
reaches, and whether the proxy is up. This is portless's `list`, and it
answers the one question that command answers: where does each route go
right now.

```
NAME   ADDRESS                TARGET             PROXY
api    http://127.0.0.1:3000  feature-x :3101    running
front  http://127.0.0.1:8080  main (no server)   stopped
```

`--json` prints the same rows as machine-readable JSON. `status` stays
the fuller per-repo view.

### `portful stop [repo]`

Stops the running server for the active (or given) worktree: sends
`SIGTERM` to its process group, then polls for up to 2 seconds to
confirm it actually exited before removing it from `portful status`. If
it's still alive after that, the entry is left in place and `stop` exits
`1` with a warning (see Limitations).

### `portful proxy start [repo]`

Starts the reverse proxy on the repo's `fixedPort`, in the foreground;
stop it with `Ctrl-C`. Every request is forwarded to whatever worktree is
currently active, re-read from disk on every request, so `portful use`
takes effect on the very next new connection, with the proxy left
running. Ordinary HTTP responses (including error responses) carry an
`X-Portful-Worktree` header naming the worktree that handled (or failed
to handle) the request. The WebSocket handshake response is the one
exception (see Limitations). If the active worktree has no server running,
the proxy returns `502` with a hint to run `portful serve`. If
`fixedPort` is already in use when starting, it prints the process
occupying it (via `lsof`) and exits. WebSocket and other Upgrade
requests are forwarded too (see Limitations for how that interacts
with `use`).

The foreground is deliberate, where portless runs a daemon: one tab per
proxy keeps the request log visible and makes `Ctrl-C` the stop button.
There is no `--foreground` flag, because a flag by that name would imply
a background default that does not exist.

### `portful proxy stop [repo]`

Stops a proxy started in another terminal: sends `SIGTERM` to it and
polls for up to 2 seconds to confirm it exited, the same way `stop` does
for a worktree server. Says so plainly, and exits 0, when no proxy is
running for that repo.

### `portful task ...`

Experimental multi-repo presets: see
[Tasks (experimental)](#tasks-experimental) below.

### `portful ui`

An interactive terminal UI: navigate every repo's worktrees (and any
defined tasks) with `j`/`k` or the arrow keys, and act on the selected row
without leaving the screen:

- `u`: set the active worktree (on a worktree row), or apply a task (on
  a task row). No-op on a repo row.
- Enter: toggles the selected row on/off. On a worktree row: stops its
  server if one's running, starts one otherwise. On a repo row: toggles
  the proxy, same as `p`. On a task row: applies the task, same as `u`
  (a task row has no on/off state to toggle).
- `s`: start a server for the selected worktree.
- `d`: same, but `--direct` (see `portful serve --direct` above), for
  poking at a worktree exactly as it'd run in production, no proxy.
- `x`: stop it.
- `r`: restart it (stop, then start, skipping the start if the stop
  timed out).
- `p`: toggle the proxy for that row's repo: stop it if running, start
  it otherwise.
- `q` / `Ctrl-C`: quit.

Each row's leading mark is `●` when it's running and `○` when it's not.
Right after starting or stopping a server or the proxy (`s`, `d`, `x`,
`r`, `p`, or either side of Enter), it shows `◐` instead until the next
automatic refresh actually observes the row in the state it's waiting
for, at which point it flips to `●` or `○` accordingly. It also gives up
when a timeout passes with nothing observed (15 seconds for a start, 5 for
a stop), falling back to the ordinary `●`/`○` indicator. A start or stop
failure is visible in the pane itself, or on the message line, so
`portful ui` just stops waiting rather than guessing why.

A server whose worktree no longer exists still gets a row (marked
`(worktree gone)`), so `x` can stop it right there instead of needing
`portful prune` separately.

The screen refreshes automatically every couple of seconds and right
after every action. `serve`/`proxy` are opened in a separate pane, tab,
or window (never in the same process as the UI itself), using whichever
multiplexer is available; with none detected, the command is printed for
you to run by hand instead. See "Opening panes from `portful ui`" for
how the multiplexer is chosen. Requires an interactive terminal (TTY).

### `portful whoami`

Reports which repo and worktree the current directory is in, as a single
line meant for embedding in a shell prompt or for an agent to confirm its
own footing: `api/feature-x port 3101 (running, active)`. The port is
omitted if that worktree has never been served, and `, active` only
appears if it's the repo's current active worktree. `--json` prints the
full detail (branch, path, running server, proxy routing) instead. Errors
and exits non-zero if the current directory isn't inside any registered
repo. Pair with `2>/dev/null` in a prompt to fail silently there.

Tip: `portful whoami 2>/dev/null` is safe to drop straight into `PS1`.

### `portful prune [repo]`

Cleans up state left behind by worktrees that no longer exist (removed
with `git worktree remove`, or manually deleted), reconciling
`state.json` against what `git worktree list` actually reports, for
every configured repo, or just the one named. For each worktree gone
that way: a running server is stopped (the same `SIGTERM`-then-poll
procedure as `portful stop`) before its entry is removed, its sticky
port assignment is removed, the repo's `active` pointer is cleared if
it pointed there, and any task with that worktree as a member has just
that member removed (the whole task if that empties it). `--dry-run`
(`-n`) prints what would change without touching anything; with
nothing to clean up, it prints a single `Nothing to prune.` line.

### `portful doctor`

A read-only diagnostic report, plain text and safe to paste somewhere
like Slack: portful's own version (with commit hash) plus Node and
platform, whether the config loads and each repo's path/git-ness/worktree
count, whether every `fixedPort` and sticky port's actual `lsof` LISTEN
state matches what `state.json` expects, any stale entries `portful
prune` would clean up, and which picker/multiplexer would be
auto-detected. Never crashes on a broken config (it reports that as a
finding instead) and exits non-zero if anything looks off, so it's
usable as a quick health check from a script.

### `portful clean`

Removes the state file: sticky port assignments, active pointers, and
task definitions. Refuses while a server or proxy is still recorded as
running, naming each one, since removing the file would leave those
processes alive with nothing tracking them. `--force` removes it anyway.

portless's `clean` also drops its CA trust and its `/etc/hosts` block.
portful installs neither, so state is the whole of what it owns.

### `portful help [command]`

Shows the same thing as `portful --help`; with a command name, shows that
command's own help (equivalent to `portful <command> --help`).

## Limitations and troubleshooting

Start with `portful doctor`: it's a quick, read-only pass over config,
ports, and state that catches most of what's below on its own.

- **WebSockets route on connect, not on switch.** An Upgrade request
  (Rails ActionCable, Vite/webpack HMR) is forwarded to whichever
  worktree is active at the moment it's opened, but an already-open
  connection doesn't move if `use` changes the active worktree
  afterward: only the next new connection picks it up. In practice
  this is rarely noticeable: ActionCable and HMR clients reconnect on
  their own, and land on the new worktree the moment they do. The 101
  handshake response is relayed as-is, so it does not carry an
  `X-Portful-Worktree` header the way ordinary HTTP responses do.
- **`status` reports process liveness, not reachability.** A server
  that failed to bind where portful expected (wrong port flag, wrong
  interface) still shows as running while the proxy answers 502. When
  `status` and reality disagree, `lsof -i :<port>` tells you who is
  actually listening.
- **Port probes can still be fooled.** The free-port check binds the
  IPv4 and IPv6 wildcard addresses, which catches a foreign process
  regardless of which interface it's on. What remains is the narrow
  window between that check and the new server's own bind: a sticky
  port stolen there can still make it die instantly with `EADDRINUSE`.
  If a server exits right within a couple of seconds of `portful serve`,
  the hint printed tells you whether the assigned port is now held by
  another process (per `lsof`) or whether this looks like the usual
  missing-`.env` / missing-`node_modules` case.
- **`stop` waits up to 2 seconds, then gives up loudly.** It sends
  `SIGTERM` and polls for the process to actually exit; if it's still
  alive after 2 seconds (traps `SIGTERM`, or is just shutting down
  slowly), its entry is deliberately kept: you'll keep seeing it in
  `portful status`, and `stop` exits `1` with a warning rather than
  silently pretending it worked.
- **Worktrees usually share a dev database.** Running branches with
  diverging migrations against the same database can break one of them;
  consider per-worktree database names if you switch heavily.
- **The proxy never verifies a backend's TLS certificate.** With
  `https.backend` set to `true`, requests to the worktree server go
  out over https, but certificate verification is deliberately skipped:
  mkcert's local CA isn't in Node's trust store, and this is loopback-only
  development traffic, so the friction of verifying it isn't worth it.
- **The `http://`/`https://` scheme in a `serve` template's
  `{<repo>.port}` reference is your responsibility.** portful substitutes
  only the port number; whether `API_URL=http://127.0.0.1:{api.port}`
  should actually read `https://` depends on how you set up `api`'s own
  `https` object, and portful has no way to check that for you.

## Shell completion

`portful completion` prints a completion script for the shell that's
running it. Completions are computed dynamically on every `<Tab>`, so
newly added repos or worktrees complete right away without reinstalling
anything:

- With nothing typed yet, it suggests command names (`use`, `serve`,
  `run`, `status`, `stop`, `proxy`, `task`, `ui`, `whoami`, `prune`,
  `doctor`, `help`, `completion`).
- As the first argument to `use`, `serve`, `stop`, `proxy`, or `run`, it
  suggests every repo name and every `repo/worktree` name, so
  `run <Tab>` lists them all and `run api/<Tab>` narrows to worktrees of
  `api`. As the first argument to `prune`, it suggests repo names only
  (no `repo/worktree` combos, since pruning targets a whole repo). As
  the argument to `help`, it suggests command names instead.
- After `task`, it suggests `add`/`use`/`list`/`rm`; after `task use` or
  `task rm`, it suggests defined task names. After `task add <name>`, it
  falls through to the same repo/worktree suggestions as `run` and the
  rest.
- Anywhere else, meaning a prefix that matches no repo or worktree
  (e.g. `run rails<Tab>`) or the second argument onward for any command
  (e.g. `run api bin/<Tab>`), it deliberately returns no matches, which lets
  the shell fall back to its normal file/command completion instead of
  getting stuck offering worktree names that can never apply.

zsh:

```sh
portful completion >> ~/.zshrc
```

bash:

```sh
portful completion >> ~/.bashrc
```

Open a new shell (or `source` the rc file) to pick it up. Only the
static script (which command names exist) lives in the rc file; the
suggestions themselves come from running `portful` on every `<Tab>`.

The zsh script initializes zsh's completion system itself (it calls
`compinit` if `compdef` isn't already available), so it works even in a
`.zshrc` that never calls `compinit` on its own.

## Opening panes from `portful ui`

When `portful ui` opens `serve` or `proxy` for a row (`s`/`d`/`r`/`p`, or
Enter's start side), it launches them as a separate foreground process in
a new pane, tab, or window, that is, the same kind of process a plain
`portful serve`/`portful proxy start` invocation would be, just started
for you. It picks how to open that pane in this order:

1. A `ui` object in the user-level `config.json`, if present, always wins:

   ```json
   { "ui": { "open": "my-launcher --name {title} {cmd}" } }
   ```

   `{title}`, `{cmd}`, and `{cwd}` are substituted (each shell-quoted for
   safety) and the result is run with `sh -c`, so this can point at any
   multiplexer or launcher whose CLI can open a new pane running a given
   command.
2. Otherwise, [herdr](https://herdr.dev) is used if it's detected (its
   `HERDR_ENV`/`HERDR_SOCKET_PATH` environment variables are set). Panes are
   arranged left to right to match the row order in `portful ui`'s own
   list, regardless of the order you actually open them in: opening row 3
   before row 1 still inserts row 1's pane to the left of row 3's.
3. Otherwise, [cmux](https://cmux.app) is used if it's detected
   (`CMUX_SOCKET_PATH`/`CMUX_WORKSPACE_ID` are set and `cmux` is on
   `$PATH`), a new workspace is opened without stealing focus.
4. Otherwise, [tmux](https://github.com/tmux/tmux) is used if detected
   (`$TMUX` is set): a new window is added to the current session.
5. Otherwise, `portful ui` prints the command to run by hand in another
   terminal, instead of opening anything.

Either way, the command run always references portful's own resolved
executable path directly, rather than a bare `portful` that depends on
`$PATH` being set up the same way in the new pane.

## herdr plugin

The repository doubles as a [herdr](https://herdr.dev) plugin
(`herdr-plugin.toml`), so herdr users can summon `portful ui` from any
pane as a temporary overlay: switch a worktree, hit `q`, and focus
returns to wherever you were.

```sh
herdr plugin install meganemura/portful  # from GitHub (runs npm install)
herdr plugin link /path/to/portful       # or a local checkout (npm install yourself)
```

This registers the action `portful.ui`. Try it once with
`herdr plugin action invoke portful.ui`, then bind it to a key in
herdr's own `config.toml`:

```toml
[[keys.command]]
key = "prefix+w"
type = "plugin_action"
command = "portful.ui"
description = "portful ui"
```

Opening `serve`/`proxy` from that overlay never splits whichever tab
you were actually working in: they land in one dedicated `portful`
tab in the current workspace instead, created the first time it's
needed. That tab keeps `portful ui` itself pinned across the top row,
with `serve`/`proxy` panes lined up side by side in the row below it,
in list order. The tab survives even once every server is stopped,
and the `portful ui` running inside it can open panes too: pressing
`s`/`d`/`p` there lands in the same row.

## Tasks (experimental)

Tasks are portful's advanced multi-repo layer. Everything above works
without them. The feature is experimental: expect its behavior to
change as real-world feedback comes in.

A single repo's worktrees only get you so far once a change spans more
than one repo (say, an `api` branch and the `front` branch that talks
to it). A **task** is a named preset that bundles one worktree per repo,
so the whole group switches together:

```sh
portful task add feature-x api/feature-x front/feature-x
portful task use feature-x
```

- `portful task add <name> [repo/worktree ...]` creates a task. Repos
  named explicitly use the given worktree; every other registered repo
  gets prompted for via the picker, with a leading option to leave that
  repo out of the task entirely.
- `portful task use <name>` validates every member's worktree still
  exists (if even one doesn't, nothing is applied and an error is
  reported), then switches all of them at once. Reports which members
  have no server running yet, and warns about any already-running
  server whose `{<repo>.port}` wiring no longer matches (see below).
- `portful task list` lists tasks and their members, marking with `*`
  any task whose members all match the current active worktrees.
- `portful task rm <name>` removes a task.

### How the wiring works

The fixed-port proxy in front of a service re-reads `state.json`
(portful's on-disk record of what's running) on every request, so *that*
part always reflects whichever worktree is currently active, no
restart needed.

A `serve` template's `{<repo>.port}` reference is different: it's
substituted once, into the literal shell command run when that server
starts, so it's fixed for as long as that process keeps running.
Switching `api`'s active worktree doesn't retroactively change what an
already-running `front` process is connected to. It keeps talking to
`api`'s old port until you restart it. This is exactly what `task use`
checks for: if a server is still running with `{<repo>.port}` wiring
that no longer matches, it prints a warning telling you to
`portful stop <repo> && portful serve <repo>` to pick up the new one. A
worktree that was never running in the first place picks up the correct
wiring automatically the first time you `serve` it.

Suppose `front` also has a checked-in `.env` that sets its own
`API_URL`. The `API_URL={api.port}` prefix in the `serve` template
still wins only if your framework's `.env` loader treats already-set
environment variables as authoritative and doesn't overwrite them,
the common default for most dotenv implementations, but worth
confirming once for your stack.

Because the proxy's host:port never changes across a switch, any
cookies your client already holds carry over automatically. Whether the
session they represent stays valid depends on whether the worktrees
involved share a session store (see the shared-dev-database note under
Limitations above).

## Development

```sh
npm install
npm test        # node:test; the suite never touches your real config or state
```

From a checkout the CLI runs the TypeScript in `src/` directly via tsx,
so an edit takes effect without a build. `npm run build` exists for
publishing alone: tsup bundles `src/cli.ts` and every dependency into a
single `dist/cli.js`, which is the only thing the npm package ships.
`npm run type-check` runs `tsc --noEmit`, and `prepublishOnly` runs the
type check, the tests, and the build in that order. `src/commands/*.ts` hold one subcommand handler each;
`src/proxy.ts` is the reverse-proxy implementation itself
(`src/commands/proxy.ts` is its thin CLI wrapper). `src/portRefs.ts`
resolves `{<repo>.port}` references, `src/tasks.ts` holds the wiring-
mismatch and task-matching logic, and `src/picker.ts` is the worktree
picker shared by `use` and `task add` (the `picker` command, else
auto-detected peco/fzf, else the numbered prompt). `src/overview.ts`
collects the data behind both `status` and `status --json`; `src/mux.ts`
implements the multiplexer adapters `portful ui` opens `serve`/`proxy start`
through; `src/ui/` holds `portful ui`'s row-model, key-dispatch, and
rendering logic (`src/commands/ui.ts` is its thin terminal/event-loop
wrapper). `src/prune.ts` detects state entries left behind by worktrees
that no longer exist, shared by `portful prune`, `portful doctor`'s
state section, and `status`/`ui`'s "(worktree gone)" marker. Runtime
state lives in `$XDG_STATE_HOME/portful/state.json` (default
`~/.local/state/portful/state.json`).

`src/dispatch.ts` holds the reserved command names and the rule that
decides whether a first word is a repo name or a command, kept out of
`src/cli.ts` because that module runs the CLI at import time.
`src/startCommand.ts` finds the `package.json` script and the package
manager for a worktree with no `serve` template. `src/config.ts` merges
the user-level `config.json` with each repo's own `portful.json` and
`package.json` key. `docs/portless-alignment.md` records which parts of
portless's surface this tool adopted, and why `alias` stays unadopted.

## License

MIT: see [LICENSE](LICENSE).

---

## Japanese

git worktree でブランチを並行開発していても、そのサーバを見るクライアント(たとえばフロントエンドの dev サーバ)が叩くポートはひとつです。
worktree を切り替えるたびに、いま動いているサーバを止めて、別の worktree で立ち上げ直すことになります。
`portful` はこの立て直しをなくすツールです。
worktree ごとにバックエンド(たとえば Rails アプリ)のサーバを別ポートで起動したままにします。
固定ポートで待ち受ける小さなリバースプロキシが、そのうち「アクティブ」な worktree にリクエストを転送します。
切り替えは次のリクエストから反映されます。
クライアントの再起動も `.env` の書き換えも `cd` も要りません。

名前は [portless](https://portless.sh/) への返答です。
portless はポート番号を `.localhost` の名前に置き換えますが、portful ではポートが主役です。
すべてのクライアントが見る固定ポートが 1 本あり、その後ろで worktree ごとにもう 1 本ずつ動きます。
同じことをする部分では portless のコマンドと設定の形をそのまま借りているので、portless を使っている人はもう一冊マニュアルを読まずに使えます。
[portless から来た人へ](#portless-から来た人へ)を参照してください。

direnv やシェルの alias のようなディレクトリ単位のツールが影響できるのは、これから起動するプロセスだけです。
すでに動いているクライアントの向き先は変えられません。
その「すでに動いているクライアントの向き先を変える」ことが、portful の存在理由です。

- いまいる worktree のサーバを起動: `portful`(= `portful run`)
- worktree を指定してサーバを起動: `portful serve api/feature-x`
- プロキシの向き先 worktree を切り替え: `portful use`
- 各固定ポートの現在の行き先を一覧: `portful list`
- worktree に `cd` せずに単発コマンドを実行: `portful exec`

## これが不要な人

- git worktree をそもそも使っていないなら、出番はありません。
- クライアント側を気軽に再起動できる、あるいは接続先を env 変数や設定ファイルから読み直せる構成なら、そのポートを直接向ければ済みます。
- 同時に動かす worktree が常にひとつだけなら、従来通り `cd` して立ち上げ直すだけで十分です。

## portless から来た人へ

[portless](https://github.com/vercel-labs/portless) はアプリごとに `.localhost` の名前を配り、ホスト名で転送先を決めます。
portful はリポジトリごとに固定ポートを 1 本持ち、いまアクティブな worktree で転送先を決めます。転送先はリクエストのたびに読み直します。
答えている問いが違うので、両方使う手もあります。portless の alias を portful の固定ポートに向ければ、名前は portless、切り替えは portful が担当します。

同じ意味のコマンドは同じ名前です:

| portless | portful |
| --- | --- |
| `portless` | `portful` |
| `portless run` | `portful run` |
| `portless <name> <cmd...>` | `portful <repo> <cmd...>` |
| `portless list` | `portful list` |
| `portless proxy start` / `stop` | `portful proxy start` / `stop` |
| `portless doctor` | `portful doctor` |
| `portless prune` | `portful prune` |
| `portless clean` | `portful clean` |
| `portless trust` | portful はプロキシに設定された証明書を使う |
| `portless hosts sync` / `hosts clean` | portful は設定された固定ポートを通して転送する |
| `portless service install` | プロキシごとに `portful proxy start` をターミナルで動かす |
| `portless proxy start --lan` / `--tailscale` / `--ngrok` | portful は loopback だけを bind する |
| `portless alias <name> <port>` | `portful use <repo>/<worktree>` は worktree を名前で選ぶ |
| 複数リポジトリの場面では portless の各 alias を切り替える | `portful task add` / `task use` はその組み合わせを保存して選ぶ |
| worktree のディレクトリへ移動してコマンドを実行する | `portful exec <repo>/<worktree> <cmd...>` |
| 各操作に対応する portless コマンドを使う | `portful ui` は対話型のターミナル画面を提供する |
| 現在のディレクトリと `portless list` からアプリを特定する | `portful whoami` は現在のリポジトリと worktree を表示する |
| portless を通さずにアプリを起動し、そのアプリが bind したポートで待つ | `portful serve --direct` は 1 回だけ、プロキシを挟まずに固定ポートを直接 bind する |

portless 側に加わるコマンドは、CA、hosts エントリ、サービス、ネットワーク公開など、マシンのリソースを設置または更新します。
portful 側では、加わるコマンドがいま使う worktree や複数リポジトリの組み合わせを選び、その中で操作します。

設定の置き方も同じです。リポジトリの中の `portful.json`、または `package.json` の `"portful"` キーを読み、優先順位も portless に合わせてあります。
子プロセスには `PORT`、`HOST`、`PORTFUL_URL` が渡るので、すでに `PORT` を読むサーバならテンプレートなしで起動します。

意図して違えてある点が 4 つあります。

- **アドレスは名前ではなくポートです。** これが目的そのものです。`http://127.0.0.1:3000` をすでに握っているクライアントは、切り替えをまたいでそのまま動き続けます。cookie も同じです。
- **特権ポートも CA も `/etc/hosts` も使いません。** portful が書くのは自分の設定ディレクトリと状態ディレクトリだけで、あとは設定したポートを bind するだけです。管理された会社の端末でも、管理者権限なしで動きます。
- **`proxy start` はフォアグラウンドで動きます。** プロキシ 1 本につきタブ 1 枚にすれば、リクエストログが見えたまま `Ctrl-C` が停止ボタンになります。
- **`alias` はありません。** portless では別のホスト名ルートを足すコマンドですが、ここでは「アクティブな worktree を無視する」という別の動作になってしまいます。portful が起動していないサーバに届かせたいときは `portful <repo> <cmd...>` が担当します。

どちらの道具でも、URL と cookie を保ったままクライアントの接続先を別の worktree へ切り替えられます。
portless では `portless list` を実行し、4000-4999 から割り当てられたポートを写して、`portless alias <name> <port> --force` を実行します。
portful では `portful use` が worktree 名を受け取り、そのポートを内部で解決します。

## 動作要件

- Node.js 24 以上(開発は Node 26 で実施)
- macOS または Linux(POSIX の `sh` とプロセスグループに依存し、ポート競合の診断に `lsof` を使います)
- `git`(worktree の列挙に `git worktree list` を使用)
- ピッカー([peco](https://github.com/peco/peco) / [fzf](https://github.com/junegunn/fzf))は任意。
  どちらかが `PATH` にあれば worktree の選択に自動で使われ、どちらも無ければ番号入力のプロンプトにフォールバックします

## インストール

```sh
npm install -g portful
```

配布しているのは依存を取り込んだ 1 ファイルなので、install で入るのはこのパッケージだけです。

チェックアウトから開発する場合:

```sh
git clone https://github.com/meganemura/portful.git
cd portful
npm install
./bin/portful.js <command>
```

この入口は [tsx](https://github.com/privatenumber/tsx) 経由で `src/` の TypeScript を直接実行するので、編集は次のコマンドから反映されます。ビルドは挟みません。
`npm link` すると `portful` という名前で `PATH` に入ります。

## クイックスタート

```sh
# 1. リポジトリを登録(マシンごとに一度。どのリポジトリがどこにあるか)
mkdir -p ~/.config/portful
cat > ~/.config/portful/config.json <<'JSON'
{ "repos": { "api": { "path": "~/work/api" } } }
JSON

# 2. リポジトリにポートを与える。このファイルはチェックアウトの中に置くので、
#    コミットすれば同じ設定が全員に渡る。
cat > ~/work/api/portful.json <<'JSON'
{
  "fixedPort": 3000,
  "portRange": [3101, 3199],
  "serve": "bundle exec rails s -p {port}"
}
JSON

# 3. worktree ごとにサーバを立ち上げておく(ターミナルのタブを分けてフォアグラウンドで)
portful serve api/feature-x
portful serve api/feature-y      # 別のタブで

# 4. 固定ポートにプロキシを立てる(さらに別のタブ、これもフォアグラウンド)
portful proxy start api

# 5. 固定ポートの向き先を好きなタイミングで切り替える
portful use api                  # ピッカーが開き、次のリクエストから反映
```

`PORT` 環境変数を読むサーバなら `serve` は要りません。
書かずにおけば、worktree の中で `portful` を打つだけで、そのプロジェクトの `dev` スクリプトが `PORT` 付きで起動します。

同じ流れを図にすると、次のようになります。
2回目のリクエストは、何も再起動せずに feature-y に届きます:

```mermaid
sequenceDiagram
    participant C as クライアント (常に :3000)
    participant P as portful プロキシ (:3000)
    participant X as api/feature-x (:3101)
    participant Y as api/feature-y (:3102)
    Note over X,Y: どちらも portful serve で起動済み
    C->>P: GET /todos
    P->>X: 転送 (アクティブ: feature-x)
    Note over C,Y: $ portful use api/feature-y(アクティブを切り替え)
    C->>P: GET /todos
    P->>Y: 転送 (転送先はリクエストごとに読み直し)
```

この図は通常の HTTP リクエストの場合です。
WebSocket 接続は、開いたときに一度だけルーティングされます(「制約とトラブルシューティング」参照)。

プロキシは使うときだけ起動すれば十分です。
起動していないあいだは `fixedPort` を何も占有せず、他のコマンドはそれまで通りに動きます。

## 設定

設定は portless と同じく 2 階層に分かれます。

**ユーザ階層のファイル**は `$XDG_CONFIG_HOME/portful/config.json`(未設定なら `~/.config/portful/config.json`)です。
どのリポジトリがあってチェックアウトがどこにあるかを登録します。これはリポジトリの中のファイルには書けない情報です:

```json
{
  "repos": {
    "api":   { "path": "~/work/api" },
    "front": { "path": "~/work/front" }
  },
  "picker": { "command": "fzf --height 40% --reverse" }
}
```

**リポジトリ階層のファイル**は、リポジトリ本体のチェックアウトに置く `portful.json`、または `package.json` の `"portful"` キーです。
プロジェクトに属する設定を持ちます:

```json
{
  "fixedPort": 3000,
  "portRange": [3101, 3199],
  "serve": "bundle exec rails s -p {port}"
}
```

優先順位はひとつの規則です。ユーザ階層のエントリがリポジトリ階層の両方に勝ち、`package.json` のキーが `portful.json` に勝ちます(portless と同じ)。
ポートはマシンごとに割り当てるものなので、手元のマシンがリポジトリの提案に勝ちます。

### キー

- `path`(ユーザ階層のみ)はリポジトリ本体のチェックアウトを指し、`~` 展開に対応します。
  portful は worktree を作りません。`git worktree add` で自分で追加してください。`git worktree list` に出るもの(本体のチェックアウトを含む)がすべて選択対象になります。
- `fixedPort` は他のサービスが常に叩くポートです。
- `portRange` は `[min, max]` で、各 worktree に割り当てるポートの範囲です。
- `serve` は省略できます。書いた場合は `sh -c` で実行され、`{port}` がその worktree に割り当てられたポートに置換されます。
  env 変数のプレフィックスも書けます(`"serve": "PORT={port} bin/dev"`)。
  書いた `serve` にはリテラルの `{port}` が必要です。無いと、サーバはフレームワークの既定ポートを bind する一方で、`status` とプロキシは割り当てたポートにいると信じ続けます。
- `script` は `serve` が無いときに実行する `package.json` のスクリプト名で、既定は `dev` です。
  パッケージマネージャは worktree のロックファイルから決めます。`pnpm-lock.yaml`、`yarn.lock`、`bun.lockb`、`package-lock.json` の順に見て、無ければ npm です。
- `serve` は `{<repo>.port}` で他の登録済みリポジトリのポートを参照できます。
  `front` のテンプレートを `"API_URL=http://127.0.0.1:{api.port} PORT={port} npm run dev"` にすると、`{api.port}` は `api` のアクティブな worktree が使っているポートに解決されます(まだ無ければ割り当てます)。
  複数リポジトリの worktree を結線したままにできるのはこの仕組みです。下の「タスク」に全体の流れがあります。
- `portful.json` に `name` を書く場合は、そのリポジトリを登録した名前と一致させてください。食い違うと、両方の名前を出して設定の読み込みに失敗します。

portful が起動するサーバには `PORT`、`HOST`、`PORTFUL_URL` が渡ります。
`PORTFUL_URL` はクライアントが使う固定ポートのアドレスで、その worktree 自身のポートではありません。

一度 `portful serve` したことのある worktree は、再起動をまたいで同じポートを使い続けます(sticky な割り当て)。
割り当て時にそのポートが埋まっていた場合だけ、`portRange` の次の空きポートを使います。
この占有チェックには限界があります(「制約」参照)。

設定を読み込む時点でリポジトリをまたいだポートの衝突を検査します。
2 つのリポジトリが同じ `fixedPort` を使うことはできず、`portRange` どうしも重なれません。
どのリポジトリの `fixedPort` も、どのリポジトリの `portRange`(自分自身のものを含む)にも入ってはいけません。
いずれも該当するリポジトリ名を挙げて、その場で読み込みに失敗します。

### https

すでに mkcert などの証明書で動いている worktree サーバのために、リポジトリは `https` オブジェクトを持てます:

```json
{
  "fixedPort": 3000,
  "portRange": [3101, 3199],
  "https": {
    "cert": "~/certs/localhost.pem",
    "key": "~/certs/localhost-key.pem",
    "backend": true
  }
}
```

- `cert`/`key` は固定ポートの listener 自体を TLS 終端します。
  mkcert が `localhost`/`127.0.0.1` 向けに発行したペアは、worktree のサーバがすでに信頼しているものと同じなので、そのまま指せることがほとんどです。
  両方を設定するか、両方省くかのどちらかです。どちらかのパスが存在しない、または読めない場合は、その場で設定の読み込みに失敗します。両方とも `path` と同じく `~` 展開に対応します。
- `backend`(既定 `false`)は、プロキシから worktree のサーバへの接続を http ではなく https にします。バックエンド自身が TLS 終端する構成向けです。
  `cert`/`key` とは独立です。平文 http の listener から https のバックエンドへも、TLS 終端する listener から平文 http のバックエンドへも、どの組み合わせでも動きます。
- `https` オブジェクトが無ければ、プロキシは平文 http で受けて平文 http で送ります。

portful は認証局を作りませんし、システムの信頼ストアにも触りません。すでに持っているペアを指してください。

### ピッカー

`use` と `task add` が worktree の選択に開くピッカーは、上のユーザ階層の `picker` オブジェクトで指定します。
候補行を stdin から読み、選ばれた行を stdout に出すコマンドなら何でも使えます。
未設定なら peco、次に fzf を自動検出し、どちらも無ければ番号入力のプロンプトになります。

設定ファイルが無い場合、`portful` はサンプルを表示して終了します。

## コマンド

ほとんどのコマンドは省略可能な `<repo>` または `<repo>/<worktree>` 引数を取ります。
`<repo>` だけならそのリポジトリの「アクティブ」な worktree が対象になります。
リポジトリ引数を省略した場合はカレントディレクトリから推測します(各リポジトリの本体チェックアウトと全 worktree に対して、シンボリックリンクを解決した上で照合します)。

### `portful` と `portful run`

いまいる worktree のサーバを起動します。portless と同じ形の入口です。
`portful` 単体は `portful run` と同じで、`portful run --name <repo>` ならリポジトリを推測せず名前で指定します。

何を実行するかは次の順です。リポジトリに `serve` テンプレートがあればそれ、無ければ `script`(既定 `dev`)が指す `package.json` のスクリプトを、worktree のロックファイルが示すパッケージマネージャ経由で実行します。
プロジェクトが定義していないスクリプト名を指した場合は、定義されているスクリプトの一覧を添えて報告します。

`run` は worktree をカレントディレクトリから取ります。
`serve` はリポジトリのアクティブポインタに従います。そのポインタこそこのツールが切り替えるためのものなので、2 つの動詞は別々の問いに答えます。

### `portful <repo> <cmd...>`

`serve` テンプレートの代わりに、渡したコマンドで `<repo>` のサーバを起動します。`portless <name> <cmd...>` と同じ形です:

```sh
portful api bundle exec rails s
portful api/feature-x npm run dev
```

worktree はカレントディレクトリから取ります。リポジトリの外にいる場合はアクティブポインタから取ります。
コマンドはシェルを介さず直接起動するので、引数は打ったとおりに届きます。ポートは `PORT` から読みます。

この節に挙がるコマンド名はすべて予約語です。`status` や `list` という名前のリポジトリは、位置引数の形ではなく `portful serve status` で指定してください。

### `portful use [repo]`

リポジトリの「アクティブ」な worktree を選びます。
`repo/worktree` 形式なら直接セットします。
`repo` だけ(または cwd から推測)ならピッカーが開きます。
ピッカーは `picker` で設定したコマンド、無ければ自動検出した peco か fzf、どれも無ければ番号選択のプロンプトです(「設定」参照)。
プロキシが稼働中なら、切り替えた瞬間から新しいアクティブ worktree にルーティングされます。
再起動は不要です。
その worktree のサーバがまだ起動していなければ、`use` は警告を出して `portful serve` の実行を促します。

### `portful serve [repo]`

アクティブな(または指定した)worktree のサーバを、その worktree のディレクトリで、割り当てポートを使ってフォアグラウンドで起動します。
すでにサーバが動いている worktree への重複起動は拒否します。
`SIGINT`/`SIGTERM` は子プロセスグループに転送されるので、`Ctrl-C` できれいに止まります。

`portful serve [repo] --direct` を付けると、`{port}` の置換値が通常の sticky ポートではなくリポジトリの `fixedPort` になります。
その worktree を、本番で bind されるのと同じ形でプロキシなしに動かすための、一時的な置き換えです。
sticky ポートの割り当ては一切変更しません。
リポジトリのプロキシがすでに稼働中なら拒否します(先に止めてください、そうしないと両方が `fixedPort` を取り合います)。
`fixedPort` をすでに他プロセスが占有している場合も拒否します(`portful proxy start` 自身の占有チェックと同じく `lsof` で表示します)。
起動したサーバのエントリは、`portful status`/`portful ui` にも通常のサーバと同じ形で表示され、ポートには `fixedPort` が記録されます。

### `portful exec [repo[/worktree]] <cmd...>`

worktree のディレクトリの中で任意のコマンドを実行します。
自分で `cd` する必要はありません。
たとえば `portful exec api bin/rails console`、そのリポジトリの中にいるなら単に `portful exec bin/rails console` と書けます。
内側のコマンドのフラグは一切加工されずに素通しされます(`exec` については `portful` はオプションパースを一切しません)。
`portful exec api bin/rails s -p 3105` は、手で実行したのと完全に同じように動きます。
対象 worktree がリポジトリの「アクティブ」な worktree から決まった場合(repo を省略した、または `/worktree` を付けずにリポジトリ名だけで指定した場合)、cwd がそのリポジトリの**別の** worktree の中にあると、`exec` と `serve` は実行前に標準エラーへ1行警告を出します。
`repo/worktree` を明示的に指定すれば、その選択は意図的なものとみなされ警告は出ません。

名前が `run` ではなく `exec` なのは、portless の `run` が「プロキシ経由でアプリを起動する」という意味を持っており、portful の `run` も同じ意味だからです。
`docker exec` や `kubectl exec` がこの動作に `exec` を使っています。

### `portful status`

設定済みの各リポジトリについて、アクティブな worktree、稼働中の全サーバ(worktree、ブランチ、ポート、pid)、プロキシの稼働状況と現在の転送先を表示します。
`{<repo>.port}` の結線が古くなっているサーバには `(stale wiring: api)` のように印が付きます(下の「タスク (experimental)」参照)。
worktree 自体が無くなったサーバには `(worktree gone)` の印が付き、その場合は末尾に `portful prune` を促す一行が出ます。
`portful status --json` は同じ内容を機械可読な JSON として出力します。
各サーバのエントリには同じ情報を持つ `staleWiring` 配列と `worktreeGone: true` フィールドも付きます(どちらも該当しなければ省略されます):

```sh
portful status --json | jq '.repos[] | {name, active}'
```

定義済みのタスクも一覧します(下の「タスク (experimental)」を参照)。

### `portful list`

リポジトリごとに 1 行。クライアントが使うアドレス、いま届く worktree、プロキシが上がっているかを表示します。
portless の `list` にあたるもので、あのコマンドが答える問い、つまり「各ルートはいまどこへ行くのか」に答えます。

```
NAME   ADDRESS                TARGET             PROXY
api    http://127.0.0.1:3000  feature-x :3101    running
front  http://127.0.0.1:8080  main (no server)   stopped
```

`--json` は同じ行を機械可読な JSON で出します。より詳しいリポジトリ単位の表示は `status` のままです。

### `portful stop [repo]`

アクティブな(または指定した)worktree のサーバを停止します。
プロセスグループに `SIGTERM` を送った後、実際に終了したことを最大2秒ポーリングで確認してから、`portful status` の一覧から取り除きます。
それでも生きていれば、エントリはそのまま残し、`stop` は警告付きで exit 1 になります(「制約とトラブルシューティング」参照)。

### `portful proxy start [repo]`

リポジトリの `fixedPort` でリバースプロキシをフォアグラウンド起動します。
停止は `Ctrl-C` です。
すべてのリクエストは、その時点でアクティブな worktree に転送されます。
転送先はリクエストごとにディスクから読み直されるため、`portful use` は次の新規接続から反映され、プロキシは起動しっぱなしで構いません。
通常の HTTP レスポンス(エラーレスポンスを含む)には、処理した(あるいは処理に失敗した)worktree 名を示す `X-Portful-Worktree` ヘッダが付きます。
唯一の例外は WebSocket のハンドシェイクです(「制約とトラブルシューティング」参照)。
アクティブな worktree のサーバが動いていなければ、プロキシは `502` と `portful serve` を促すヒントを返します。
起動時に `fixedPort` が使用中なら、占有しているプロセスを(`lsof` で)表示して終了します。
WebSocket などの upgrade リクエストも転送します。
`use` との関係は「制約とトラブルシューティング」を参照してください。

フォアグラウンドなのは意図的です(portless はデーモンです)。
プロキシ 1 本につきタブ 1 枚にすれば、リクエストログが見えたまま `Ctrl-C` が停止ボタンになります。
`--foreground` フラグは用意していません。その名前のフラグは、存在しないバックグラウンド既定があることを匂わせてしまうからです。

### `portful proxy stop [repo]`

別のターミナルで起動したプロキシを停止します。
`SIGTERM` を送り、最大2秒ポーリングして終了を確認します。worktree のサーバに対する `stop` と同じやり方です。
そのリポジトリのプロキシが動いていなければ、そう伝えて exit 0 になります。

### `portful task ...`

experimental な複数リポジトリ向けプリセットです。
下の「タスク (experimental)」を参照してください。

### `portful ui`

対話的なターミナル UI です。
`j`/`k` または矢印キーで各リポジトリの worktree(と定義済みのタスク)の一覧を移動し、画面を離れずに選択中の行に対して操作できます:

- **`u`**：worktree の行ならそのアクティブ worktree をセットします。
  タスクの行ならそのタスクを適用します。
  repo の行では何もしません。
- **Enter**：選択中の行を on/off でトグルします。
  worktree の行では、サーバが稼働中なら停止、していなければ起動します。
  repo の行では、`p` と同じくプロキシをトグルします。
  タスクの行では、`u` と同じくそのタスクを適用します(タスクの行に on/off の状態はありません)。
- **`s`**：選択中の worktree のサーバを起動します。
- **`d`**：同じですが `--direct` 付きです(上の `portful serve --direct` を参照)。
  本番と同じ形でプロキシなしに触ってみたいときに使います。
- **`x`**：停止します。
- **`r`**：再起動します(停止してから起動。停止がタイムアウトした場合は起動しません)。
- **`p`**：その行のリポジトリのプロキシをトグルします。稼働中なら停止、停止中なら起動します。
- **`q` / `Ctrl-C`**：終了します。

各行の先頭の印は、稼働中なら `●`、停止中なら `○` です。
サーバやプロキシを起動または停止した直後(`s`、`d`、`x`、`r`、`p`、または Enter のどちら側)は、代わりに `◐` になります。
次の自動更新でその行が待っている状態(起動なら稼働中、停止なら非稼働)を実際に確認できれば `●` または `○` に変わります。
確認できないままタイムアウトしても(起動は15秒、停止は5秒)、同じく通常の `●`/`○` に戻ります。
起動や停止の失敗はペイン自体やメッセージ行に表示されるので、`portful ui` は理由を推測せずただ待つのをやめるだけです。

worktree 自体が無くなったサーバにも行が表示されます(`(worktree gone)` の印付き)。
`portful prune` を別途実行しなくても、その場で `x` を押して停止できます。

画面は数秒おきに自動更新され、各操作の直後にも更新されます。
`serve`/`proxy` は常に UI 自身とは別のプロセスとして、別のペイン、タブ、ウィンドウで開かれます。
どのマルチプレクサで開くかは「`portful ui` からのペインの開き方」を参照してください。
対話的なターミナル(TTY)が必要です。

### `portful whoami`

カレントディレクトリがどのリポジトリのどの worktree に属しているかを1行で報告します。
シェルのプロンプトへの埋め込みや、エージェントが自分の作業場所を確認する用途を想定しています。
例: `api/feature-x port 3101 (running, active)`。
その worktree が一度も serve されていなければポート部分は省略されます。
そのリポジトリの現在のアクティブ worktree でなければ `, active` は付きません。
`--json` を付けると詳細情報(ブランチ、パス、稼働中サーバ、プロキシの転送先)を出力します。
カレントディレクトリが登録済みリポジトリのどれにも属していなければエラーになり、exit 1 で終了します。
プロンプトに埋め込む場合は `2>/dev/null` を付けて黙らせられます。

Tip: `portful whoami 2>/dev/null` はそのまま `PS1` に埋め込めます。

### `portful prune [repo]`

もう存在しない worktree(`git worktree remove` で消した、あるいは手動で削除した)が残した state を掃除します。
`state.json` を実際の `git worktree list` の結果と突き合わせ、対象は指定した1リポジトリ、省略時は全リポジトリです。
消えた worktree について次を行います。
稼働中のサーバがあれば(`portful stop` と同じ、`SIGTERM` を送って終了をポーリングする手順で)停止してからエントリを削除します。
sticky なポート割り当てを削除します。
リポジトリの `active` ポインタがその worktree を指していればクリアします。
その worktree をメンバーに持つタスクがあれば、そのメンバーだけを外します(空になったタスクは削除します)。
`--dry-run`(`-n`)を付けると、何も変更せずに変更予定の内容だけを表示します。
掃除するものが無ければ `Nothing to prune.` の一行だけ表示します。

### `portful doctor`

読み取り専用の診断レポートです。
プレーンテキストなので、Slack などにそのまま貼り付けられます。
portful 自身のバージョン(commit hash 付き)、Node と platform、設定が読み込めるかと各リポジトリのパス・git リポジトリかどうか・worktree 数、各 `fixedPort` と sticky ポートについて実際の `lsof` の LISTEN 状況が `state.json` の想定と一致しているか、`portful prune` が掃除するはずの stale なエントリの有無、自動検出されるピッカーとマルチプレクサを出力します。
設定が壊れていてもクラッシュせず、その事実自体を診断結果として報告します。
何か問題があれば exit 1、無ければ exit 0 になるため、スクリプトからの簡易ヘルスチェックにも使えます。

### `portful clean`

状態ファイルを削除します。sticky なポート割り当て、アクティブポインタ、タスク定義が対象です。
サーバやプロキシが稼働中として記録されている間は、それぞれの名前を挙げて拒否します。
削除するとそれらのプロセスが、追跡するものが無いまま生き残ってしまうからです。`--force` を付ければ削除します。

portless の `clean` は CA の信頼と `/etc/hosts` のブロックも削除しますが、portful はどちらも作らないので、状態ファイルが持ち物のすべてです。

### `portful help [command]`

`portful --help` と同じ内容を表示します。
コマンド名を付けると、そのコマンド自体のヘルプ(`portful <command> --help` 相当)を表示します。

## 制約とトラブルシューティング

まず `portful doctor` を実行してください。
設定・ポート・state を読み取り専用でひと通り確認するだけで、下記のほとんどの原因が分かります。

- **WebSocket は接続時にルーティングされ、切り替え時には動かない。**
  upgrade リクエスト(Rails ActionCable、Vite/webpack の HMR)は、接続が開かれた時点でアクティブな worktree に転送されます。
  確立済みの接続は `use` で切り替えても移動せず、次の新規接続から新しい worktree に反映されます。
  実際には ActionCable や HMR のクライアントは自分で再接続するため、再接続した瞬間に新しい worktree に繋がり、ほとんど気になりません。
  101 のハンドシェイクレスポンスはそのまま中継されるため、通常の HTTP レスポンスと違い `X-Portful-Worktree` ヘッダは付きません。
- **`status` が報告するのはプロセスの生存であって、疎通ではない。**
  想定と違うポートやインターフェースに bind してしまったサーバは、稼働中と表示されたままプロキシは 502 を返します。
  `status` と現実が食い違うときは、`lsof -i :<port>` で実際に listen しているプロセスを確認してください。
- **ポートの空きチェックはすり抜けられることがある。**
  空きの確認は IPv4/IPv6 のワイルドカードアドレスへの bind で行うため、インターフェースを問わず他プロセスを検知できます。
  それでも、チェックの直後、新しいサーバが bind するまでのわずかな時間差は残ります。
  この間に sticky ポートを他プロセスに奪われると、新しいサーバは `EADDRINUSE` で即死することがあります。
  `portful serve` の直後に数秒以内でサーバが落ちる場合、表示されるヒントが「割り当てポートが(`lsof` によれば)他プロセスに握られている」のか「定番の `.env` / `node_modules` の未コピーらしい」のかを教えてくれます。
- **`stop` は最大2秒待ってから諦める。**
  `SIGTERM` を送った後、実際にプロセスが終了するまでポーリングします。
  2秒経っても生きていれば(`SIGTERM` をトラップしている、あるいは単に終了処理が遅い)、あえて `portful status` の一覧に残したままにします。
  `stop` は成功したふりをせず、警告付きで exit 1 になります。
- **worktree 間で開発用データベースを共有しがち。**
  マイグレーションが分岐したブランチ同士を同じデータベースに向けて動かすと、どちらかが壊れ得ます。
  頻繁に切り替えるなら worktree ごとのデータベース名を検討してください。
- **転送先の TLS 証明書は検証しない。**
  `https.backend` を `true` にすると、worktree のサーバへのリクエストは https で送られますが、証明書の検証はあえて省いています。
  mkcert のローカル CA は Node の信頼ストアに入っておらず、この通信は loopback に閉じた開発用途なので、検証の手間に見合わないためです。
- **`serve` テンプレートの `{<repo>.port}` を使う URL のスキーム(`http://` か `https://`)は設定側の責任。**
  portful が置換するのはポート番号だけです。
  `API_URL=http://127.0.0.1:{api.port}` を `https://` にすべきかどうかは `api` 自身の `https` の設定次第で、portful 側で検証することはできません。

## シェル補完

`portful completion` は、実行しているシェルに合わせた補完スクリプトを出力します。
補完候補は `<Tab>` のたびに動的に計算されるため、リポジトリや worktree を後から追加しても、再インストールなしで即座に補完されます:

- 何も入力していない状態では、コマンド名(`use`、`serve`、`run`、`status`、`stop`、`proxy`、`task`、`ui`、`whoami`、`prune`、`doctor`、`help`、`completion`)を提案します。
- `use`、`serve`、`stop`、`proxy`、`run` の第1引数では、すべてのリポジトリ名と `repo/worktree` 名を提案します。
  `run <Tab>` で全候補が並び、`run api/<Tab>` で `api` の worktree に絞り込まれます。
  `prune` の第1引数では、リポジトリ名のみを提案します(prune はリポジトリ単位が対象なので `repo/worktree` の形式は出しません)。
  `help` の引数ではコマンド名を提案します。
- `task` の後は `add`/`use`/`list`/`rm` を、`task use` や `task rm` の後は定義済みのタスク名を提案します。
  `task add <name>` の後は、`run` などと同じ repo/worktree の候補にフォールバックします。
- それ以外の位置では、意図的に候補を返しません。
  どのリポジトリにも worktree にも前方一致しない語(例: `run rails<Tab>`)や、どのコマンドでも第2引数以降(例: `run api bin/<Tab>`)がこれに当たります。
  候補が空ならシェルは通常のファイル/コマンド補完にフォールバックするので、決して当てはまらない worktree 名を提案し続けることがなくなります。

zsh:

```sh
portful completion >> ~/.zshrc
```

bash:

```sh
portful completion >> ~/.bashrc
```

新しいシェルを開く(か rc ファイルを `source` する)と有効になります。
rc ファイルに追記されるのは「どのコマンド名が存在するか」という静的なスクリプトだけで、リポジトリと worktree の候補は `<Tab>` のたびに計算し直されます。

zsh 用スクリプトは zsh の補完システムを自前で初期化します(`compdef` が未定義なら `compinit` を呼びます)。
そのため、`compinit` を一度も呼ばない `.zshrc` でもそのまま動きます。

## `portful ui` からのペインの開き方

`portful ui` が行に対して `serve`/`proxy` を開くとき(`s`/`d`/`r`/`p`、または Enter の起動側)、常に別のペイン、タブ、ウィンドウの中でフォアグラウンドプロセスとして起動します。
手元で `portful serve` や `portful proxy start` を実行するのと同じ種類のプロセスを、代わりに起動してくれるだけです。
開き方は次の順番で決まります:

1. ユーザ階層の `config.json` に `ui` オブジェクトがあれば、それが常に優先されます:

   ```json
   { "ui": { "open": "my-launcher --name {title} {cmd}" } }
   ```

   `{title}`、`{cmd}`、`{cwd}` が(それぞれ安全にシェルクォートされた上で)置換され、その結果が `sh -c` で実行されます。
   そのため、「ラベル付きの新しいペインで指定コマンドを実行できる」CLI を持つマルチプレクサやランチャーであれば何でも指定できます。
2. それが無ければ、[herdr](https://herdr.dev) が検出された場合はそれを使います(`HERDR_ENV`/`HERDR_SOCKET_PATH` 環境変数が設定されている場合)。
   ペインは `portful ui` のリストの並び順に合わせて左から右へ配置され、実際に開いた順番には左右されません。
   たとえば3行目を1行目より先に開いても、1行目のペインは3行目のペインより左に挿入されます。
3. それも無ければ、[cmux](https://cmux.app) が検出された場合はそれを使います(`CMUX_SOCKET_PATH`/`CMUX_WORKSPACE_ID` が設定されていて `cmux` が `$PATH` にある場合)。
   フォーカスを奪わずに新しい workspace を開きます。
4. それも無ければ、[tmux](https://github.com/tmux/tmux) が検出された場合はそれを使います(`$TMUX` が設定されている場合)。
   現在のセッションに新しいウィンドウを追加します。
5. どれも無ければ、`portful ui` は何も開かず、代わりに手元の別ターミナルで実行すべきコマンドを表示します。

いずれの場合も、実行されるコマンドは常に portful 自身の解決済み実行ファイルパスを直接参照します。
新しいペインで `$PATH` が同じように設定されているとは限らないため、単に `portful` と書く呼び出しには依存しません。

## herdr プラグイン

このリポジトリは [herdr](https://herdr.dev) のプラグイン(`herdr-plugin.toml`)を兼ねています。
herdr 上なら、どのペインからでも `portful ui` を一時的なオーバーレイとして呼び出せます。
worktree を切り替えて `q` で閉じれば、フォーカスは元のペインに戻ります。

```sh
herdr plugin install meganemura/portful  # GitHub から(npm install も実行されます)
herdr plugin link /path/to/portful       # ローカルのチェックアウトから(npm install は自分で)
```

これで `portful.ui` というアクションが登録されます。
まず `herdr plugin action invoke portful.ui` で一度動きを確かめ、herdr 側の `config.toml` でキーに割り当ててください。

```toml
[[keys.command]]
key = "prefix+w"
type = "plugin_action"
command = "portful.ui"
description = "portful ui"
```

このオーバーレイから `serve`/`proxy` を開いても、作業中だったタブは分割されません。
同じワークスペース内の専用の `portful` タブに集約され、そのタブは初めて必要になったタイミングで作成されます。
そのタブは上段に `portful ui` 自身が常駐し、下段に `serve`/`proxy` のペインがリストの並び順で横に並びます。
サーバが全部止まってもタブごと消えることはなく、そのタブ内の `portful ui` からもサーバを操作できます。
タブ内の `portful ui` から `s`/`d`/`p` を押して開いた場合も、同じ下段に並びます。

## タスク (experimental)

タスクは portful の発展的な複数リポジトリ向けレイヤーで、ここまでの機能はタスク無しで完結します。
この機能は experimental であり、実際の使用感のフィードバックによって挙動が変わる可能性があります。

変更が複数リポジトリにまたがるようになると、単一リポジトリの worktree だけでは足りません。
たとえば `api` のあるブランチと、それを呼ぶ `front` のブランチのような組み合わせです。
**タスク**はリポジトリごとにひとつの worktree を束ねた名前付きプリセットで、グループ全体をまとめて切り替えられます:

```sh
portful task add feature-x api/feature-x front/feature-x
portful task use feature-x
```

- `portful task add <name> [repo/worktree ...]` はタスクを作成します。
  明示的に指定したリポジトリはその worktree を使い、指定しなかった登録済みリポジトリはそれぞれについてピッカーで選択を促されます(先頭に「このリポジトリをタスクに含めない」選択肢があります)。
- `portful task use <name>` はまず全メンバーの worktree がまだ存在するか検証し、ひとつでも欠けていれば何も適用せずエラーにします。
  検証後、全メンバーを一括で切り替え、どのメンバーがまだ `portful serve` されていないかを報告し、起動中のサーバの `{<repo>.port}` の結線が古くなっていないかも警告します(下記参照)。
- `portful task list` はタスクとそのメンバーを一覧し、全メンバーが現在のアクティブ worktree と一致するタスクには `*` を付けます。
- `portful task rm <name>` はタスクを削除します。

### 結線の仕組み

では、`front` と `api` の結線はどう保たれるのでしょうか。
サービスの手前に立つ固定ポートのプロキシは、稼働状況を記録したファイル(`state.json`)をリクエストごとに読み直します。
その部分は常に現在アクティブな worktree を反映するので、再起動は不要です。

一方、`serve` テンプレートの `{<repo>.port}` 参照は違います。
これはサーバ起動時に実行される具体的なシェルコマンドへ一度だけ置換されるため、そのプロセスが動き続けている限り固定されたままです。
`api` のアクティブ worktree を切り替えても、すでに動いている `front` のプロセスの接続先は自動的には変わらず、再起動するまで `api` の古いポートを叩き続けます。
`task use` がチェックしているのは、まさにこの状態です。
`{<repo>.port}` の結線がもう一致しないサーバが動いていれば、`portful stop <repo> && portful serve <repo>` で結線し直すよう警告します。
まだ一度も動いていない worktree は、初めて `serve` したときに自動的に正しい結線になります。

`front` にコミット済みの `.env` があり、そこに `API_URL` が定義されているとしましょう。
この場合でも `serve` テンプレートの `API_URL={api.port}` が優先されるのは、フレームワークの `.env` ローダーが「既に設定済みの環境変数は上書きしない」実装であるときだけです。
ほとんどの dotenv 実装ではそれがデフォルト挙動ですが、自分のスタックで一度確認しておく価値はあります。

プロキシの host:port は切り替えても変わらないため、クライアントが持っている Cookie はそのまま引き継がれます。
それが表すセッションが有効なままかどうかは、関係する worktree 同士がセッションストアを共有しているかどうか次第です。
上の「制約とトラブルシューティング」にある開発用データベース共有の注記を参照してください。

## 開発

```sh
npm install
npm test        # node:test。テストが実際の設定や state に触れることはありません
```

チェックアウトから動かす場合、CLI は tsx 経由で `src/` の TypeScript を直接実行するので、編集にビルドは要りません。
`npm run build` は publish のためだけにあります。tsup が `src/cli.ts` と依存をまとめて 1 つの `dist/cli.js` にし、npm パッケージが配るのはそれだけです。
`npm run type-check` は `tsc --noEmit`、`prepublishOnly` は type-check・テスト・ビルドをこの順で走らせます。
`src/commands/*.ts` が各サブコマンドのハンドラで、`src/proxy.ts` がリバースプロキシの実装本体です(`src/commands/proxy.ts` はその薄い CLI ラッパー)。
`src/portRefs.ts` が `{<repo>.port}` の解決、`src/tasks.ts` が結線ズレ検知とタスクの一致判定ロジック、`src/picker.ts` が `use` と `task add` で共有するピッカー(`picker` の設定、無ければ peco/fzf の自動検出、それも無ければ番号選択)です。
`src/overview.ts` が `status`/`status --json` 双方の元データを集約します。
`src/mux.ts` が `portful ui` の `serve`/`proxy` 起動に使うマルチプレクサアダプタの実装、`src/ui/` が `portful ui` の行モデル、キー処理、描画のロジックです(`src/commands/ui.ts` はその薄いターミナル/イベントループラッパー)。
`src/prune.ts` はもう存在しない worktree が残した state エントリの検出ロジックで、`portful prune`、`portful doctor` の state セクション、`status`/`ui` の `(worktree gone)` 印で共有しています。
実行時の state は `$XDG_STATE_HOME/portful/state.json`(デフォルトは `~/.local/state/portful/state.json`)に置かれます。

`src/dispatch.ts` は予約コマンド名と、最初の語がリポジトリ名かコマンドかを判定する規則を持ちます。
`src/cli.ts` は import した時点で CLI 本体が走るので、そこから切り出してあります。
`src/startCommand.ts` は `serve` テンプレートが無い worktree について、`package.json` のスクリプトとパッケージマネージャを見つけます。
`src/config.ts` はユーザ階層の `config.json` と、各リポジトリの `portful.json` および `package.json` のキーをマージします。
`docs/portless-alignment.md` に、portless の表面のどこを採り、なぜ `alias` を採らなかったかを記録しています。

## ライセンス

MIT です。
[LICENSE](LICENSE) を参照してください。
