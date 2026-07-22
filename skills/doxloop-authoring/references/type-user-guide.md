# User-guide playbook

Use for recurring end-user workflows through a UI or other user-facing control
surface. Pair with an administrator guide when shared configuration and daily
work have different owners.

## Build around user jobs

Identify the user's start state, goal, required access, primary objects, and
observable completion. Organize navigation by recognizable tasks and lifecycle,
not by internal service or screen implementation. Give each page one primary job.

## Procedure contract

For each workflow:

1. state what the reader will accomplish;
2. state role, prerequisites, and required starting state;
3. use exact visible labels and ordered actions;
4. explain consequential choices before the action;
5. show the resulting visible state;
6. provide evidence-backed recovery or reversal;
7. link to the next likely job.

Use screenshots for orientation, dense configuration, or state confirmation when
they materially reduce ambiguity. Keep text complete without the image. Account
for empty, loading, permission-denied, validation, and completed states supported
by evidence.

## Findability and support

Use user vocabulary, stable object names, and symptom language. Keep conceptual
explanations short and connected to decisions. Link administrators to settings
they own rather than instructing an end user to perform unauthorized actions.

## Standard navigation

Use `Help center` or `Documentation` as the primary top-navigation label. Use
this left-navigation block:

```text
Welcome
Get started
Common tasks
Manage your work
Collaboration
Personal settings
Troubleshooting
What's new
```

Replace generic task groups with product vocabulary and order them by frequency
and lifecycle. Keep organization-wide settings in an administrator journey.

## Senior quality gate

A qualified user can find the task by goal, complete it using current labels,
recognize success, understand the effect of consequential choices, and recover
or escalate without guessing or requiring an image.
