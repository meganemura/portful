# How the surface relates to portless

## Why it looks like this

portless (vercel-labs) gives local dev servers stable `.localhost` names.
It has an install base and a command vocabulary that developers already
carry in their fingers. portful solves a different problem: it keeps one
address fixed and swaps what sits behind it. The two problems are
separate, so a developer can want both.

portful therefore reuses portless's surface wherever the two tools do the
same thing. A developer who knows portless reads portful without a second
manual. Where portful does something portless leaves alone, it adds a
verb rather than redefining one of portless's.

Source for every portless detail below: the portless README at
`vercel-labs/portless`, read on 2026-08-22.

## Command mapping

| portless | portful | note |
| --- | --- | --- |
| `portless` | `portful` | starts the worktree you are standing in |
| `run` | `run` | runs the repo's script or serve template |
| `<name> <cmd...>` | `<repo> <cmd...>` | the worktree comes from the current directory, as portless does |
| `list` | `list` | routes in portless's shape: name, target, port |
| `proxy start` / `proxy stop` | `proxy start` / `proxy stop` | portful's runs in the foreground |
| `doctor` | `doctor` | same meaning |
| `prune` | `prune` | same meaning: clean up orphans |
| `clean` | `clean` | portful owns only a state file, so that is all it removes |
| (portless has no fixed address to point) | `use <repo>/<worktree>` | the verb portful exists for |
| (portless names each worktree separately) | `task add` / `task use` | one preset bundling a worktree from each of several repos |
| change to the worktree directory and run the command | `exec <repo> <cmd...>` | see "The `run` collision" |
| `service status` | `status` | the per-repo view: active worktree, servers, proxy |
| use the individual commands | `ui` | an interactive terminal list |
| read the directory, then `portless list` | `whoami` | which repo and worktree the current directory is in |
| `trust`, `hosts sync`, `service install`, `proxy start --lan` | (portful configures none of these) | see "What stays different" |

portless reserves `run`, `get`, `alias`, `hosts`, `list`, `doctor`,
`trust`, `clean`, `prune`, `proxy`, and `service` so they stay usable as
subcommands next to the `<name> <cmd>` positional form. portful takes the
same reservation, plus `serve`, `use`, `task`, `stop`, `status`, `exec`,
`ui`, `whoami`, and `completion`.

### `alias` is deliberately not adopted

portless's `alias <name> <port>` adds one more hostname route to a proxy
that routes by hostname. portful's proxy routes by active worktree on a
fixed port, so the same word here would have to mean "pin this port to a
literal number and ignore the active worktree", which is a different
action. A shared vocabulary earns its keep only while a shared word means
a shared thing, so this one stays unused. Reaching a server portful did
not start is what `portful <repo> <cmd...>` and a plain `serve` template
already cover.

### The `run` collision

portless `run` infers the app name and runs the package script through
the proxy. portful's `run` does the same thing, so the verb for "run an
arbitrary command inside a worktree" is `exec`. Two tools that share a
vocabulary must not give the same word two meanings. `docker exec` and
`kubectl exec` already use `exec` for "run a command inside a context
that exists", which is what the command does.

### `serve` and `run` answer different questions

`run` takes the worktree from the current directory, because that is
where portless starts an app. `serve` follows the repo's active pointer,
which is the pointer portful exists to switch.

## Config

Config lives at two levels, the way portless splits its own.

The user-level `config.json` registers which repos exist and where their
checkouts are, which no file inside a repo can state about itself. It
also holds `ui` and `picker`, which describe the machine.

Each repo's own `portful.json`, or a `"portful"` key in its
`package.json`, holds what belongs to the project. portless reads
`portless.json` and a `"portless"` key in the same places.

Precedence is one rule: the user-level entry wins over both repo-level
sources, and the `package.json` key wins over `portful.json`, matching
portless. The machine owner beats the repo's suggestion, because ports
are allocated per machine.

Keys portful shares with portless:

- `name`: the repo's name, which must match the name it is registered under
- `script`: the `package.json` script to run when no `serve` template is set

Keys portful adds, because portless has no fixed address to configure:

- `fixedPort`: the port every client keeps talking to
- `portRange`: the ports handed out to individual worktrees
- `serve`: a shell template for servers that need the port on the command
  line rather than in `PORT`
- `https`: a `cert`, `key`, and `backend` triple

Two things do not fit inside one repo's file, so they stay at the user
level: the registry that maps a repo name to a checkout path, and `task`
presets that bundle one worktree from each of several repos.

### Environment variables

portless injects `PORT`, `HOST`, `PORTLESS_URL`, and
`NODE_EXTRA_CA_CERTS` into the processes it starts. portful injects
`PORT`, `HOST`, and `PORTFUL_URL`, where `PORTFUL_URL` carries the fixed
port rather than the worktree's own. Injecting `PORT` lets a server that
reads the variable start with no `serve` template at all, which is how
portless reaches zero config.

portful reads `XDG_CONFIG_HOME` and `XDG_STATE_HOME` to locate its config
and state.

## What stays different

The proxy keeps a fixed port and decides where to forward from the active
worktree, re-read on every request. Hostname routing, a generated CA, a
privileged port, and `/etc/hosts` edits stay out. portful writes to its
own config and state directories and binds the ports you configure, and
touches nothing else on the machine. A locked-down work laptop can run it
without an administrator.

`proxy start` runs in the foreground, where portless runs a daemon. One
terminal tab per proxy keeps the request log visible and makes `Ctrl-C`
the stop button. No `--foreground` flag is offered, because a flag by
that name would imply a background default that does not exist.

## The name

`portful` spells the suffix the way English spells it: `-ful` carries one
`l` (careless and careful, useless and useful, stateless and stateful).
The name says that ports still exist here. One port stays fixed for every
client, and one more port runs behind it for each worktree.
