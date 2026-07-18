# wtshunt

`wtshunt` lets one service (say, a frontend dev server) keep hitting a
fixed port for a backend (say, a Rails app) while you juggle several git
worktrees of that backend at once. Each worktree gets its own backend
server on its own port; a small reverse proxy sits on the fixed port and
forwards to whichever worktree is currently "active." Switching worktrees
is instant — no restarting the frontend, no editing `.env`, no `cd`.

- Start a server for a worktree in the foreground: `wtshunt serve`
- Run one-off commands inside a worktree without `cd`-ing there: `wtshunt run`
- Flip which worktree the proxy points at: `wtshunt use`
- See what's running across every worktree: `wtshunt status`

## Install

```sh
npm install
npm link
```

`npm link` puts a `wtshunt` executable on your `PATH` (backed by
[tsx](https://github.com/privatenumber/tsx), so no build step is needed —
edits to `src/` take effect immediately).

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

- `path` supports `~` expansion.
- `serve` is run with `sh -c`, with `{port}` substituted for the port
  assigned to that worktree. This means env-var prefixes work too, e.g.
  `serve = "PORT={port} bin/dev"`.
- Each worktree that ever gets a `wtshunt serve` keeps the same port
  across restarts (a "sticky" assignment), unless that port is taken by
  something else, in which case the next free port in `port_range` is
  used.

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

Stops the running server for the active (or given) worktree.

### `wtshunt proxy [repo]`

Starts the reverse proxy on the repo's `fixed_port`, in the foreground.
Every request is forwarded to whatever worktree is currently active,
re-read from disk on every request — so `wtshunt use` takes effect on the
very next request, with the proxy left running. Responses (including
error responses) carry an `X-Wtshunt-Worktree` header naming the worktree
that handled (or failed to handle) the request. If the active worktree
has no server running, the proxy returns `502` with a hint to run
`wtshunt serve`. If `fixed_port` is already in use when starting, it
prints the process occupying it (via `lsof`) and exits.

### `wtshunt help [command]`

Shows the same thing as `wtshunt --help`; with a command name, shows that
command's own help (equivalent to `wtshunt <command> --help`).

## Shell completion

`wtshunt completion` prints a completion script for the shell that's
running it. It suggests command names, then registered repo names, then
`repo/worktree` names — regenerated dynamically each time, so newly added
worktrees complete right away without reinstalling anything.

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
