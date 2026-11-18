# How rlx works

rlx is a small, generic engine. It knows how to sign in, and how to run the
commands that the RunLocal server sends after sign-in. Before sign-in it
offers only `login`, `logout`, and `help`.

After sign-in, the server sends a *manifest*: the commands of the signed-in
person. Each command has arguments, steps, and an output. rlx runs the steps
in order. Each step is one of a few fixed operations, such as an HTTP request,
an upload, or reading a local file. A step reads and writes named values, and
the output prints some of them.

A manifest is data, never code. rlx checks the whole manifest before it runs
any step, and refuses one that it cannot read in full: an unknown field, an
unknown operation, or a bad template makes the whole manifest invalid. The
format is frozen at `runlocal.cli-manifest/1`; its schema is in
[`schema/`](../schema) and the engine that runs it is in [`src/`](../src).
