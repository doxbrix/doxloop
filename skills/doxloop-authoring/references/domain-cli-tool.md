# CLI tool expertise

Use when readers operate or automate a product through commands, subcommands,
arguments, flags, standard streams, or process exit status.

## Think like a senior CLI documentation maintainer

Treat interactive use, scripts, and CI as distinct contexts. A command contract
includes invocation syntax, input sources, precedence, output destination and
format, prompts, side effects, exit behavior, and cleanup—not just a flag list.

## Investigate

- installation, executable names, shells, platforms, and runtime prerequisites;
- command hierarchy, aliases, positional arguments, required and repeatable options;
- defaults, environment variables, config files, and precedence rules;
- stdin, stdout, stderr, TTY detection, colors, prompts, and non-interactive mode;
- text and machine-readable output schemas and stability commitments;
- exit status, partial success, retries, cancellation, signals, and cleanup;
- filesystem effects, overwrite behavior, idempotency, dry-run, and confirmation;
- authentication, credential lookup, context/profile selection, and redaction;
- completion, help, diagnostics, compatibility, and deprecation behavior.

## Design coverage

Provide installation and a verified first command. Organize task guides around
outcomes and reference around the command tree. For every command, document
syntax, purpose, arguments, options, defaults, input, output, side effects, exit
behavior, examples, and consequential limitations when supported.

Examples for automation must avoid prompts, show quoting safely, distinguish
stdout from stderr when relevant, and check exit status or structured output.
Use the product's real help output as evidence but rewrite it into reader-focused
documentation rather than dumping it unchanged.

## Navigation overlay

Insert supported destinations into Getting started, Guides, and Command
reference:

```text
Installation and authentication
Common workflows
Configuration and precedence
Command hierarchy
Input, output, and exit status
Automation and non-interactive use
Diagnostics and troubleshooting
Upgrade and release notes
```

Keep task sequences separate from exhaustive command lookup.

## Never assume

Do not infer option precedence, shell portability, overwrite safety, atomicity,
stable JSON, exit codes, retry behavior, or non-interactive suitability from an
option name. Never show secrets directly on command lines when a safer supported
input exists.

## Senior quality gate

A reader must be able to install the executable, complete the primary task both
interactively and in supported automation, predict side effects and output, and
handle documented failure through exit status or diagnostics.
