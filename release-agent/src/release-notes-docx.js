const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");

/**
 * Very lightweight markdown-to-docx conversion, just enough for the
 * markdown headers/bullets/paragraphs that Copilot's changelog drafts
 * actually use (see src/ai.js's draftChangelog prompt). Not a general
 * markdown parser -- things like bold/italic inline formatting, tables,
 * or nested lists won't render specially, they'll just show as plain text.
 */
function parseMarkdownToParagraphs(markdown) {
  const lines = markdown.split("\n");
  const paragraphs = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    if (line.startsWith("### ")) {
      paragraphs.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (line.startsWith("## ")) {
      paragraphs.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith("# ")) {
      paragraphs.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (/^[-*]\s+/.test(line)) {
      paragraphs.push(new Paragraph({ text: line.replace(/^[-*]\s+/, ""), bullet: { level: 0 } }));
    } else {
      paragraphs.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }

  return paragraphs;
}

/**
 * Builds a Word document (.docx) buffer from a release's changelog
 * markdown, suitable for uploading directly to Slack via files.uploadV2.
 */
async function buildReleaseNotesDocx(branch, changelogMarkdown) {
  const generatedDate = new Date().toISOString().slice(0, 10);

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: `Release Notes — ${branch}`, heading: HeadingLevel.TITLE, spacing: { after: 80 } }),
          new Paragraph({
            children: [new TextRun({ text: `Generated ${generatedDate}`, italics: true, color: "555555" })],
            spacing: { after: 300 },
          }),
          ...parseMarkdownToParagraphs(changelogMarkdown),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildReleaseNotesDocx };
