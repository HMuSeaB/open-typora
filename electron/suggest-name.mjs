/**
 * 智能提取 Markdown 正文的标题或首段文字作为保存建议文件名
 * @param {string} text Markdown 正文内容
 * @param {string} [fallbackName="未命名.md"] 备选名称
 * @returns {string} 安全的文件名（如 "我的笔记.md"）
 */
export function suggestMarkdownName(text, fallbackName = "未命名.md") {
  if (!text || typeof text !== "string") return fallbackName;
  const lines = text.split(/\r?\n/);
  let inFrontmatter = false;
  let candidate = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 跳过 YAML Frontmatter: --- ... ---
    if (i === 0 && (line === "---" || line === "...")) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === "---" || line === "...") inFrontmatter = false;
      continue;
    }

    if (!line) continue;

    // 1. 优先匹配 ATX 标题: # 标题内容
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      candidate = headingMatch[1].trim();
      break;
    }

    // 跳过代码栅栏与表格分隔符
    if (line.startsWith("```") || line.startsWith("~~~") || /^\|?[-:\s|]+\|?$/.test(line)) {
      continue;
    }

    // 2. 清除 Markdown 语法标记提取有效正文
    const cleaned = line
      .replace(/^[\s>*\-+]+/, "") // 引用与列表前缀
      .replace(/^\d+[.)]\s+/, "") // 有序列表如 1. 
      .replace(/^\[[ xX]\]\s+/, "") // 任务列表如 [x]
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片提取 alt
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接提取文本
      .replace(/[`*_~=]+/g, "") // 粗体、斜体、行内代码、高亮符号
      .trim();

    if (cleaned) {
      candidate = cleaned;
      break;
    }
  }

  if (!candidate) return fallbackName;

  // 过滤 Windows/macOS 非法文件名字符: \ / : * ? " < > | 及控制字符
  candidate = candidate
    .replace(/[\\/:*?"<>|\r\n\t]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // 截取安全长度（前 50 字符）
  candidate = candidate.slice(0, 50).trim();

  if (!candidate) return fallbackName;

  return candidate.endsWith(".md") ? candidate : `${candidate}.md`;
}
