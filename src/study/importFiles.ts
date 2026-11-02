/** Reads one entry out of a ZIP (DOCX) using the browser's own inflate. */
async function readZipEntry(buf: ArrayBuffer, name: string): Promise<Uint8Array | null> {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const entry = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    if (entry === name) {
      const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = new Uint8Array(buf, dataStart, compSize);
      if (method === 0) return data;
      if (method !== 8) return null;
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** DOCX → Markdown-ish text: Word heading styles become "#" headings so topics follow them. */
export function docxXmlToText(xml: string): string {
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs
    .map((p) => {
      const text = decodeEntities(
        (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")
      );
      const heading = /<w:pStyle w:val="(?:Heading|Titolo|Title)(\d?)"/i.exec(p);
      if (!text.trim()) return "";
      return heading ? `${"#".repeat(Math.min(Number(heading[1]) || 1, 6))} ${text}` : text;
    })
    .filter(Boolean)
    .join("\n\n");
}

export const SUPPORTED_EXTENSIONS = [".txt", ".md", ".markdown", ".docx"];

export async function readStudyFile(file: File): Promise<string | null> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".docx")) {
    const xml = await readZipEntry(await file.arrayBuffer(), "word/document.xml");
    return xml ? docxXmlToText(new TextDecoder().decode(xml)) : null;
  }
  if (SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) return file.text();
  return null;
}
