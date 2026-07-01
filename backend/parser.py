"""
Surgical line-based parser/serializer for kubespray group_vars files.

Kubespray's sample group_vars files are heavily annotated YAML where most
optional variables are present but commented-out (e.g. `# some_var: value`).
A generic YAML parser would either choke on this or throw away every comment
on re-serialization. Instead we scan top-level (column 0) entries directly out
of the raw text and only ever rewrite the exact line ranges that changed,
leaving every comment, blank line and section heading untouched.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

ACTIVE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t](.*))?$")
DISABLED_RE = re.compile(r"^#[ ]([A-Za-z_][A-Za-z0-9_]*):(?:[ \t](.*))?$")
DISABLED_CONT_RE = re.compile(r"^#(\s{2,}\S.*)$")


@dataclass
class Entry:
    key: str
    enabled: bool
    description: str
    start: int  # inclusive line index in the original file
    end: int  # inclusive line index in the original file
    value: str  # text after "key:" for single-line entries (may be empty)
    multiline: bool
    raw_block: str  # full de-commented block, used for multiline editing


@dataclass
class ParsedFile:
    lines: list[str] = field(default_factory=list)
    entries: list[Entry] = field(default_factory=list)

    def to_text(self) -> str:
        text = "\n".join(self.lines)
        if not text.endswith("\n"):
            text += "\n"
        return text


def _strip_comment_prefix(line: str) -> str:
    text = re.sub(r"^#+[ ]?", "", line)
    return text


def parse(text: str) -> ParsedFile:
    raw_lines = text.splitlines()
    entries: list[Entry] = []
    pending_description: list[str] = []
    i = 0
    n = len(raw_lines)

    while i < n:
        line = raw_lines[i]

        if line.strip() == "":
            pending_description = []
            i += 1
            continue

        m_active = ACTIVE_RE.match(line)
        m_disabled = None if m_active else DISABLED_RE.match(line)

        if m_active or m_disabled:
            key = (m_active or m_disabled).group(1)
            enabled = bool(m_active)
            first_value = (m_active or m_disabled).group(2) or ""
            start = i
            block_lines = [line]
            j = i + 1
            while j < n:
                nxt = raw_lines[j]
                if nxt.strip() == "":
                    break
                if enabled:
                    if nxt[:1] in (" ", "\t"):
                        block_lines.append(nxt)
                        j += 1
                        continue
                    break
                else:
                    if DISABLED_CONT_RE.match(nxt):
                        block_lines.append(nxt)
                        j += 1
                        continue
                    break

            multiline = len(block_lines) > 1
            if multiline:
                dedented = []
                for bl in block_lines:
                    dedented.append(_uncomment_line(bl) if not enabled else bl)
                raw_block = "\n".join(dedented)
                value = ""
            else:
                raw_block = _uncomment_line(line) if not enabled else line
                value = first_value

            entries.append(
                Entry(
                    key=key,
                    enabled=enabled,
                    description="\n".join(pending_description).strip(),
                    start=start,
                    end=j - 1,
                    value=value,
                    multiline=multiline,
                    raw_block=raw_block,
                )
            )
            pending_description = []
            i = j
            continue

        if line.lstrip().startswith("#"):
            pending_description.append(_strip_comment_prefix(line))
        else:
            pending_description = []
        i += 1

    return ParsedFile(lines=raw_lines, entries=entries)


def _uncomment_line(line: str) -> str:
    if not line.startswith("#"):
        return line
    rest = line[1:]
    if rest.startswith(" "):
        rest = rest[1:]
    return rest


def _comment_line(line: str) -> str:
    if line == "":
        return "#"
    return "# " + line


def render_entry_lines(key: str, enabled: bool, value: str, multiline: bool) -> list[str]:
    """Build the replacement raw lines for one entry given new (enabled, value)."""
    if multiline:
        body_lines = value.splitlines() or [f"{key}:"]
    else:
        value = value.strip("\n")
        if value == "":
            body_lines = [f"{key}:"]
        else:
            body_lines = [f"{key}: {value}"]

    if enabled:
        return body_lines
    return [_comment_line(bl) for bl in body_lines]


def apply_updates(parsed: ParsedFile, updates: dict[str, dict]) -> ParsedFile:
    """
    updates: {key: {"enabled": bool, "value": str}}
    Returns a new ParsedFile with the requested entries rewritten in place,
    re-parsed so entries/line ranges stay consistent for subsequent edits.
    """
    lines = list(parsed.lines)
    # Apply from bottom to top so earlier line indices stay valid.
    targeted = [e for e in parsed.entries if e.key in updates]
    for entry in sorted(targeted, key=lambda e: e.start, reverse=True):
        upd = updates[entry.key]
        new_enabled = upd.get("enabled", entry.enabled)
        new_value = upd.get("value", entry.raw_block if entry.multiline else entry.value)
        new_lines = render_entry_lines(entry.key, new_enabled, new_value, entry.multiline)
        lines[entry.start : entry.end + 1] = new_lines

    new_text = "\n".join(lines)
    if not new_text.endswith("\n"):
        new_text += "\n"
    return parse(new_text)


def infer_type(value: str) -> str:
    v = value.strip()
    if v.lower() in ("true", "false"):
        return "bool"
    if re.fullmatch(r"-?\d+", v):
        return "int"
    if re.fullmatch(r"-?\d+\.\d+", v):
        return "float"
    return "string"
