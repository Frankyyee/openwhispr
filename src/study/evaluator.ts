import { EVAL_SYSTEM, QUESTION_SYSTEM, evalUser, questionUser } from "./prompts";
import type { Chunk, Evaluation, LLM, Verdict } from "./types";

const VERDICTS: Verdict[] = ["correct", "incomplete", "wrong", "offtopic"];

export function parseJson<T = Record<string, unknown>>(raw: string): T | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function ids(value: unknown, allowed: Set<string>): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && allowed.has(v))
    : [];
}

export async function evaluate(
  llm: LLM,
  opts: { utterance: string; question?: string; context?: string; chunks: Chunk[] }
): Promise<Evaluation> {
  const raw = await llm(EVAL_SYSTEM, evalUser(opts));
  const j = parseJson<Record<string, unknown>>(raw);
  const allowed = new Set(opts.chunks.map((c) => c.id));
  if (!j || !VERDICTS.includes(j.verdict as Verdict)) {
    // An unreadable judgement must never be shown to the student as a mistake.
    return {
      verdict: "offtopic",
      issue: "",
      correction: "",
      coveredChunkIds: [],
      missedChunkIds: [],
      major: false,
    };
  }
  return {
    verdict: j.verdict as Verdict,
    issue: String(j.issue ?? ""),
    correction: String(j.correction ?? ""),
    coveredChunkIds: ids(j.covered_chunk_ids, allowed),
    missedChunkIds: ids(j.missed_chunk_ids, allowed),
    major: j.verdict === "wrong" || j.major === true,
  };
}

export async function generateQuestion(
  llm: LLM,
  opts: { topicTitle: string; chunks: Chunk[]; language: string; avoid: string[] }
): Promise<string | null> {
  const j = parseJson<{ question?: string }>(await llm(QUESTION_SYSTEM, questionUser(opts)));
  return j?.question?.trim() || null;
}
