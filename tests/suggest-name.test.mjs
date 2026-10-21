import test from "node:test";
import assert from "node:assert/strict";
import { suggestMarkdownName } from "../electron/suggest-name.mjs";

test("suggestMarkdownName: extracts markdown ATX headings", () => {
  const md = "# 完全可以，而且非常契合！\n\n正文内容";
  assert.equal(suggestMarkdownName(md), "完全可以，而且非常契合！.md");

  const mdH2 = "## 这是二级标题\n正文";
  assert.equal(suggestMarkdownName(mdH2), "这是二级标题.md");
});

test("suggestMarkdownName: extracts first paragraph if no heading exists", () => {
  const md = "\n\n这是第一段正文的内容。\n第二段";
  assert.equal(suggestMarkdownName(md), "这是第一段正文的内容。.md");

  const mdWithList = "- 这是列表项内容\n- 第二项";
  assert.equal(suggestMarkdownName(mdWithList), "这是列表项内容.md");
});

test("suggestMarkdownName: skips frontmatter correctly", () => {
  const md = `---
author: test
date: 2026-10-21
---

# 正式标题内容
正文`;
  assert.equal(suggestMarkdownName(md), "正式标题内容.md");
});

test("suggestMarkdownName: sanitizes illegal filename characters", () => {
  const md = '# 包含:非法/字符*与?和"引号<还有>竖线|的标题\n正文';
  const name = suggestMarkdownName(md);
  assert.equal(name.includes("/"), false);
  assert.equal(name.includes("\\"), false);
  assert.equal(name.includes(":"), false);
  assert.equal(name.includes("*"), false);
  assert.equal(name.includes("?"), false);
  assert.equal(name.includes('"'), false);
  assert.equal(name.includes("<"), false);
  assert.equal(name.includes(">"), false);
  assert.equal(name.includes("|"), false);
  assert.equal(name, "包含非法字符与和引号还有竖线的标题.md");
});

test("suggestMarkdownName: fallback to default if empty", () => {
  assert.equal(suggestMarkdownName(""), "未命名.md");
  assert.equal(suggestMarkdownName("   \n\n   "), "未命名.md");
  assert.equal(suggestMarkdownName("", "草稿1.md"), "草稿1.md");
});
