import { REPORT_SYSTEM } from "./prompts";
import type { Finding, LLM, StudyCorpus } from "./types";

export interface TopicStat {
  topicId: string;
  title: string;
  coveredPct: number;
  errors: number;
}

export interface StudyReport {
  durationMs: number;
  questionsAsked: number;
  coveragePct: number;
  counts: Record<"correct" | "incomplete" | "wrong" | "offtopic", number>;
  topics: TopicStat[];
  strengths: TopicStat[];
  toImprove: TopicStat[];
  mistakes: Finding[];
}

export function buildReport(args: {
  corpus: StudyCorpus;
  findings: Finding[];
  covered: ReadonlySet<string>;
  durationMs: number;
  questionsAsked: number;
}): StudyReport {
  const { corpus, findings, covered } = args;
  const counts = { correct: 0, incomplete: 0, wrong: 0, offtopic: 0 };
  const errorsByTopic = new Map<string, number>();
  for (const f of findings) {
    counts[f.verdict]++;
    if (f.verdict === "wrong" || f.verdict === "incomplete") {
      for (const t of f.topicIds) errorsByTopic.set(t, (errorsByTopic.get(t) ?? 0) + 1);
    }
  }
  const topics: TopicStat[] = corpus.topics.map((t) => ({
    topicId: t.id,
    title: t.title,
    coveredPct: Math.round(
      (100 * t.chunkIds.filter((id) => covered.has(id)).length) / (t.chunkIds.length || 1)
    ),
    errors: errorsByTopic.get(t.id) ?? 0,
  }));
  const total = corpus.chunks.length || 1;
  return {
    durationMs: args.durationMs,
    questionsAsked: args.questionsAsked,
    coveragePct: Math.round((100 * corpus.chunks.filter((c) => covered.has(c.id)).length) / total),
    counts,
    topics,
    strengths: topics.filter((t) => t.coveredPct >= 80 && t.errors === 0),
    toImprove: topics
      .filter((t) => t.errors > 0 || t.coveredPct < 40)
      .sort((a, b) => b.errors - a.errors || a.coveredPct - b.coveredPct),
    mistakes: findings.filter((f) => f.verdict === "wrong" || f.verdict === "incomplete"),
  };
}

/** Optional narrative on top of the deterministic numbers. Never throws. */
export async function narrate(llm: LLM, report: StudyReport, language: string): Promise<string> {
  const data = JSON.stringify({
    language,
    coveragePct: report.coveragePct,
    counts: report.counts,
    strengths: report.strengths.map((t) => t.title),
    toImprove: report.toImprove.map((t) => ({
      title: t.title,
      errors: t.errors,
      coveredPct: t.coveredPct,
    })),
    mistakes: report.mistakes
      .slice(0, 12)
      .map((m) => ({ said: m.userSaid.slice(0, 160), issue: m.issue })),
  });
  try {
    return await llm(REPORT_SYSTEM, data);
  } catch {
    return "";
  }
}
