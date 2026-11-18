# rlx

`rlx` is the RunLocal command-line tool for coding agents. It signs you in to
RunLocal, and then runs the commands that your account offers.

## Install

`rlx` needs Node.js 22 or later.

```sh
npx @runlocal-ai/cli login
```

Or install it once:

```sh
npm install --global @runlocal-ai/cli
rlx login
```

## Sign in

```sh
rlx login
```

`rlx login` shows an address and a code. Open the address in a browser, check
the code, and approve the sign-in. Then `rlx` offers to store an API key in a
file in your home folder, so that it works next time. `rlx login --no-key`
keeps the session only.

If `RUNLOCAL_API_KEY` is set, `rlx login` checks that key and uses it, with
no browser; it does not store the key. With no terminal and no key, `rlx login`
prints the address and the code, and waits at most 10 minutes.

After sign-in, run `rlx help` to see your commands.

`rlx logout` removes the stored key from this computer. It does not revoke the
key: you can revoke it in the workspace.

## Options

| Option | What it does |
|---|---|
| `--json` | Prints the result as JSON, for a program. |
| `--yes`, `-y` | Answers yes to each confirmation. |
| `--api <origin>` | Uses this API origin. |
| `--quiet`, `-q` | Prints the result only, and errors. |
| `--debug` | Prints each request. Credentials are never printed. |

`rlx --version` prints the version. It goes before any command.

Exit codes: 0 success, 1 user error, 2 not signed in, 3 server error,
4 cancelled.

## Development

```sh
npm install
npm test        # build, typecheck, schema check, tests, and the leak check
npm run schema  # write schema/cli-manifest-1.schema.json after a change to the validator
```

How the engine works is in [docs/how-rlx-works.md](docs/how-rlx-works.md).
Its format is frozen; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

rlx is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

"RunLocal" and "rlx" are trademarks of RunLocal. The licence covers the code,
not the names or logos: a fork must use its own name.
