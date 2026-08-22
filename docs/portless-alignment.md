# Aligning the CLI and the config with portless

## Why

portless (vercel-labs) gives local dev servers stable `.localhost` names.
It has an install base and a command vocabulary that developers already
carry in their fingers. This project solves a different problem: it keeps
one address fixed and swaps what sits behind it. The two problems are
separate, so a developer can want both.

The decision is to reuse portless's surface wherever the two tools do the
same thing. A developer who knows portless then reads this tool without a
second manual. Where this tool does something portless leaves alone, it
adds a verb rather than redefining one of portless's.

Source for every portless detail below: the portless README at
`vercel-labs/portless`, read on 2026-08-22.

## Command mapping

| now | becomes | portless has | note |
| --- | --- | --- | --- |
| `serve <repo>/<wt>` | `portful <name> <cmd>` | `portless <name> <cmd>` | the worktree comes from the current directory, as portless does |
| `run <repo> <cmd>` | `exec <repo> <cmd>` | `run` means something else | see "The `run` collision" |
| (none) | `run [--name <n>] [cmd]` | `run` | runs the configured script through the proxy |
| `status` | `status` | `service status` | keeps the per-repo view: active worktree, servers, proxy |
| (none) | `list` | `list` | routes in portless's shape: name, target, port |
| `proxy` | `proxy start` / `proxy stop` | same | gains `-p`, `--no-tls`, `--cert`, `--key`, `--foreground` |
| `stop` | `stop` | `--force` takes over a route | unchanged |
| `use <repo>/<wt>` | `use <repo>/<wt>` | (none) | the verb this tool exists for |
| `task ...` | `task ...` | (none) | multi-repo presets stay |
| `prune` | `prune` | `prune` | same meaning: clean up orphans |
| `doctor` | `doctor` | `doctor` | same meaning |
| `ui` | `ui` | (none) | stays |
| `whoami` | `whoami` | (none) | stays |
| (none) | `alias <name> <port>` | `alias` | route a name at a server this tool did not start |
| (none) | `clean` | `clean` | remove state |

portless reserves `run`, `get`, `alias`, `hosts`, `list`, `doctor`,
`trust`, `clean`, `prune`, `proxy`, and `service` so they stay usable as
subcommands next to the `<name> <cmd>` positional form. This tool takes
the same reservation, plus `serve`, `use`, `task`, `stop`, `status`,
`exec`, `ui`, `whoami`, and `completion`.

### The `run` collision

portless `run` infers the app name and runs the package script through the
proxy. This tool's `run` executes an arbitrary command inside a worktree,
which is a different action. Two tools that share a vocabulary must not
give the same word two meanings, so this tool's meaning moves to `exec`.
`docker exec` and `kubectl exec` already use that word for "run a command
inside a context that exists", which is what the command does.

## Config

The config moves from `~/.config/wtshunt/config.toml` to JSON, and from
one user-owned file listing every repo to a file inside each repo.
portless reads `portless.json` at the project root and a `"portless"` key
in `package.json`. This tool reads `portful.json` and a `"portful"` key,
with the same precedence portless uses: CLI flag, then the `package.json`
key, then the JSON file, then inference.

Keys carried over from portless with the same meaning:

- `name`: the base name for the repo
- `script`: the `package.json` script to run
- `appPort`: a fixed port for the child, skipping assignment
- `apps`: per-package overrides in a workspace

Keys this tool adds, because portless has no fixed address to configure:

- `fixedPort`: the port every client keeps talking to
- `portRange`: the ports handed out to individual worktrees
- `serve`: a shell template for servers that need the port on the command
  line rather than in `PORT`
- `https`: the existing `cert`, `key`, and `backend` triple

Two things do not fit inside one repo's file, so they stay in a user-level
JSON file: the registry that maps a repo name to a checkout path, and
`task` presets that bundle one worktree from each of several repos.

### Environment variables

portless reads `PORTLESS_*` and injects `PORT`, `HOST`, `PORTLESS_URL`,
and `NODE_EXTRA_CA_CERTS` into children. This tool mirrors the shape:
`PORTFUL_PORT`, `PORTFUL_APP_PORT`, `PORTFUL_STATE_DIR`, and so on,
and injects `PORT`, `HOST`, and `PORTFUL_URL`. Injecting `PORT` lets a
server that reads the variable start with no `serve` template at all,
which is how portless reaches zero config.

## What stays different

The proxy keeps a fixed port and decides where to forward from the active
worktree, re-read on every request. Hostname routing, a generated CA, a
privileged port, and `/etc/hosts` edits stay out. The tool touches the
user's own config directory and the user's own ports, and nothing else on
the machine. A locked-down work laptop can run it without an
administrator.

`proxy start` also runs in the foreground, where portless runs a daemon.
The foreground model is a deliberate choice: one terminal tab per server
makes the logs visible and makes `Ctrl-C` the stop button. A flag named
`--foreground` would imply a background default that does not exist, so
the flag is left out and the help text states the behavior.

## The name

`portful` spells the suffix the way English spells it: `-ful` carries one
`l` (careless and careful, useless and useful, stateless and stateful).
The name says that ports still exist here. One port stays fixed for every
client, and one more port runs behind it for each worktree.

## Phases

1. Rename. `wtshunt` becomes `portful` across the code, the binary, the
   config directory, and the `X-Portful-Worktree` response header. This
   comes first so later phases write the new name once.
2. Command vocabulary. Rename `run` to `exec`, split `proxy` into
   `proxy start` and `proxy stop`, add `list`, add the `<name> <cmd>`
   positional form, adopt portless's flag names.
3. Config. Replace TOML with JSON, move the per-repo part into each repo,
   keep the registry and tasks in the user-level file, read the
   `package.json` key. `portful migrate` converts an existing TOML config.
4. Zero config. Infer the name, read the `package.json` script, and
   inject `PORT` so a server can start with no `serve` template.
