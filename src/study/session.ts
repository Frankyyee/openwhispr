import { evaluate, generateQuestion } from "./evaluator";
import { Retriever } from "./retriever";
import { buildReport, type StudyReport } from "./report";
import type {
  Chunk,
  Evaluation,
  FeedbackTiming,
  Finding,
  LLM,
  StudyCorpus,
  StudyMode,
  StudyProgress,
} from "./types";

export interface SessionOptions {
  mode: StudyMode;
  feedback: FeedbackTiming;
  /** Language used for generated questions ("it" | "en"). Answers are judged in whatever language is spoken. */
  questionLanguage?: string;
  /** Coverage and weak topics carried over from earlier sessions. */
  progress?: StudyProgress;
}

export interface Turn {
  /** True when the UI should stop the student now and show `finding`. */
  interrupt: boolean;
  finding: Finding;
}

export class StudySession {
  readonly findings: Finding[] = [];
  private covered: Set<string>;
  private weak = new Map<string, number>(); // topicId -> error count
  private asked: string[] = [];
  private currentQuestion: { text: string; chunks: Chunk[] } | null = null;
  private retriever: Retriever;
  private byId: Map<string, Chunk>;
  private startedAt = Date.now();

  constructor(
    private llm: LLM,
    readonly corpus: StudyCorpus,
    readonly opts: SessionOptions
  ) {
    this.retriever = new Retriever(corpus.chunks);
    this.byId = new Map(corpus.chunks.map((c) => [c.id, c]));
    const known = new Set(corpus.chunks.map((c) => c.id));
    this.covered = new Set((opts.progress?.covered ?? []).filter((id) => known.has(id)));
    for (const [t, n] of Object.entries(opts.progress?.weak ?? {})) this.weak.set(t, n);
  }

  /** Snapshot to persist so the next session continues from here. */
  progress(): StudyProgress {
    return { covered: [...this.covered], weak: Object.fromEntries(this.weak) };
  }

  get coveredChunkIds(): ReadonlySet<string> {
    return this.covered;
  }

  /** Free recall: the student keeps talking; call with each finished passage. */
  async submitFreeRecall(utterance: string): Promise<Turn | null> {
    if (utterance.trim().split(/\s+/).length < 4) return null;
    const context = this.lastFree;
    this.lastFree = utterance;
    // Retrieve with the previous passage too, so "they produce ATP" still finds mitochondria.
    const chunks = this.retriever.search(`${context} ${utterance}`, 5);
    if (!chunks.length) return null;
    return this.record(await evaluate(this.llm, { utterance, context, chunks }), utterance, "free");
  }
  private lastFree = "";

  /** Quiz: picks the next uncovered / weakest topic and asks about it. */
  async nextQuestion(): Promise<string | null> {
    const topic = this.pickTopic();
    if (!topic) return null;
    const pool = topic.chunkIds
      .map((id) => this.byId.get(id)!)
      .sort((a, b) => Number(this.covered.has(a.id)) - Number(this.covered.has(b.id)))
      .slice(0, 4);
    const text = await generateQuestion(this.llm, {
      topicTitle: topic.title,
      chunks: pool,
      language: this.opts.questionLanguage ?? "it",
      avoid: this.asked,
    });
    if (!text) return null;
    this.asked.push(text);
    this.currentQuestion = { text, chunks: pool };
    return text;
  }

  async answer(utterance: string): Promise<Turn | null> {
    const q = this.currentQuestion;
    if (!q) return null;
    // Union of the topic's chunks and anything else the answer touches, so a
    // correct answer drawing on a neighbouring topic is not marked wrong.
    const extra = this.retriever
      .search(utterance, 3)
      .filter((c) => !q.chunks.some((x) => x.id === c.id));
    const chunks = [...q.chunks, ...extra];
    const turn = this.record(
      await evaluate(this.llm, { utterance, question: q.text, chunks }),
      utterance,
      "quiz",
      q.text
    );
    if (turn.finding.verdict === "correct") this.currentQuestion = null;
    return turn;
  }

  finish(): StudyReport {
    return buildReport({
      corpus: this.corpus,
      findings: this.findings,
      covered: this.covered,
      durationMs: Date.now() - this.startedAt,
      questionsAsked: this.asked.length,
    });
  }

  /** Deferred mode: everything collected so far, for the end-of-session screen. */
  get pendingFindings(): Finding[] {
    return this.findings.filter((f) => f.verdict === "wrong" || f.verdict === "incomplete");
  }

  private record(ev: Evaluation, userSaid: string, mode: StudyMode, question?: string): Turn {
    const topicIds = [
      ...new Set(
        [...ev.coveredChunkIds, ...ev.missedChunkIds]
          .map((id) => this.byId.get(id)?.topicId)
          .filter(Boolean) as string[]
      ),
    ];
    const finding: Finding = {
      ...ev,
      id: this.findings.length + 1,
      mode,
      question,
      userSaid,
      topicIds,
      at: Date.now(),
    };
    this.findings.push(finding);
    for (const id of ev.coveredChunkIds) if (!ev.missedChunkIds.includes(id)) this.covered.add(id);
    if (ev.verdict === "wrong" || ev.verdict === "incomplete") {
      for (const id of ev.missedChunkIds) {
        const t = this.byId.get(id)?.topicId;
        if (t) this.weak.set(t, (this.weak.get(t) ?? 0) + 1);
        this.covered.delete(id);
      }
    }
    // Free recall only stops you for serious problems: you may be about to cover the rest.
    // A quiz answer is complete when you stop, so any gap is worth stopping for.
    const flagged = ev.verdict === "wrong" || ev.verdict === "incomplete";
    const interrupt =
      this.opts.feedback === "immediate" && flagged && (mode === "quiz" || ev.major);
    return { interrupt, finding };
  }

  /** Weakest first (repeated errors), then least covered. Fully covered topics are skipped. */
  private pickTopic() {
    const ranked = this.corpus.topics
      .map((t) => {
        const done = t.chunkIds.filter((id) => this.covered.has(id)).length;
        return { t, ratio: done / (t.chunkIds.length || 1), errors: this.weak.get(t.id) ?? 0 };
      })
      .filter((r) => r.ratio < 1)
      .sort((a, b) => b.errors - a.errors || a.ratio - b.ratio);
    return ranked[0]?.t ?? null;
  }
}
