#!/usr/bin/env python3
"""Small dependency-free validator for the public Doxloop skill."""

from pathlib import Path
import re
import sys


def fail(message: str) -> None:
    print(f"Skill validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


if len(sys.argv) != 2:
    fail("usage: validate-skill.py <skill-directory>")

root = Path(sys.argv[1])
skill_file = root / "SKILL.md"
if not skill_file.is_file():
    fail("SKILL.md is missing")

text = skill_file.read_text(encoding="utf-8")
match = re.match(r"^---\n(?P<header>.*?)\n---\n(?P<body>.*)$", text, re.DOTALL)
if not match:
    fail("SKILL.md must start with YAML frontmatter")

fields: dict[str, str] = {}
for line in match.group("header").splitlines():
    if ":" not in line:
        fail(f"invalid frontmatter line: {line}")
    key, value = line.split(":", 1)
    fields[key.strip()] = value.strip()

if set(fields) != {"name", "description"}:
    fail("frontmatter must contain only name and description")
if fields["name"] != root.name:
    fail("skill name must match its directory")
if not re.fullmatch(r"[a-z0-9-]{1,63}", fields["name"]):
    fail("skill name must use lowercase letters, digits, and hyphens")
if len(fields["description"]) < 40:
    fail("description is too short to trigger reliably")
if "TODO" in text:
    fail("unresolved TODO found")
if len(match.group("body").splitlines()) > 500:
    fail("SKILL.md body must remain under 500 lines")

for markdown_file in root.rglob("*.md"):
    markdown = markdown_file.read_text(encoding="utf-8")
    # Fenced code holds syntax examples, not cross-references.
    markdown = re.sub(r"^(`{3,4}).*?^\1[ \t]*$", "", markdown, flags=re.DOTALL | re.MULTILINE)
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", markdown):
        path = target.split("#", 1)[0]
        if not path or "://" in path or path.startswith("/"):
            continue
        resolved = (markdown_file.parent / path).resolve()
        if not resolved.is_file():
            fail(
                f"{markdown_file.relative_to(root)} links to missing file {path}"
            )

metadata = root / "agents" / "openai.yaml"
if not metadata.is_file():
    fail("agents/openai.yaml is missing")
metadata_text = metadata.read_text(encoding="utf-8")
skill_token = f"${fields['name']}"
if skill_token not in metadata_text:
    fail(f"default prompt must mention {skill_token}")

print("Skill validation passed.")
