#!/usr/bin/env python3
"""Render the DonWells Cue operator manual from its Markdown source.

The renderer intentionally supports the small, documented Markdown subset used by
``docs/operators-manual.md``. It has no network dependency and validates every
local link, image, and generator directive before replacing the output PDF.
"""

from __future__ import annotations

import argparse
import html
import os
import re
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence
from urllib.parse import quote, unquote, urlsplit

from PIL import Image as PILImage
from reportlab import rl_config
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    HRFlowable,
    Image,
    KeepTogether,
    LongTable,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = REPO_ROOT / "docs" / "operators-manual.md"
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "operators-manual.pdf"

PAGE_WIDTH, PAGE_HEIGHT = A4
LEFT_MARGIN = 19 * mm
RIGHT_MARGIN = 19 * mm
TOP_MARGIN = 22 * mm
BOTTOM_MARGIN = 18 * mm
FRAME_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN

CHARCOAL = HexColor("#282A2D")
MID_GRAY = HexColor("#62666A")
LIGHT_GRAY = HexColor("#D8D9DA")
PALE_GRAY = HexColor("#F3F3F1")
AMBER = HexColor("#A86600")
PALE_AMBER = HexColor("#F8EEDC")
WHITE = colors.white

FONT_REGULAR = "DWVera"
FONT_BOLD = "DWVera-Bold"
FONT_ITALIC = "DWVera-Italic"
FONT_BOLD_ITALIC = "DWVera-BoldItalic"
SUPPORTED_DIAGRAMS = {"signal-flow", "recovery"}
_VERA_COMMON_GLYPHS: frozenset[int] | None = None
_GLYPH_REPLACEMENTS = {
    "→": "->",
    "←": "<-",
    "↔": "<->",
    "⇒": "=>",
    "⇐": "<=",
    "⇔": "<=>",
    "≤": "<=",
    "≥": ">=",
    "≠": "!=",
    "✓": "[x]",
    "✗": "[x]",
    "‐": "-",
    "‑": "-",
    "−": "-",
    " ": " ",
    " ": " ",
}


class ManualError(RuntimeError):
    """A source error that should be shown without a Python traceback."""


@dataclass(frozen=True)
class Metadata:
    version: str
    source_revision: str
    title: str


@dataclass(frozen=True)
class HeadingNode:
    level: int
    markdown: str
    plain: str
    anchor: str
    line: int


@dataclass(frozen=True)
class ParagraphNode:
    markdown: str
    line: int


@dataclass(frozen=True)
class ListItemNode:
    markdown: str
    marker: str
    depth: int
    line: int


@dataclass(frozen=True)
class TableNode:
    headers: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]
    line: int


@dataclass(frozen=True)
class CodeNode:
    lines: tuple[str, ...]
    language: str
    line: int


@dataclass(frozen=True)
class QuoteNode:
    markdown: str
    label: str
    line: int


@dataclass(frozen=True)
class ImageNode:
    path: Path
    caption: str
    pixel_width: int
    pixel_height: int
    line: int


@dataclass(frozen=True)
class PageBreakNode:
    line: int


@dataclass(frozen=True)
class DiagramNode:
    name: str
    line: int


@dataclass(frozen=True)
class RuleNode:
    line: int


Node = (
    HeadingNode
    | ParagraphNode
    | ListItemNode
    | TableNode
    | CodeNode
    | QuoteNode
    | ImageNode
    | PageBreakNode
    | DiagramNode
    | RuleNode
)


@dataclass(frozen=True)
class ParsedManual:
    metadata: Metadata
    nodes: tuple[Node, ...]
    anchors: frozenset[str]


def _register_fonts() -> None:
    """Register bundled Vera and intersect all four faces' Unicode coverage."""

    global _VERA_COMMON_GLYPHS
    font_dir = Path(rl_config.__file__).resolve().parent / "fonts"
    files = {
        FONT_REGULAR: font_dir / "Vera.ttf",
        FONT_BOLD: font_dir / "VeraBd.ttf",
        FONT_ITALIC: font_dir / "VeraIt.ttf",
        FONT_BOLD_ITALIC: font_dir / "VeraBI.ttf",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        raise ManualError(
            "ReportLab's bundled Vera fonts are unavailable: " + ", ".join(missing)
        )
    registered = set(pdfmetrics.getRegisteredFontNames())
    for name, path in files.items():
        if name not in registered:
            pdfmetrics.registerFont(TTFont(name, str(path)))
    pdfmetrics.registerFontFamily(
        FONT_REGULAR,
        normal=FONT_REGULAR,
        bold=FONT_BOLD,
        italic=FONT_ITALIC,
        boldItalic=FONT_BOLD_ITALIC,
    )
    if _VERA_COMMON_GLYPHS is None:
        glyph_sets = [
            set(pdfmetrics.getFont(name).face.charToGlyph)
            for name in files
        ]
        _VERA_COMMON_GLYPHS = frozenset(set.intersection(*glyph_sets))


def _pdf_text(value: str, context: str) -> str:
    """Return text guaranteed visible in every embedded Vera face."""

    _register_fonts()
    assert _VERA_COMMON_GLYPHS is not None
    output: list[str] = []
    for character in value:
        codepoint = ord(character)
        if character in "\n\r\t":
            output.append(character)
            continue
        category = unicodedata.category(character)
        if category.startswith("C"):
            name = unicodedata.name(character, "UNKNOWN")
            raise ManualError(
                f"{context}: zero-width/control character U+{codepoint:04X} {name} is not allowed"
            )
        if codepoint in _VERA_COMMON_GLYPHS:
            output.append(character)
            continue
        replacement = _GLYPH_REPLACEMENTS.get(character)
        if replacement is not None:
            output.append(replacement)
            continue
        name = unicodedata.name(character, "UNKNOWN")
        raise ManualError(
            f"{context}: bundled Vera fonts have no glyph for U+{codepoint:04X} {name}; "
            "use supported text or add an explicit semantic ASCII replacement"
        )
    return "".join(output)


def _clean_metadata_value(value: str) -> str:
    value = value.strip().rstrip("  ")
    value = re.sub(r"^\*\*(.*?)\*\*$", r"\1", value)
    value = re.sub(r"^`(.*?)`$", r"\1", value)
    return value.strip()


def _plain_text(markdown: str) -> str:
    value = re.sub(r"!\[([^]]*)\]\([^)]*\)", r"\1", markdown)
    value = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"`([^`]*)`", r"\1", value)
    value = re.sub(r"(\*\*|__)(.*?)\1", r"\2", value)
    value = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\1", value)
    value = re.sub(r"(?<!_)_([^_]+)_(?!_)", r"\1", value)
    value = re.sub(r"\\([\\`*_[\]{}()#+.!|-])", r"\1", value)
    return " ".join(html.unescape(value).split())


def _slug(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    return slug or "section"


def _split_table_row(line: str) -> list[str]:
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|") and not stripped.endswith("\\|"):
        stripped = stripped[:-1]
    cells: list[str] = []
    current: list[str] = []
    escaped = False
    for character in stripped:
        if escaped:
            if character == "|":
                current.append("|")
            else:
                current.extend(("\\", character))
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == "|":
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(character)
    if escaped:
        current.append("\\")
    cells.append("".join(current).strip())
    return cells


def _is_table_delimiter(line: str) -> bool:
    cells = _split_table_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def _parse_image_destination(raw: str, line: int) -> str:
    value = raw.strip()
    if value.startswith("<"):
        closing = value.find(">")
        if closing < 0:
            raise ManualError(f"line {line}: image destination is missing '>'")
        destination = value[1:closing]
        remainder = value[closing + 1 :].strip()
        if remainder and not re.fullmatch(r"(?:\"[^\"]*\"|'[^']*')", remainder):
            raise ManualError(f"line {line}: malformed image title")
        return destination
    match = re.fullmatch(r"(\S+?)(?:\s+(?:\"[^\"]*\"|'[^']*'))?", value)
    if not match:
        raise ManualError(
            f"line {line}: paths containing spaces must be enclosed in angle brackets"
        )
    return match.group(1)


def _metadata_from_lines(lines: Sequence[str]) -> tuple[Metadata, set[int]]:
    ignored: set[int] = set()
    values: dict[str, str] = {}

    if lines and lines[0].strip() == "---":
        try:
            end = next(index for index in range(1, len(lines)) if lines[index].strip() == "---")
        except StopIteration:
            end = -1
        if end > 0:
            ignored.update(range(0, end + 1))
            for index in range(1, end):
                match = re.fullmatch(r"\s*([A-Za-z][A-Za-z _-]*):\s*(.*?)\s*", lines[index])
                if not match:
                    raise ManualError(f"line {index + 1}: malformed metadata entry")
                key = match.group(1).lower().replace("-", "_").replace(" ", "_")
                values[key] = _clean_metadata_value(match.group(2))

    title = ""
    for index, raw in enumerate(lines):
        if index in ignored:
            continue
        stripped = raw.strip()
        heading = re.fullmatch(r"#\s+(.+?)\s*#*", stripped)
        if heading and not title:
            title = _plain_text(heading.group(1))

        comment = re.fullmatch(
            r"<!--\s*(version|manual-version|source[- ]revision|source[- ]commit|revision)\s*:\s*(.*?)\s*-->",
            stripped,
            re.IGNORECASE,
        )
        if comment:
            key = comment.group(1).lower().replace("-", " ")
            canonical = "version" if "version" in key else "source_revision"
            values[canonical] = _clean_metadata_value(comment.group(2))
            ignored.add(index)
            continue

        visible = stripped.replace("**", "").replace("`", "").strip()
        match = re.fullmatch(
            r"(?i)(?:(?:manual|product)\s+)?version\s*:\s*(.+?)\s*", visible
        )
        if match:
            values["version"] = _clean_metadata_value(match.group(1))
            ignored.add(index)
            continue
        match = re.fullmatch(
            r"(?i)(?:source\s+(?:revision|commit)|revision)\s*:\s*(.+?)\s*", visible
        )
        if match:
            values["source_revision"] = _clean_metadata_value(match.group(1))
            ignored.add(index)

    version = values.get("version") or values.get("manual_version") or values.get("product_version")
    revision = (
        values.get("source_revision")
        or values.get("source_commit")
        or values.get("revision")
    )
    if not version:
        raise ManualError(
            "source metadata is missing Version (use '**Version:** 2.6.12' before the first chapter)"
        )
    if not revision:
        raise ManualError(
            "source metadata is missing Source revision (use '**Source revision:** bfec86b')"
        )
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", revision):
        raise ManualError(
            f"source revision must be a pinned 7-40 character Git commit, got {revision!r}"
        )
    if len(version) > 80 or any(ord(character) < 32 for character in version):
        raise ManualError("version metadata is malformed")
    if not title:
        raise ManualError("source is missing its H1 title")
    safe_version = _pdf_text(version, "version metadata")
    safe_title = _pdf_text(title, "H1 title")
    return Metadata(version=safe_version, source_revision=revision.lower(), title=safe_title), ignored


def _starts_block(lines: Sequence[str], index: int) -> bool:
    stripped = lines[index].strip()
    if not stripped:
        return True
    if re.match(r"^#{1,}\s+", stripped):
        return True
    if re.match(r"^(?:`{3,}|~{3,})", stripped):
        return True
    if re.match(r"^>\s?", stripped):
        return True
    if re.match(r"^\s*(?:[-+*]|\d+[.)])\s+", lines[index]):
        return True
    if re.fullmatch(r"<!--.*-->", stripped):
        return True
    if re.fullmatch(r"(?:-{3,}|\*{3,}|_{3,})", stripped):
        return True
    if re.fullmatch(r"!\[[^]]*\]\(.+\)", stripped):
        return True
    if index + 1 < len(lines) and "|" in stripped and _is_table_delimiter(lines[index + 1]):
        return True
    return False


def parse_manual(source: Path, text: str) -> ParsedManual:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    metadata, ignored = _metadata_from_lines(lines)
    nodes: list[Node] = []
    anchors: set[str] = set()
    slug_counts: dict[str, int] = {}
    h1_count = 0
    index = 0

    while index < len(lines):
        if index in ignored or not lines[index].strip():
            index += 1
            continue
        raw = lines[index]
        stripped = raw.strip()
        line_number = index + 1

        if "<!--" in stripped or "-->" in stripped:
            if stripped == "<!-- pagebreak -->":
                nodes.append(PageBreakNode(line_number))
                index += 1
                continue
            diagram = re.fullmatch(r"<!--\s*diagram:([a-z0-9-]+)\s*-->", stripped)
            if diagram:
                name = diagram.group(1)
                if name not in SUPPORTED_DIAGRAMS:
                    supported = ", ".join(sorted(SUPPORTED_DIAGRAMS))
                    raise ManualError(
                        f"line {line_number}: unsupported diagram {name!r}; supported: {supported}"
                    )
                nodes.append(DiagramNode(name, line_number))
                index += 1
                continue
            raise ManualError(
                f"line {line_number}: unsupported generator directive/comment {stripped!r}"
            )

        heading = re.fullmatch(r"(#{1,})\s+(.+?)\s*#*", stripped)
        if heading:
            level = len(heading.group(1))
            if level > 3:
                raise ManualError(
                    f"line {line_number}: H{level} is unsupported; use H2 chapters or H3 subsections"
                )
            markdown = heading.group(2).strip()
            plain = _pdf_text(_plain_text(markdown), f"line {line_number} heading")
            if not plain:
                raise ManualError(f"line {line_number}: heading text is empty")
            if level == 1:
                h1_count += 1
                if h1_count > 1:
                    raise ManualError(f"line {line_number}: only one H1 title is supported")
                nodes.append(HeadingNode(level, markdown, plain, "manual-title", line_number))
            else:
                base = _slug(plain)
                count = slug_counts.get(base, 0) + 1
                slug_counts[base] = count
                anchor = base if count == 1 else f"{base}-{count}"
                anchors.add(anchor)
                nodes.append(HeadingNode(level, markdown, plain, anchor, line_number))
            index += 1
            continue

        fence = re.fullmatch(r"(`{3,}|~{3,})\s*([^ ]*)\s*", stripped)
        if fence:
            marker = fence.group(1)[0]
            minimum = len(fence.group(1))
            language = fence.group(2).strip()
            code_lines: list[str] = []
            index += 1
            while index < len(lines) and not re.fullmatch(
                rf"\s*{re.escape(marker)}{{{minimum},}}\s*", lines[index]
            ):
                code_lines.append(lines[index])
                index += 1
            if index >= len(lines):
                raise ManualError(f"line {line_number}: fenced code block is not closed")
            nodes.append(CodeNode(tuple(code_lines), language, line_number))
            index += 1
            continue

        if stripped.startswith(":::"):
            raise ManualError(f"line {line_number}: unsupported block directive {stripped!r}")

        if index + 1 < len(lines) and "|" in stripped and _is_table_delimiter(lines[index + 1]):
            headers = _split_table_row(raw)
            if not headers or any(not header for header in headers):
                raise ManualError(f"line {line_number}: table headers may not be empty")
            delimiter = _split_table_row(lines[index + 1])
            if len(delimiter) != len(headers):
                raise ManualError(
                    f"line {line_number + 1}: table delimiter has {len(delimiter)} columns; expected {len(headers)}"
                )
            index += 2
            rows: list[tuple[str, ...]] = []
            while index < len(lines) and lines[index].strip() and "|" in lines[index]:
                cells = _split_table_row(lines[index])
                if len(cells) != len(headers):
                    raise ManualError(
                        f"line {index + 1}: table row has {len(cells)} columns; expected {len(headers)}"
                    )
                rows.append(tuple(cells))
                index += 1
            nodes.append(TableNode(tuple(headers), tuple(rows), line_number))
            continue

        image_match = re.fullmatch(r"!\[([^]]*)\]\((.+)\)", stripped)
        if image_match:
            caption = image_match.group(1).strip()
            if not caption:
                raise ManualError(f"line {line_number}: image alt text/caption may not be empty")
            destination = _parse_image_destination(image_match.group(2), line_number)
            parsed_destination = urlsplit(destination)
            if parsed_destination.scheme or parsed_destination.netloc:
                raise ManualError(
                    f"line {line_number}: images must use a source-relative local path"
                )
            if parsed_destination.query or parsed_destination.fragment:
                raise ManualError(
                    f"line {line_number}: image paths may not contain a query or fragment"
                )
            decoded = unquote(parsed_destination.path)
            if not decoded or Path(decoded).is_absolute():
                raise ManualError(
                    f"line {line_number}: images must use a non-empty source-relative path"
                )
            image_path = (source.parent / decoded).resolve()
            if not image_path.is_file():
                raise ManualError(
                    f"line {line_number}: image does not exist relative to the source: {destination}"
                )
            try:
                with PILImage.open(image_path) as image:
                    image.verify()
                with PILImage.open(image_path) as image:
                    pixel_width, pixel_height = image.size
            except Exception as error:
                raise ManualError(
                    f"line {line_number}: image cannot be decoded: {destination}: {error}"
                ) from error
            if pixel_width <= 0 or pixel_height <= 0:
                raise ManualError(f"line {line_number}: image has invalid dimensions")
            nodes.append(
                ImageNode(
                    image_path,
                    caption,
                    pixel_width,
                    pixel_height,
                    line_number,
                )
            )
            index += 1
            continue

        if re.fullmatch(r"(?:-{3,}|\*{3,}|_{3,})", stripped):
            nodes.append(RuleNode(line_number))
            index += 1
            continue

        if re.match(r"^>\s?", stripped):
            quote_lines: list[str] = []
            while index < len(lines) and re.match(r"^\s*>\s?", lines[index]):
                quote_lines.append(re.sub(r"^\s*>\s?", "", lines[index]))
                index += 1
            label = "SAFETY NOTE"
            if quote_lines:
                admonition = re.fullmatch(
                    r"\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*", quote_lines[0], re.IGNORECASE
                )
                if admonition:
                    label = admonition.group(1).upper()
                    quote_lines.pop(0)
                else:
                    safety = re.match(
                        r"(?:\*\*)?(Safety|Warning|Caution|Important)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)",
                        quote_lines[0],
                        re.IGNORECASE,
                    )
                    if safety:
                        label = safety.group(1).upper()
                        quote_lines[0] = safety.group(2)
            content = " ".join(part.strip() for part in quote_lines if part.strip())
            if not content:
                raise ManualError(f"line {line_number}: safety note is empty")
            nodes.append(QuoteNode(content, label, line_number))
            continue

        list_match = re.match(r"^(\s*)([-+*]|\d+[.)])\s+(.+)$", raw)
        if list_match:
            indentation = len(list_match.group(1).replace("\t", "    "))
            depth = min(indentation // 2, 4)
            marker = list_match.group(2)
            content = list_match.group(3).strip()
            checklist = re.match(r"^\[([ xX])\]\s+(.+)$", content)
            if checklist:
                marker = "[x]" if checklist.group(1).lower() == "x" else "[ ]"
                content = checklist.group(2)
            if not content:
                raise ManualError(f"line {line_number}: list item is empty")
            nodes.append(ListItemNode(content, marker, depth, line_number))
            index += 1
            continue

        paragraph_start = index
        parts: list[str] = []
        while index < len(lines) and lines[index].strip() and not (
            index != paragraph_start and _starts_block(lines, index)
        ):
            part = lines[index].strip()
            if "![" in part:
                raise ManualError(
                    f"line {index + 1}: images must occupy their own line so captions remain attached"
                )
            if part.endswith("  "):
                parts.append(part.rstrip() + "\n")
            else:
                parts.append(part)
            index += 1
        if not parts:
            raise ManualError(f"line {line_number}: unsupported Markdown construct {stripped!r}")
        paragraph = " ".join(parts).replace("\n ", "\n")
        nodes.append(ParagraphNode(paragraph, line_number))

    if h1_count != 1:
        raise ManualError("source must contain exactly one H1 title")
    if not any(isinstance(node, HeadingNode) and node.level == 2 for node in nodes):
        raise ManualError("source must contain at least one H2 chapter")
    return ParsedManual(metadata, tuple(nodes), frozenset(anchors))


class InlineRenderer:
    """Convert safe inline Markdown to ReportLab paragraph markup."""

    TOKEN = re.compile(
        r"(`[^`]+`|\[([^]\n]+)\]\(([^)\n]+)\)|\*\*.+?\*\*|__.+?__|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_))"
    )

    def __init__(
        self,
        source: Path,
        output: Path,
        anchors: frozenset[str],
    ) -> None:
        self.source = source.resolve()
        self.output = output.resolve()
        self.anchors = anchors

    def _link_href(self, destination: str, line: int) -> str:
        destination = html.unescape(destination.strip())
        if destination.startswith("<") and destination.endswith(">"):
            destination = destination[1:-1]
        if not destination or any(unicodedata.category(character).startswith("C") for character in destination):
            raise ManualError(f"line {line}: malformed empty/control-character link")
        parsed = urlsplit(destination)
        if parsed.scheme:
            if parsed.scheme not in {"https", "http", "mailto"}:
                raise ManualError(
                    f"line {line}: unsupported link scheme {parsed.scheme!r}"
                )
            if any(character.isspace() for character in destination):
                raise ManualError(f"line {line}: URI contains unescaped whitespace")
            if parsed.scheme in {"https", "http"} and not parsed.netloc:
                raise ManualError(f"line {line}: HTTP(S) URI has no host")
            if parsed.scheme == "mailto" and not parsed.path:
                raise ManualError(f"line {line}: mailto URI has no address")
            return destination
        if parsed.netloc:
            raise ManualError(f"line {line}: protocol-relative links are unsupported")
        if not parsed.path:
            fragment = unquote(parsed.fragment)
            if not fragment or fragment not in self.anchors:
                raise ManualError(
                    f"line {line}: internal link targets unknown heading #{fragment}"
                )
            return f"#{fragment}"

        decoded_path = unquote(parsed.path)
        path = Path(decoded_path)
        if path.is_absolute():
            raise ManualError(
                f"line {line}: local links must be relative to the Markdown source"
            )
        target = (self.source.parent / path).resolve()
        if not target.exists():
            raise ManualError(
                f"line {line}: linked path does not exist relative to the source: {parsed.path}"
            )
        if target == self.source and parsed.fragment:
            fragment = unquote(parsed.fragment)
            if fragment not in self.anchors:
                raise ManualError(
                    f"line {line}: internal link targets unknown heading #{fragment}"
                )
            return f"#{fragment}"
        # Preserve local links as portable paths relative to the generated PDF.
        # The source revision may be local-only, so manufacturing a hosted URL
        # here could create a broken annotation.
        relative_target = os.path.relpath(target, self.output.parent)
        href = quote(Path(relative_target).as_posix(), safe="/")
        if parsed.query:
            href += "?" + parsed.query
        if parsed.fragment:
            href += "#" + quote(unquote(parsed.fragment), safe="-._~")
        return href

    def render(self, markdown: str, line: int, *, allow_links: bool = True) -> str:
        output: list[str] = []
        position = 0
        context = f"line {line} visible text"
        for match in self.TOKEN.finditer(markdown):
            plain = _pdf_text(markdown[position : match.start()], context)
            output.append(html.escape(plain).replace("\n", "<br/>"))
            token = match.group(0)
            if token.startswith("`"):
                code = html.escape(_pdf_text(token[1:-1], f"line {line} inline code"))
                output.append(
                    f'<font name="{FONT_REGULAR}" color="#4B4D50" backColor="#EEEEEB">'
                    f"&#160;{code}&#160;</font>"
                )
            elif token.startswith("["):
                label = match.group(2) or ""
                if not allow_links:
                    output.append(html.escape(_pdf_text(_plain_text(label), context)))
                else:
                    href = self._link_href(match.group(3) or "", line)
                    output.append(
                        f'<link href="{html.escape(href, quote=True)}" color="#8A5700" '
                        f'underline="1">{self.render(label, line, allow_links=False)}</link>'
                    )
            elif token.startswith("**") or token.startswith("__"):
                output.append(f"<b>{self.render(token[2:-2], line, allow_links=allow_links)}</b>")
            else:
                output.append(f"<i>{self.render(token[1:-1], line, allow_links=allow_links)}</i>")
            position = match.end()
        tail = _pdf_text(markdown[position:], context)
        output.append(html.escape(tail).replace("\n", "<br/>"))
        return "".join(output)


class CodeBlock(Flowable):
    def __init__(
        self,
        lines: Sequence[str],
        language: str = "",
        *,
        context: str = "fenced code",
        continuation: bool = False,
        prewrapped: bool = False,
    ) -> None:
        super().__init__()
        self.context = context
        self.lines = [_pdf_text(line, context) for line in lines] or [""]
        self.language = _pdf_text(language, f"{context} language label")
        self.continuation = continuation
        self.prewrapped = prewrapped
        self.visual_lines: list[str] = []
        self.font_size = 7.8
        self.leading = 10.2
        self.padding = 8
        self.spaceBefore = 3
        self.spaceAfter = 8

    def _wrapped_lines(self, width: float) -> list[str]:
        if self.prewrapped:
            return self.lines
        usable = max(width - 2 * self.padding, 30)
        result: list[str] = []
        for raw in self.lines:
            expanded = raw.expandtabs(4)
            if not expanded:
                result.append("")
                continue
            remainder = expanded
            while remainder:
                low, high = 1, len(remainder)
                while low < high:
                    middle = (low + high + 1) // 2
                    measured = pdfmetrics.stringWidth(
                        remainder[:middle], FONT_REGULAR, self.font_size
                    )
                    if measured <= usable:
                        low = middle
                    else:
                        high = middle - 1
                split_at = max(low, 1)
                result.append(remainder[:split_at])
                remainder = remainder[split_at:]
        return result

    @property
    def _header_height(self) -> float:
        return 14 if self.language or self.continuation else 0

    def wrap(self, available_width: float, available_height: float) -> tuple[float, float]:
        self.width = available_width
        self.visual_lines = self._wrapped_lines(available_width)
        self.height = (
            2 * self.padding
            + self._header_height
            + len(self.visual_lines) * self.leading
        )
        return self.width, self.height

    def split(self, available_width: float, available_height: float) -> list[Flowable]:
        self.wrap(available_width, available_height)
        usable = available_height - 2 * self.padding - self._header_height
        count = int(usable // self.leading)
        if count < 2 or count >= len(self.visual_lines):
            return []
        first = CodeBlock(
            self.visual_lines[:count],
            self.language,
            context=self.context,
            continuation=self.continuation,
            prewrapped=True,
        )
        second = CodeBlock(
            self.visual_lines[count:],
            self.language,
            context=self.context,
            continuation=True,
            prewrapped=True,
        )
        return [first, second]

    def draw(self) -> None:
        canvas = self.canv
        canvas.saveState()
        canvas.setFillColor(PALE_GRAY)
        canvas.setStrokeColor(LIGHT_GRAY)
        canvas.setLineWidth(0.6)
        canvas.rect(0, 0, self.width, self.height, fill=1, stroke=1)
        y = self.height - self.padding
        if self._header_height:
            label = self.language.upper() if self.language else "CODE"
            if self.continuation:
                label += " (CONTINUED)"
            canvas.setFillColor(MID_GRAY)
            canvas.setFont(FONT_BOLD, 6.6)
            canvas.drawString(self.padding, y - 6, _pdf_text(label, f"{self.context} header"))
            y -= self._header_height
        canvas.setFillColor(CHARCOAL)
        canvas.setFont(FONT_REGULAR, self.font_size)
        baseline = y - self.font_size
        for line in self.visual_lines:
            canvas.drawString(self.padding, baseline, line)
            baseline -= self.leading
        canvas.restoreState()


class SafetyNote(Flowable):
    def __init__(
        self,
        paragraph: Paragraph,
        label: str,
        *,
        continuation: bool = False,
    ) -> None:
        super().__init__()
        self.paragraph = paragraph
        self.label = label
        self.continuation = continuation
        self.padding = 8
        self.header_height = 14
        self.spaceBefore = 3
        self.spaceAfter = 8
        self._paragraph_height = 0.0

    def wrap(self, available_width: float, available_height: float) -> tuple[float, float]:
        self.width = available_width
        _, self._paragraph_height = self.paragraph.wrap(
            available_width - 2 * self.padding - 3,
            available_height,
        )
        self.height = (
            2 * self.padding + self.header_height + self._paragraph_height
        )
        return self.width, self.height

    def split(self, available_width: float, available_height: float) -> list[Flowable]:
        content_width = available_width - 2 * self.padding - 3
        content_height = available_height - 2 * self.padding - self.header_height
        if content_height < 24:
            return []
        parts = self.paragraph.split(content_width, content_height)
        if len(parts) < 2:
            return []
        return [
            SafetyNote(parts[0], self.label, continuation=self.continuation),
            SafetyNote(parts[1], self.label, continuation=True),
        ]

    def draw(self) -> None:
        canvas = self.canv
        canvas.saveState()
        canvas.setFillColor(PALE_AMBER)
        canvas.setStrokeColor(HexColor("#D6BB8E"))
        canvas.setLineWidth(0.6)
        canvas.rect(0, 0, self.width, self.height, fill=1, stroke=1)
        canvas.setFillColor(AMBER)
        canvas.rect(0, 0, 3, self.height, fill=1, stroke=0)
        canvas.setFillColor(CHARCOAL)
        canvas.setFont(FONT_BOLD, 7.2)
        label = self.label + (" (CONTINUED)" if self.continuation else "")
        canvas.drawString(
            self.padding + 3,
            self.height - self.padding - 6,
            _pdf_text(label, "safety-note label"),
        )
        self.paragraph.drawOn(canvas, self.padding + 3, self.padding)
        canvas.restoreState()


def _arrow(canvas, start_x: float, start_y: float, end_x: float, end_y: float) -> None:
    canvas.setStrokeColor(CHARCOAL)
    canvas.setFillColor(CHARCOAL)
    canvas.setLineWidth(1.0)
    canvas.line(start_x, start_y, end_x, end_y)
    if abs(end_x - start_x) >= abs(end_y - start_y):
        direction = 1 if end_x > start_x else -1
        points = [
            (end_x, end_y),
            (end_x - 5 * direction, end_y + 3),
            (end_x - 5 * direction, end_y - 3),
        ]
    else:
        direction = 1 if end_y > start_y else -1
        points = [
            (end_x, end_y),
            (end_x - 3, end_y - 5 * direction),
            (end_x + 3, end_y - 5 * direction),
        ]
    path = canvas.beginPath()
    path.moveTo(*points[0])
    path.lineTo(*points[1])
    path.lineTo(*points[2])
    path.close()
    canvas.drawPath(path, fill=1, stroke=0)


def _diagram_text(
    canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    bold: bool = False,
    size: float = 8.0,
) -> None:
    style = ParagraphStyle(
        "DiagramText",
        fontName=FONT_BOLD if bold else FONT_REGULAR,
        fontSize=size,
        leading=size + 2,
        textColor=CHARCOAL,
        alignment=TA_CENTER,
    )
    paragraph = Paragraph(html.escape(_pdf_text(text, "diagram label")), style)
    _, paragraph_height = paragraph.wrap(width, height)
    paragraph.drawOn(canvas, x, y + (height - paragraph_height) / 2)


class SignalFlowDiagram(Flowable):
    def __init__(self) -> None:
        super().__init__()
        self.height = 205
        self.spaceBefore = 6
        self.spaceAfter = 12

    def wrap(self, available_width: float, available_height: float) -> tuple[float, float]:
        self.width = available_width
        return self.width, self.height

    def draw(self) -> None:
        canvas = self.canv
        canvas.saveState()
        canvas.setStrokeColor(LIGHT_GRAY)
        canvas.setFillColor(WHITE)
        canvas.rect(0, 0, self.width, self.height, fill=1, stroke=1)
        canvas.setFont(FONT_BOLD, 7)
        canvas.setFillColor(MID_GRAY)
        canvas.drawString(10, self.height - 14, _pdf_text("SIGNAL, SOUND, AND PICTURE FLOW", "signal diagram label"))

        gap = 22
        box_width = (self.width - 40 - 2 * gap) / 3
        box_y = 105
        box_height = 62
        xs = [20, 20 + box_width + gap, 20 + 2 * (box_width + gap)]
        labels = [
            ("CONTROLLER", "Desktop app / operator controls and cue commands"),
            ("SERVER / AUDIO ENGINE", "Authoritative project, cue scheduling, and soundtrack"),
            ("SOUND OUTPUT", "Audio devices / streams"),
        ]
        for position, (role, detail) in zip(xs, labels):
            canvas.setStrokeColor(AMBER if role in {"CONTROLLER", "SERVER / AUDIO ENGINE"} else MID_GRAY)
            canvas.setLineWidth(1.2 if role in {"CONTROLLER", "SERVER / AUDIO ENGINE"} else 0.8)
            canvas.rect(position, box_y, box_width, box_height, fill=0, stroke=1)
            _diagram_text(
                canvas,
                role,
                position + 5,
                box_y + 36,
                box_width - 10,
                18,
                bold=True,
                size=7.3,
            )
            _diagram_text(
                canvas,
                detail,
                position + 7,
                box_y + 7,
                box_width - 14,
                29,
                size=7.0,
            )
        _arrow(canvas, xs[0] + box_width, box_y + 34, xs[1], box_y + 34)
        _arrow(canvas, xs[1] + box_width, box_y + 34, xs[2], box_y + 34)
        canvas.setFont(FONT_REGULAR, 6.5)
        canvas.setFillColor(MID_GRAY)
        canvas.drawCentredString((xs[0] + box_width + xs[1]) / 2, box_y + 41, _pdf_text("control", "signal diagram label"))
        canvas.drawCentredString((xs[1] + box_width + xs[2]) / 2, box_y + 41, _pdf_text("soundtrack", "signal diagram label"))

        picture_width = min(265.0, self.width * 0.58)
        picture_x = (self.width - picture_width) / 2
        picture_y = 31
        picture_height = 45
        canvas.setStrokeColor(MID_GRAY)
        canvas.setLineWidth(0.9)
        canvas.rect(picture_x, picture_y, picture_width, picture_height, fill=0, stroke=1)
        _diagram_text(
            canvas,
            "PICTURE CLIENT / VIDEO OUTPUT",
            picture_x + 7,
            picture_y + 24,
            picture_width - 14,
            14,
            bold=True,
            size=7.2,
        )
        _diagram_text(
            canvas,
            "Separate desktop picture renderer; its video element is muted",
            picture_x + 7,
            picture_y + 5,
            picture_width - 14,
            19,
            size=6.9,
        )
        _arrow(canvas, xs[1] + box_width / 2, box_y, self.width / 2, picture_y + picture_height)
        canvas.setFillColor(MID_GRAY)
        canvas.drawString(self.width / 2 + 6, picture_y + picture_height + 11, _pdf_text("media + cue state", "signal diagram label"))
        canvas.setFont(FONT_ITALIC, 6.5)
        canvas.drawCentredString(
            self.width / 2,
            13,
            _pdf_text("Same-machine controller, picture client, and audio engine is recommended — not required.", "signal diagram label"),
        )
        canvas.restoreState()


class RecoveryDiagram(Flowable):
    def __init__(self) -> None:
        super().__init__()
        self.height = 215
        self.spaceBefore = 6
        self.spaceAfter = 12

    def wrap(self, available_width: float, available_height: float) -> tuple[float, float]:
        self.width = available_width
        return self.width, self.height

    def draw(self) -> None:
        canvas = self.canv
        canvas.saveState()
        canvas.setStrokeColor(LIGHT_GRAY)
        canvas.setFillColor(WHITE)
        canvas.rect(0, 0, self.width, self.height, fill=1, stroke=1)
        canvas.setFont(FONT_BOLD, 7)
        canvas.setFillColor(MID_GRAY)
        canvas.drawString(10, self.height - 14, _pdf_text("RECOVERY DECISION · JOIN OR KEEP DIRTY", "recovery diagram label"))

        center_width = min(270.0, self.width * 0.60)
        center_x = (self.width - center_width) / 2
        top_y = 143
        canvas.setStrokeColor(AMBER)
        canvas.setLineWidth(1.2)
        canvas.rect(center_x, top_y, center_width, 42, fill=0, stroke=1)
        _diagram_text(
            canvas,
            "CONTROLLER: reconnect with unsaved (dirty) local edits",
            center_x + 8,
            top_y + 5,
            center_width - 16,
            32,
            bold=True,
            size=7.5,
        )

        decision_y = 94
        decision_height = 29
        canvas.setStrokeColor(CHARCOAL)
        canvas.setLineWidth(0.9)
        canvas.rect(center_x + 12, decision_y, center_width - 24, decision_height, fill=0, stroke=1)
        _diagram_text(
            canvas,
            "SERVER: active project differs — join server state or keep dirty local state",
            center_x + 18,
            decision_y + 3,
            center_width - 36,
            decision_height - 6,
            size=7.0,
        )
        _arrow(canvas, self.width / 2, top_y, self.width / 2, decision_y + decision_height)

        gap = 20
        choice_width = (self.width - 40 - gap) / 2
        left_x = 20
        right_x = left_x + choice_width + gap
        choice_y = 18
        choice_height = 54
        for x in (left_x, right_x):
            canvas.setStrokeColor(AMBER)
            canvas.setLineWidth(1.1)
            canvas.rect(x, choice_y, choice_width, choice_height, fill=0, stroke=1)
        _diagram_text(
            canvas,
            "USE SERVER PROJECT",
            left_x + 7,
            choice_y + 31,
            choice_width - 14,
            14,
            bold=True,
            size=7.3,
        )
        _diagram_text(
            canvas,
            "Adopt server document; discard local unsaved edits",
            left_x + 7,
            choice_y + 5,
            choice_width - 14,
            25,
            size=6.9,
        )
        _diagram_text(
            canvas,
            "RESTORE LOCAL PROJECT",
            right_x + 7,
            choice_y + 31,
            choice_width - 14,
            14,
            bold=True,
            size=7.3,
        )
        _diagram_text(
            canvas,
            "Replace active server document with local; remains dirty until saved",
            right_x + 7,
            choice_y + 5,
            choice_width - 14,
            25,
            size=6.9,
        )
        branch_x = self.width / 2
        _arrow(canvas, branch_x - 2, decision_y, left_x + choice_width / 2, choice_y + choice_height)
        _arrow(canvas, branch_x + 2, decision_y, right_x + choice_width / 2, choice_y + choice_height)
        canvas.restoreState()


class ManualDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str, metadata: Metadata) -> None:
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=LEFT_MARGIN,
            rightMargin=RIGHT_MARGIN,
            topMargin=TOP_MARGIN,
            bottomMargin=BOTTOM_MARGIN,
            title="DonWells Cue — Operator’s Manual",
            author="DonWells Cue",
            subject=(
                f"Operator manual version {metadata.version}; "
                f"source revision {metadata.source_revision}"
            ),
            creator="DonWells Cue operator manual generator",
        )
        self.metadata_record = metadata
        cover_frame = Frame(
            LEFT_MARGIN,
            BOTTOM_MARGIN,
            FRAME_WIDTH,
            PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
            id="cover-frame",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        content_frame = Frame(
            LEFT_MARGIN,
            BOTTOM_MARGIN,
            FRAME_WIDTH,
            PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN,
            id="content-frame",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(
            [
                PageTemplate("Cover", [cover_frame], onPage=self._cover_page),
                PageTemplate("Content", [content_frame], onPage=self._content_page),
            ]
        )

    def _cover_page(self, canvas, document) -> None:
        canvas.saveState()
        canvas.setFillColor(WHITE)
        canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
        canvas.setStrokeColor(AMBER)
        canvas.setLineWidth(4)
        canvas.line(LEFT_MARGIN, PAGE_HEIGHT - 31 * mm, PAGE_WIDTH - RIGHT_MARGIN, PAGE_HEIGHT - 31 * mm)
        canvas.setFillColor(MID_GRAY)
        canvas.setFont(FONT_BOLD, 7.2)
        canvas.drawString(LEFT_MARGIN, PAGE_HEIGHT - 24 * mm, _pdf_text("DONWELLS CUE · TECHNICAL OPERATIONS", "cover label"))
        canvas.setStrokeColor(LIGHT_GRAY)
        canvas.setLineWidth(0.6)
        canvas.line(LEFT_MARGIN, 25 * mm, PAGE_WIDTH - RIGHT_MARGIN, 25 * mm)
        canvas.setFillColor(MID_GRAY)
        canvas.setFont(FONT_REGULAR, 7.2)
        canvas.drawString(LEFT_MARGIN, 19 * mm, _pdf_text("CURRENT-SOURCE EDITION", "cover label"))
        canvas.drawRightString(
            PAGE_WIDTH - RIGHT_MARGIN,
            19 * mm,
            _pdf_text(f"SOURCE {self.metadata_record.source_revision}", "cover source revision"),
        )
        canvas.restoreState()

    def _content_page(self, canvas, document) -> None:
        canvas.saveState()
        canvas.setFillColor(WHITE)
        canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
        header_y = PAGE_HEIGHT - 13 * mm
        canvas.setStrokeColor(AMBER)
        canvas.setLineWidth(1.1)
        canvas.line(LEFT_MARGIN, header_y - 4, PAGE_WIDTH - RIGHT_MARGIN, header_y - 4)
        canvas.setFillColor(MID_GRAY)
        canvas.setFont(FONT_BOLD, 7.0)
        canvas.drawString(LEFT_MARGIN, header_y + 3, _pdf_text("DONWELLS CUE · OPERATOR’S MANUAL", "running header"))
        canvas.setStrokeColor(LIGHT_GRAY)
        canvas.setLineWidth(0.5)
        footer_y = 11 * mm
        canvas.line(LEFT_MARGIN, footer_y + 8, PAGE_WIDTH - RIGHT_MARGIN, footer_y + 8)
        canvas.setFillColor(MID_GRAY)
        canvas.setFont(FONT_REGULAR, 7.0)
        canvas.drawString(
            LEFT_MARGIN,
            footer_y,
            _pdf_text(f"Version {self.metadata_record.version} · source {self.metadata_record.source_revision}", "running footer"),
        )
        canvas.drawRightString(
            PAGE_WIDTH - RIGHT_MARGIN,
            footer_y,
            _pdf_text(str(max(canvas.getPageNumber() - 1, 1)), "page number"),
        )
        canvas.restoreState()

    def afterFlowable(self, flowable: Flowable) -> None:
        level = getattr(flowable, "manual_heading_level", None)
        if level not in {2, 3}:
            return
        text = getattr(flowable, "manual_heading_text")
        key = getattr(flowable, "manual_heading_key")
        outline_level = level - 2
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(text, key, level=outline_level, closed=False)
        # The cover is intentionally unnumbered; TOC numbers match the footer.
        self.notify("TOCEntry", (outline_level, text, self.page - 1, key))


def _styles() -> dict[str, ParagraphStyle]:
    sample = getSampleStyleSheet()
    return {
        "cover_brand": ParagraphStyle(
            "CoverBrand",
            parent=sample["Normal"],
            fontName=FONT_BOLD,
            fontSize=12,
            leading=15,
            textColor=AMBER,
            spaceAfter=14,
        ),
        "cover_title": ParagraphStyle(
            "CoverTitle",
            parent=sample["Title"],
            fontName=FONT_BOLD,
            fontSize=31,
            leading=35,
            alignment=TA_LEFT,
            textColor=CHARCOAL,
            spaceAfter=8,
        ),
        "cover_subtitle": ParagraphStyle(
            "CoverSubtitle",
            parent=sample["Normal"],
            fontName=FONT_REGULAR,
            fontSize=14,
            leading=19,
            textColor=MID_GRAY,
            spaceAfter=26,
        ),
        "cover_meta": ParagraphStyle(
            "CoverMeta",
            parent=sample["Normal"],
            fontName=FONT_REGULAR,
            fontSize=9.2,
            leading=14,
            textColor=CHARCOAL,
        ),
        "cover_preface": ParagraphStyle(
            "CoverPreface",
            parent=sample["Normal"],
            fontName=FONT_REGULAR,
            fontSize=8.2,
            leading=11.4,
            textColor=MID_GRAY,
            spaceBefore=6,
            spaceAfter=0,
            allowWidows=0,
            allowOrphans=0,
        ),
        "toc_title": ParagraphStyle(
            "TOCTitle",
            parent=sample["Heading1"],
            fontName=FONT_BOLD,
            fontSize=22,
            leading=27,
            textColor=CHARCOAL,
            spaceBefore=6,
            spaceAfter=16,
        ),
        "toc_h2": ParagraphStyle(
            "TOCH2",
            parent=sample["Normal"],
            fontName=FONT_BOLD,
            fontSize=9.1,
            leading=11.8,
            textColor=CHARCOAL,
            leftIndent=0,
            firstLineIndent=0,
            spaceBefore=1,
        ),
        "toc_h3": ParagraphStyle(
            "TOCH3",
            parent=sample["Normal"],
            fontName=FONT_REGULAR,
            fontSize=8.3,
            leading=10.5,
            textColor=MID_GRAY,
            leftIndent=12,
            firstLineIndent=0,
        ),
        "h2": ParagraphStyle(
            "ManualH2",
            parent=sample["Heading1"],
            fontName=FONT_BOLD,
            fontSize=18,
            leading=23,
            textColor=CHARCOAL,
            backColor=PALE_AMBER,
            borderColor=AMBER,
            borderWidth=0.8,
            borderPadding=(7, 8, 7, 8),
            spaceBefore=0,
            spaceAfter=15,
            keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "ManualH3",
            parent=sample["Heading2"],
            fontName=FONT_BOLD,
            fontSize=12.2,
            leading=16,
            textColor=AMBER,
            spaceBefore=12,
            spaceAfter=6,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "ManualBody",
            parent=sample["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=9.7,
            leading=13.6,
            textColor=CHARCOAL,
            alignment=TA_LEFT,
            spaceAfter=6,
            allowWidows=0,
            allowOrphans=0,
        ),
        "list": ParagraphStyle(
            "ManualList",
            parent=sample["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=9.5,
            bulletFontName=FONT_REGULAR,
            bulletFontSize=9.0,
            leading=12.7,
            textColor=CHARCOAL,
            spaceAfter=1.8,
            allowWidows=0,
            allowOrphans=0,
        ),
        "note": ParagraphStyle(
            "ManualNote",
            parent=sample["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=9.2,
            leading=12.8,
            textColor=CHARCOAL,
            spaceAfter=0,
            allowWidows=0,
            allowOrphans=0,
        ),
        "caption": ParagraphStyle(
            "ImageCaption",
            parent=sample["Normal"],
            fontName=FONT_ITALIC,
            fontSize=8.0,
            leading=11,
            textColor=MID_GRAY,
            alignment=TA_CENTER,
            spaceBefore=4,
            spaceAfter=10,
        ),
        "table": ParagraphStyle(
            "TableCell",
            parent=sample["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=7.8,
            leading=10.7,
            textColor=CHARCOAL,
            spaceAfter=0,
        ),
        "table_header": ParagraphStyle(
            "TableHeader",
            parent=sample["BodyText"],
            fontName=FONT_BOLD,
            fontSize=7.8,
            leading=10.7,
            textColor=CHARCOAL,
            spaceAfter=0,
        ),
    }


def _table_widths(node: TableNode, available_width: float) -> list[float]:
    columns = len(node.headers)
    texts_by_column = [
        [node.headers[column], *(row[column] for row in node.rows)]
        for column in range(columns)
    ]
    weights: list[float] = []
    for values in texts_by_column:
        longest_word = max(
            (len(word) for value in values for word in _plain_text(value).split()),
            default=4,
        )
        typical = max((len(_plain_text(value)) for value in values), default=4)
        weights.append(max(5.0, min(24.0, longest_word * 0.75 + typical**0.5)))
    minimum = min(48.0, available_width / columns)
    remaining = max(available_width - minimum * columns, 0)
    total_weight = sum(weights)
    widths = [minimum + remaining * weight / total_weight for weight in weights]
    return widths


def _make_table(
    node: TableNode,
    inline: InlineRenderer,
    styles: dict[str, ParagraphStyle],
) -> LongTable:
    data: list[list[Paragraph]] = [
        [Paragraph(inline.render(cell, node.line), styles["table_header"]) for cell in node.headers]
    ]
    for offset, row in enumerate(node.rows, start=1):
        data.append(
            [Paragraph(inline.render(cell, node.line + offset), styles["table"]) for cell in row]
        )
    widths = _table_widths(node, FRAME_WIDTH)
    table = LongTable(
        data,
        colWidths=widths,
        repeatRows=1,
        hAlign="LEFT",
        splitByRow=1,
        splitInRow=1,
        spaceBefore=4,
        spaceAfter=10,
    )
    commands: list[tuple] = [
        ("BACKGROUND", (0, 0), (-1, 0), PALE_AMBER),
        ("TEXTCOLOR", (0, 0), (-1, -1), CHARCOAL),
        ("GRID", (0, 0), (-1, -1), 0.45, LIGHT_GRAY),
        ("BOX", (0, 0), (-1, -1), 0.7, MID_GRAY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for row_number in range(2, len(data), 2):
        commands.append(("BACKGROUND", (0, row_number), (-1, row_number), HexColor("#FAFAF8")))
    table.setStyle(TableStyle(commands))
    return table


def _make_image(
    node: ImageNode,
    inline: InlineRenderer,
    styles: dict[str, ParagraphStyle],
) -> KeepTogether:
    max_width = FRAME_WIDTH
    max_height = 105 * mm
    scale = min(
        max_width / node.pixel_width,
        max_height / node.pixel_height,
        1.0,
    )
    width = node.pixel_width * scale
    height = node.pixel_height * scale
    image = Image(str(node.path), width=width, height=height)
    image.hAlign = "CENTER"
    image._restrictSize(max_width, max_height)
    caption = Paragraph(inline.render(node.caption, node.line), styles["caption"])
    return KeepTogether([image, caption], maxHeight=max_height + 30)


def _heading_flowable(
    node: HeadingNode,
    inline: InlineRenderer,
    styles: dict[str, ParagraphStyle],
) -> Paragraph:
    paragraph = Paragraph(inline.render(node.markdown, node.line), styles[f"h{node.level}"])
    paragraph.manual_heading_level = node.level
    paragraph.manual_heading_text = node.plain
    paragraph.manual_heading_key = node.anchor
    return paragraph


def _make_story(parsed: ParsedManual, source: Path, output: Path) -> list[Flowable]:
    styles = _styles()
    inline = InlineRenderer(source, output, parsed.anchors)
    story: list[Flowable] = []

    first_chapter_index = next(
        index
        for index, node in enumerate(parsed.nodes)
        if isinstance(node, HeadingNode) and node.level == 2
    )
    preface_nodes: list[Node] = []
    for node in parsed.nodes[:first_chapter_index]:
        if isinstance(node, HeadingNode) and node.level == 1:
            # Validate links in the source H1 even though the cover title is fixed.
            inline.render(node.markdown, node.line)
        elif isinstance(node, (ParagraphNode, RuleNode)):
            preface_nodes.append(node)
        else:
            raise ManualError(
                f"line {node.line}: front matter before the first H2 supports prose and horizontal rules only"
            )
    body_nodes = parsed.nodes[first_chapter_index:]

    cover_flowables: list[Flowable] = [
        Spacer(1, 48 * mm),
        Paragraph(_pdf_text("DONWELLS CUE", "cover title"), styles["cover_brand"]),
        Paragraph(
            f'{_pdf_text("Operator’s", "cover title")}<br/>{_pdf_text("Manual", "cover title")}',
            styles["cover_title"],
        ),
        Paragraph(
            _pdf_text("Preparation, playback, recovery, and live-show operations", "cover subtitle"),
            styles["cover_subtitle"],
        ),
        HRFlowable(
            width="34%",
            thickness=2,
            color=AMBER,
            hAlign="LEFT",
            spaceBefore=0,
            spaceAfter=18,
        ),
        Table(
            [
                [
                    Paragraph(_pdf_text("VERSION", "cover metadata label"), styles["cover_meta"]),
                    Paragraph(html.escape(_pdf_text(parsed.metadata.version, "version metadata")), styles["cover_meta"]),
                ],
                [
                    Paragraph(_pdf_text("SOURCE REVISION", "cover metadata label"), styles["cover_meta"]),
                    Paragraph(
                        html.escape(_pdf_text(parsed.metadata.source_revision, "source revision metadata")),
                        styles["cover_meta"],
                    ),
                ],
            ],
            colWidths=[36 * mm, 70 * mm],
            style=TableStyle(
                [
                    ("FONTNAME", (0, 0), (0, -1), FONT_BOLD),
                    ("TEXTCOLOR", (0, 0), (0, -1), MID_GRAY),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            ),
            hAlign="LEFT",
        ),
    ]
    if preface_nodes:
        cover_flowables.append(
            HRFlowable(
                width="100%",
                thickness=0.5,
                color=LIGHT_GRAY,
                spaceBefore=14,
                spaceAfter=0,
            )
        )
        for node in preface_nodes:
            if isinstance(node, ParagraphNode):
                cover_flowables.append(
                    Paragraph(
                        inline.render(node.markdown, node.line),
                        styles["cover_preface"],
                    )
                )
            else:
                cover_flowables.append(
                    HRFlowable(
                        width="100%",
                        thickness=0.5,
                        color=LIGHT_GRAY,
                        spaceBefore=6,
                        spaceAfter=0,
                    )
                )
    cover_flowables.extend([NextPageTemplate("Content"), PageBreak()])
    story.extend(cover_flowables)

    toc = TableOfContents()
    toc.levelStyles = [styles["toc_h2"], styles["toc_h3"]]
    toc.dotsMinLevel = 0
    story.extend(
        [
            Paragraph(_pdf_text("Contents", "contents title"), styles["toc_title"]),
            Paragraph(
                _pdf_text("Chapters and subsections are linked to their pages.", "contents introduction"),
                styles["body"],
            ),
            toc,
            PageBreak(),
        ]
    )

    body_started = False
    last_was_page_break = True
    for node in body_nodes:
        if isinstance(node, HeadingNode) and node.level == 2:
            if body_started and not last_was_page_break:
                story.append(PageBreak())
            story.append(_heading_flowable(node, inline, styles))
            body_started = True
            last_was_page_break = False
            continue
        if isinstance(node, HeadingNode):
            story.append(_heading_flowable(node, inline, styles))
        elif isinstance(node, ParagraphNode):
            story.append(Paragraph(inline.render(node.markdown, node.line), styles["body"]))
        elif isinstance(node, ListItemNode):
            left_indent = 18 + node.depth * 14
            list_style = ParagraphStyle(
                f"ListDepth{node.depth}",
                parent=styles["list"],
                leftIndent=left_indent,
                firstLineIndent=-14,
                bulletIndent=left_indent - 14,
            )
            marker = node.marker
            if marker in {"-", "+", "*"}:
                marker = "•"
            story.append(
                Paragraph(
                    inline.render(node.markdown, node.line),
                    list_style,
                    bulletText=html.escape(_pdf_text(marker, f"line {node.line} list marker")),
                )
            )
        elif isinstance(node, TableNode):
            story.append(_make_table(node, inline, styles))
        elif isinstance(node, CodeNode):
            story.append(
                CodeBlock(node.lines, node.language, context=f"line {node.line} fenced code")
            )
        elif isinstance(node, QuoteNode):
            paragraph = Paragraph(inline.render(node.markdown, node.line), styles["note"])
            story.append(SafetyNote(paragraph, node.label))
        elif isinstance(node, ImageNode):
            story.append(_make_image(node, inline, styles))
        elif isinstance(node, PageBreakNode):
            if not last_was_page_break:
                story.append(PageBreak())
        elif isinstance(node, DiagramNode):
            story.append(SignalFlowDiagram() if node.name == "signal-flow" else RecoveryDiagram())
        elif isinstance(node, RuleNode):
            story.append(
                HRFlowable(
                    width="100%",
                    thickness=0.6,
                    color=LIGHT_GRAY,
                    spaceBefore=5,
                    spaceAfter=9,
                )
            )
        else:  # pragma: no cover - the closed Node union makes this defensive.
            raise ManualError(f"unhandled source node: {type(node).__name__}")
        body_started = True
        last_was_page_break = isinstance(node, PageBreakNode)

    return story


def generate_manual(source: str | Path = DEFAULT_SOURCE, output: str | Path = DEFAULT_OUTPUT) -> Path:
    """Generate *output* atomically from the supported Markdown in *source*."""

    _register_fonts()
    source_path = Path(source).expanduser().resolve()
    output_path = Path(output).expanduser().resolve()
    if not source_path.is_file():
        raise ManualError(f"source Markdown does not exist: {source_path}")
    try:
        text = source_path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise ManualError(f"source Markdown is not valid UTF-8: {source_path}") from error
    parsed = parse_manual(source_path, text)
    story = _make_story(parsed, source_path, output_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.stem}-",
        suffix=".tmp.pdf",
        dir=output_path.parent,
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        document = ManualDocTemplate(str(temporary_path), parsed.metadata)
        document.multiBuild(story, maxPasses=12)
        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            raise ManualError("ReportLab did not produce a PDF")
        os.replace(temporary_path, output_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return output_path


def _argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate the DonWells Cue operator manual PDF from Markdown.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"Markdown source (default: {DEFAULT_SOURCE.relative_to(REPO_ROOT)})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"PDF destination (default: {DEFAULT_OUTPUT.relative_to(REPO_ROOT)})",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _argument_parser().parse_args(argv)
    try:
        result = generate_manual(arguments.source, arguments.output)
    except (ManualError, OSError, ValueError) as error:
        print(f"[generate-operators-manual] ERROR: {error}", file=sys.stderr)
        return 2
    print(f"[generate-operators-manual] Wrote {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
