import type { Chunk } from "./types";

const STOPWORDS = new Set(
  (
    "il lo la i gli le un uno una di a da in con su per tra fra e ed o ma che chi cui non è sono " +
    "del della dei delle al alla ai alle nel nella come più se si the a an of to in on for and or " +
    "but is are was were be been it its that this these those with as by at from not"
  ).split(" ")
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

// Light suffix stripping so "cellule"/"cellula", "cells"/"cell" collide.
function stem(t: string): string {
  return t.length > 5 ? t.replace(/(ing|ed|es|s|e|i|a|o|zione|zioni|mente)$/, "") : t;
}

/** BM25 over chunks. Lexical on purpose: works offline in both languages. */
export class Retriever {
  private tfs: Map<string, number>[] = [];
  private lens: number[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(private chunks: Chunk[]) {
    for (const c of chunks) {
      const toks = tokenize(`${c.heading} ${c.text}`);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tfs.push(tf);
      this.lens.push(toks.length);
    }
    this.avgLen = this.lens.reduce((a, b) => a + b, 0) / (this.lens.length || 1);
  }

  search(query: string, k = 5): Chunk[] {
    const q = tokenize(query);
    const N = this.chunks.length;
    const scored = this.chunks.map((chunk, i) => {
      let score = 0;
      for (const t of q) {
        const f = this.tfs[i].get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * (f * 2.2)) / (f + 1.2 * (0.25 + 0.75 * (this.lens[i] / this.avgLen)));
      }
      return { chunk, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.chunk);
  }
}
