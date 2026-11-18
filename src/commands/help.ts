// SPDX-License-Identifier: Apache-2.0
import type { Arg, Command, Manifest } from "../manifest/schema.js";

export const SIGN_IN_HINT = "Sign in to see your commands.";

const BUILT_IN: [string, string][] = [
  ["login", "Sign in, and offer to store an API key. Options: --api <origin>, --no-key."],
  ["logout", "Remove the stored API key of the API origin."],
  ["help", "Show the commands. rlx help <command> shows one command."],
];

const GLOBAL_OPTIONS: [string, string][] = [
  ["--json", "Print the result as JSON, for a program."],
  ["--yes, -y", "Answer yes to each confirmation."],
  ["--api <origin>", "Use this API origin."],
  ["--quiet, -q", "Print the result only."],
  ["--debug", "Print each request. Credentials are never printed."],
];

function columns(rows: [string, string][], indent = "  "): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`).join("\n");
}

/** The general help. Without a manifest, it shows only the commands before the sign-in. */
export function generalHelp(manifest: Manifest | undefined): string {
  const parts = [
    "rlx, the RunLocal command-line tool for coding agents.",
    "",
    "Usage: rlx <command> [options]",
    "",
    "Commands:",
    columns(BUILT_IN),
    "",
  ];
  if (!manifest) {
    parts.push(SIGN_IN_HINT, "");
  } else if (manifest.commands.length === 0) {
    parts.push("Your account has no other commands.", "");
  } else {
    // Commands of one group go together, in the order of their first command; commands with no group come last.
    const groups = new Map<string, Command[]>();
    for (const command of manifest.commands) {
      const group = command.group ?? "";
      groups.set(group, [...(groups.get(group) ?? []), command]);
    }
    const ungrouped = groups.get("");
    groups.delete("");
    const width = Math.max(...manifest.commands.map((c) => c.name.join(" ").length));
    const rows = (commands: Command[]) =>
      commands.map((c) => `    ${c.name.join(" ").padEnd(width)}  ${c.summary}`).join("\n");
    parts.push("Your commands:");
    if (groups.size === 0) parts.push(columns(manifest.commands.map((c) => [c.name.join(" "), c.summary])));
    for (const [group, commands] of groups) parts.push(`  ${group}:`, rows(commands));
    if (ungrouped && groups.size) parts.push("  Other:", rows(ungrouped));
    parts.push("", "Run rlx <command> --help to see the options of a command.", "");
  }
  parts.push("Options:", columns(GLOBAL_OPTIONS));
  return parts.join("\n");
}

function argUsage(arg: Arg): string {
  if (arg.kind === "positional") {
    const text = `<${arg.name}>${arg.repeat ? "..." : ""}`;
    return arg.required === false ? `[${text}]` : text;
  }
  const value = arg.kind === "flag" ? "" : ` <${arg.type ?? "value"}>`;
  const text = `--${arg.name}${value}`;
  return arg.required ? text : `[${text}]`;
}

/** The help of one manifest command. */
export function commandHelp(command: Command): string {
  const args = command.args ?? [];
  const lines = [`Usage: rlx ${[command.name.join(" "), ...args.map(argUsage)].join(" ")}`, "", command.summary];
  if (command.description) lines.push("", command.description);
  const positionals = args.filter((a) => a.kind === "positional");
  const options = args.filter((a) => a.kind !== "positional");
  const describe = (arg: Arg): string => {
    const notes: string[] = [];
    if (arg.help) notes.push(arg.help);
    if (arg.default !== undefined) notes.push(`Default: ${String(arg.default)}.`);
    if (arg.choices) notes.push(`One of: ${arg.choices.join(", ")}.`);
    if (arg.repeat) notes.push(arg.kind === "positional" ? "Give one or more." : "Can be given more than once.");
    return notes.join(" ");
  };
  if (positionals.length) {
    lines.push("", "Arguments:", columns(positionals.map((a) => [`<${a.name}>${a.repeat ? "..." : ""}`, describe(a)])));
  }
  if (options.length) {
    lines.push(
      "",
      "Options:",
      columns(
        options.map((a) => [
          `--${a.name}${a.short ? `, -${a.short}` : ""}${a.kind === "flag" ? "" : ` <${a.type ?? "value"}>`}`,
          describe(a),
        ]),
      ),
    );
  }
  if (command.examples?.length) lines.push("", "Examples:", ...command.examples.map((example) => `  ${example}`));
  return lines.join("\n");
}

export function builtInHelp(word: string): string | undefined {
  switch (word) {
    case "login":
      return [
        "Usage: rlx login [--api <origin>] [--no-key] [--yes]",
        "",
        "Signs in with a code that you approve in a browser.",
        "Then rlx offers to store an API key in the key file of your home folder.",
        "--no-key keeps the session only. --yes stores the key without a question.",
      ].join("\n");
    case "logout":
      return [
        "Usage: rlx logout [--api <origin>]",
        "",
        "Removes the stored API key of the origin from the key file.",
        "It does not revoke the key: you can revoke it in the workspace.",
      ].join("\n");
    case "help":
      return "Usage: rlx help [<command>]";
    default:
      return undefined;
  }
}

/** The commands as JSON, for a program. */
export function helpJson(manifest: Manifest | undefined): unknown {
  return {
    signed_in: Boolean(manifest),
    commands: [
      ...BUILT_IN.map(([name, summary]) => ({ name: [name], summary })),
      ...(manifest?.commands ?? []).map((c) => ({
        name: c.name,
        summary: c.summary,
        ...(c.group ? { group: c.group } : {}),
        args: c.args ?? [],
        ...(c.examples ? { examples: c.examples } : {}),
      })),
    ],
    ...(manifest ? {} : { hint: SIGN_IN_HINT }),
  };
}
