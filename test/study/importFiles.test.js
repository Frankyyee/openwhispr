const test = require("node:test");
const assert = require("node:assert/strict");
const { docxXmlToText } = require("../../src/study/importFiles.ts");

test("DOCX headings become markdown headings, entities are decoded", () => {
  const xml =
    '<w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Mitocondri</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Producono ATP </w:t></w:r><w:r><w:t>&amp; calore</w:t></w:r></w:p>' +
    "<w:p></w:p></w:body>";
  assert.equal(docxXmlToText(xml), "## Mitocondri\n\nProducono ATP & calore");
});
