# Contributing

Run `npm test` before you push. It builds rlx, checks the types, checks that
the JSON Schema is up to date, runs the tests, and runs the leak check.

## The manifest format is frozen

The command manifest's format is frozen at `runlocal.cli-manifest/1`
(see [docs/how-rlx-works.md](docs/how-rlx-works.md)).

- Do not add an op, a filter, a field, a kind, or a type to
  `runlocal.cli-manifest/1` for every client. A new one needs
  `runlocal.cli-manifest/2`, or a documented minor field that the server
  sends only to a client whose version (from `User-Agent: rlx/<version>`)
  reads it.
- Logic beyond calling, confirming, and printing goes into a new generic op,
  written and tested in TypeScript, with a fuzz test. It never goes into
  templates. Templates stay plain interpolation with five filters.
- A stricter validator must keep each manifest that the server sends valid.
- After a change to the validator, run `npm run schema` in the same commit.

## No names of the service

This repository will be open source. It must not hold a command, an API path,
or a word of the workflows of the service. Tests and docs use invented names,
such as `widgets list` and `/v1/widgets`. `npm run check-leaks` checks the
files, the package, and the whole history.

## Sign your commits

Contributions are under the [Apache License 2.0](LICENSE). Sign off each
commit to certify the [Developer Certificate of Origin](https://developercertificate.org/):
that you wrote the change, or have the right to submit it under this licence.

    git commit -s

This adds a `Signed-off-by: Your Name <you@example.com>` line.
