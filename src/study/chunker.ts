import type { Chunk, StudyCorpus, Topic } from "./types";

const MAX_CHARS = 900;

export interface SourceDoc {
  id: string;
  name: string;
  text: string;
}

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHARS) return [paragraph];
  const sentences = paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > MAX_CHARS) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Splits documents into retrievable chunks and groups them into topics.
 * A topic is a markdown-style heading section; documents without headings
 * get one topic per ~4 chunks so coverage stays meaningful.
 */
export function buildCorpus(docs: SourceDoc[]): StudyCorpus {
  const chunks: Chunk[] = [];
  const topics: Topic[] = [];

  for (const doc of docs) {
    const lines = doc.text.replace(/\r\n/g, "\n").split("\n");
    const sections: { heading: string; body: string[] }[] = [{ heading: doc.name, body: [] }];
    let hasHeadings = false;
    for (const line of lines) {
      const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (m) {
        hasHeadings = true;
        sections.push({ heading: m[2], body: [] });
      } else {
        sections[sections.length - 1].body.push(line);
      }
    }

    let chunkCount = 0;
    sections.forEach((section, si) => {
      const paragraphs = section.body
        .join("\n")
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .flatMap(splitLong);
      if (!paragraphs.length) return;

      let topic: Topic | null = null;
      const newTopic = (title: string) => {
        topic = { id: `${doc.id}:t${topics.length}`, title, chunkIds: [] };
        topics.push(topic);
      };
      if (hasHeadings) newTopic(section.heading);

      paragraphs.forEach((text, pi) => {
        if (!hasHeadings && pi % 4 === 0) {
          newTopic(`${doc.name} (${Math.floor(pi / 4) + 1})`);
        }
        const t = topic as Topic | null;
        if (!t) return;
        const chunk: Chunk = {
          id: `${doc.id}:c${si}-${pi}`,
          docId: doc.id,
          docName: doc.name,
          heading: section.heading,
          topicId: t.id,
          text,
        };
        t.chunkIds.push(chunk.id);
        chunks.push(chunk);
        chunkCount++;
      });
    });
    void chunkCount;
  }

  return { chunks, topics };
}
