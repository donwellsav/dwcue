#!/usr/bin/env python3
"""Focused regression tests for the operator manual inline parser."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from html.parser import HTMLParser
from pathlib import Path


GENERATOR_PATH = Path(__file__).with_name("generate-operators-manual.py")
SPEC = importlib.util.spec_from_file_location("generate_operators_manual", GENERATOR_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot import {GENERATOR_PATH}")
manual = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = manual
SPEC.loader.exec_module(manual)


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "link":
            return
        href = dict(attrs).get("href")
        if href is not None:
            self.hrefs.append(href)


class InlineRendererTests(unittest.TestCase):
    def setUp(self) -> None:
        self.renderer = manual.InlineRenderer(
            GENERATOR_PATH.parent.parent / "docs" / "operators-manual.md",
            GENERATOR_PATH.parent.parent / "docs" / "operators-manual.pdf",
            frozenset(),
        )

    def assert_rendered_link(self, markdown: str, expected_href: str) -> None:
        parser = _LinkParser()
        parser.feed(self.renderer.render(markdown, 17))
        self.assertEqual(parser.hrefs, [expected_href])

    def test_balanced_destinations_render_full_href_and_plain_text(self) -> None:
        cases = (
            (
                "nested parentheses",
                "https://example.com/photos/a(b(c)d)e",
                "https://example.com/photos/a(b(c)d)e",
            ),
            (
                "escaped parentheses",
                r"https://example.com/photos/a\(b\)",
                "https://example.com/photos/a(b)",
            ),
            (
                "angle-bracket destination",
                "<https://example.com/photos/a_(b)>",
                "https://example.com/photos/a_(b)",
            ),
        )
        for name, source_destination, expected_href in cases:
            with self.subTest(name=name):
                markdown = f"Photo [credit]({source_destination}) by Studio."
                self.assert_rendered_link(markdown, expected_href)
                self.assertEqual(manual._plain_text(markdown), "Photo credit by Studio.")

    def test_plain_text_strips_complete_balanced_image_destination(self) -> None:
        markdown = "![Poster](https://example.com/posters/a(b(c)d)e)"
        self.assertEqual(manual._plain_text(markdown), "Poster")

    def test_unclosed_destinations_fail_without_consuming_a_partial_target(self) -> None:
        malformed = (
            "See [broken](https://example.com/a(b)",
            "See [broken](<https://example.com/a(b)>",
        )
        for markdown in malformed:
            with self.subTest(markdown=markdown):
                with self.assertRaisesRegex(manual.ManualError, "malformed unclosed"):
                    self.renderer.render(markdown, 23)
                with self.assertRaisesRegex(manual.ManualError, "malformed unclosed"):
                    manual._plain_text(markdown)

        ordinary_brackets = "Keep [ordinary brackets] as visible text."
        self.assertEqual(manual._plain_text(ordinary_brackets), ordinary_brackets)

    def test_emphasis_code_and_allow_links_false_behavior_are_preserved(self) -> None:
        markdown = "Use **bold**, *italic*, _also italic_, and `code`."
        rendered = self.renderer.render(markdown, 31)
        self.assertIn("<b>bold</b>", rendered)
        self.assertIn("<i>italic</i>", rendered)
        self.assertIn("<i>also italic</i>", rendered)
        self.assertIn("&#160;code&#160;", rendered)
        self.assertEqual(
            manual._plain_text(markdown),
            "Use bold, italic, also italic, and code.",
        )

        label_only = self.renderer.render(
            "[**nested label**](unsupported:destination)",
            32,
            allow_links=False,
        )
        self.assertEqual(label_only, "nested label")
        self.assertNotIn("<link", label_only)


if __name__ == "__main__":
    unittest.main()
