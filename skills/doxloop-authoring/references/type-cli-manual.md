# CLI-manual playbook

Use when readers need both task-oriented command guidance and consistent lookup
for a command hierarchy.

## Architect the manual

Provide installation and first success, then group tasks by reader outcome and
reference by command hierarchy. Put global concepts—configuration, profiles,
authentication, output formats, environment variables, and exit behavior—in
shared pages when they apply across commands.

## Command contract

For every supported command, document:

- syntax and purpose;
- positional arguments and accepted forms;
- local and inherited options, defaults, repeatability, and mutual exclusions;
- config and environment precedence;
- input sources and supported formats;
- stdout, stderr, machine-readable output, and exit status;
- prompts, TTY or non-interactive behavior, side effects, and confirmation;
- complete examples and consequential limitations.

Keep aliases and deprecated commands clearly labeled. Avoid repeating the same
global option details under every command unless the generator cannot provide a
usable shared reference.

## Automation lens

Show safe quoting, deterministic selection of context or profile, structured
output processing, prompt suppression, secret handling, exit checking, and dry
run where supported. Separate shell-specific examples or declare the shell.

## Standard navigation

Promote `Command reference` for a command-heavy product. Use this block:

```text
CLI overview
Getting started
Common workflows
Configuration
Command reference
  Global options
  Command groups
Input and output
Automation
Troubleshooting
Upgrade the CLI
Release notes
```

Order commands by hierarchy inside reference and by reader outcome inside guides.

## Senior quality gate

The manual matches actual help and parser behavior, but adds the context help
cannot provide: prerequisites, side effects, output meaning, failure handling,
automation safety, and task-oriented sequences.
