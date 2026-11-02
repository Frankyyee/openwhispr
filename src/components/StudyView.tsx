import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { MarkdownRenderer } from "./ui/MarkdownRenderer";
import { Brain, Check, FileText, Loader2, Mic, Square, Trash2, X } from "./icons";
import { buildCorpus, type SourceDoc } from "../study/chunker";
import { StudySession } from "../study/session";
import { narrate, type StudyReport } from "../study/report";
import { createStudyLLM, describeStudyLLM, isStudyLLMConfigured } from "../study/llm";
import { readStudyFile, SUPPORTED_EXTENSIONS } from "../study/importFiles";
import { speak, stopSpeaking, guessLang } from "../study/speech";
import { useStudyListener } from "../study/useStudyListener";
import {
  appendHistory,
  docIdFor,
  loadDocs,
  loadHistory,
  loadProgress,
  saveDocs,
  saveProgress,
} from "../study/storage";
import type { FeedbackTiming, Finding, StudyMode, StudyProgress, Verdict } from "../study/types";

type Phase = "setup" | "running" | "report";
type QuizState = "asking" | "listening" | "evaluating" | "feedback" | "done";

interface Item {
  id: number;
  text: string;
  question?: string;
  finding?: Finding;
}

const VERDICT_STYLE: Record<Verdict, string> = {
  correct: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  incomplete: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  wrong: "bg-red-500/15 text-red-700 dark:text-red-300",
  offtopic: "bg-muted text-muted-foreground",
};

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-lg border p-3 text-left text-sm transition-colors ${
            value === o.value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
          }`}
        >
          <div className="font-medium">{o.label}</div>
          {o.hint && <div className="mt-0.5 text-xs text-muted-foreground">{o.hint}</div>}
        </button>
      ))}
    </div>
  );
}

export default function StudyView() {
  const { t, i18n } = useTranslation();

  // ── Materials ──────────────────────────────────────────────────────────────
  const [docs, setDocs] = useState<SourceDoc[]>(loadDocs);
  const [progress, setProgress] = useState<StudyProgress>(loadProgress);
  const [pasteName, setPasteName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const corpus = useMemo(() => buildCorpus(docs), [docs]);
  const coveredSet = useMemo(() => new Set(progress.covered), [progress]);
  const overallCoverage = corpus.chunks.length
    ? Math.round(
        (100 * corpus.chunks.filter((c) => coveredSet.has(c.id)).length) / corpus.chunks.length
      )
    : 0;

  const updateDocs = (next: SourceDoc[]) => {
    setDocs(next);
    if (!saveDocs(next)) setError(t("study.errors.storageFull"));
  };

  const addDoc = (name: string, text: string) => {
    const id = docIdFor(name);
    updateDocs([...docs.filter((d) => d.id !== id), { id, name, text }]);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const skipped: string[] = [];
    const added: SourceDoc[] = [];
    for (const file of Array.from(files)) {
      const text = await readStudyFile(file).catch(() => null);
      if (!text?.trim()) {
        skipped.push(file.name);
        continue;
      }
      const name = file.name.replace(/\.[^.]+$/, "");
      added.push({ id: docIdFor(name), name, text });
    }
    const ids = new Set(added.map((d) => d.id));
    updateDocs([...docs.filter((d) => !ids.has(d.id)), ...added]);
    if (skipped.length) setError(t("study.errors.unsupported", { files: skipped.join(", ") }));
  };

  // ── Session settings ───────────────────────────────────────────────────────
  const [mode, setMode] = useState<StudyMode>("free");
  const [feedback, setFeedback] = useState<FeedbackTiming>("immediate");
  const [questionLang, setQuestionLang] = useState<"it" | "en">(
    i18n.language.startsWith("it") ? "it" : "en"
  );
  const [sttLang, setSttLang] = useState<"auto" | "it" | "en">("auto");
  const [speakAloud, setSpeakAloud] = useState(true);

  // ── Running session ────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("setup");
  const sessionRef = useRef<StudySession | null>(null);
  const evalChain = useRef<Promise<unknown>>(Promise.resolve());
  const [items, setItems] = useState<Item[]>([]);
  const [evaluating, setEvaluating] = useState(0);
  const [interruption, setInterruption] = useState<Finding | null>(null);
  const interruptionRef = useRef<Finding | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [quizState, setQuizState] = useState<QuizState>("asking");
  const [lastAnswer, setLastAnswer] = useState<Finding | null>(null);
  const [report, setReport] = useState<StudyReport | null>(null);
  const [narrative, setNarrative] = useState<string | null>(null);
  const nextId = useRef(1);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const runEval = <T,>(fn: () => Promise<T>): Promise<T> => {
    setEvaluating((n) => n + 1);
    const p = evalChain.current.then(fn).finally(() => setEvaluating((n) => n - 1));
    evalChain.current = p.catch(() => {});
    return p;
  };

  const persist = (s: StudySession) => {
    const p = s.progress();
    setProgress(p);
    saveProgress(p);
  };

  const showInterruption = (f: Finding) => {
    if (interruptionRef.current) return; // one at a time; the rest stays in the report
    interruptionRef.current = f;
    setInterruption(f);
    if (speakAloud) void speak(`${f.issue} ${f.correction}`.trim(), guessLang(f.userSaid));
  };

  const onSegment = (text: string) => {
    const session = sessionRef.current;
    if (!session) return;
    if (modeRef.current === "free") {
      const id = nextId.current++;
      setItems((xs) => [...xs, { id, text }]);
      runEval(() => session.submitFreeRecall(text))
        .then((turn) => {
          persist(session);
          if (!turn) return;
          setItems((xs) => xs.map((x) => (x.id === id ? { ...x, finding: turn.finding } : x)));
          if (turn.interrupt) {
            listener.stop(false);
            showInterruption(turn.finding);
          }
        })
        .catch((e) => setError(String(e?.message ?? e)));
      return;
    }
    // Quiz answer
    setQuizState("evaluating");
    const q = question ?? undefined;
    runEval(() => session.answer(text))
      .then((turn) => {
        persist(session);
        if (!turn) return;
        setItems((xs) => [
          ...xs,
          { id: nextId.current++, text, question: q, finding: turn.finding },
        ]);
        if (session.opts.feedback === "immediate") {
          setLastAnswer(turn.finding);
          setQuizState("feedback");
          if (speakAloud) {
            const say =
              turn.finding.verdict === "correct"
                ? t("study.quiz.correctSpoken", { lng: questionLang })
                : `${turn.finding.issue} ${turn.finding.correction}`;
            void speak(say.trim(), questionLang);
          }
        } else {
          void askNext();
        }
      })
      .catch((e) => {
        setError(String(e?.message ?? e));
        setQuizState("feedback");
      });
  };

  const listener = useStudyListener({
    onSegment,
    onError: (m) => setError(m || t("study.errors.transcription")),
    silenceMs: mode === "free" ? 1200 : 2500,
    language: sttLang,
    singleSegment: mode === "quiz",
  });

  const askNext = async () => {
    const session = sessionRef.current;
    if (!session) return;
    setLastAnswer(null);
    setQuizState("asking");
    try {
      const q = await runEval(() => session.nextQuestion());
      if (!q) {
        setQuestion(null);
        setQuizState("done");
        return;
      }
      setQuestion(q);
      if (speakAloud) await speak(q, questionLang);
      setQuizState("listening");
      void listener.start();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setQuizState("feedback");
    }
  };

  const retryAnswer = () => {
    setLastAnswer(null);
    setQuizState("listening");
    void listener.start();
  };

  const startSession = () => {
    setError(null);
    if (!corpus.chunks.length) return setError(t("study.errors.noMaterials"));
    if (!isStudyLLMConfigured()) return setError(t("study.errors.noModel"));
    const session = new StudySession(createStudyLLM(), corpus, {
      mode,
      feedback,
      questionLanguage: questionLang,
      progress,
    });
    sessionRef.current = session;
    evalChain.current = Promise.resolve();
    nextId.current = 1;
    interruptionRef.current = null;
    setItems([]);
    setInterruption(null);
    setReport(null);
    setNarrative(null);
    setQuestion(null);
    setPhase("running");
    if (mode === "free") void listener.start();
    else void askNext();
  };

  const finishSession = async () => {
    const session = sessionRef.current;
    if (!session) return;
    stopSpeaking();
    listener.stop(mode === "free");
    await listener.drain();
    await evalChain.current;
    const r = session.finish();
    persist(session);
    appendHistory({
      at: Date.now(),
      mode: session.opts.mode,
      coveragePct: r.coveragePct,
      counts: r.counts,
    });
    setReport(r);
    setPhase("report");
    const lang = items.length ? guessLang(items.map((i) => i.text).join(" ")) : questionLang;
    narrate(createStudyLLM(), r, lang).then(setNarrative);
  };

  const continueAfterInterruption = () => {
    stopSpeaking();
    interruptionRef.current = null;
    setInterruption(null);
    void listener.start();
  };

  useEffect(() => () => stopSpeaking(), []);

  const verdictBadge = (v: Verdict) => (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${VERDICT_STYLE[v]}`}>
      {t(`study.verdict.${v}`)}
    </span>
  );

  const FindingBody = ({ f }: { f: Finding }) => (
    <div className="space-y-1 text-sm">
      {f.issue && (
        <p>
          <span className="font-medium">{t("study.finding.issue")}: </span>
          {f.issue}
        </p>
      )}
      {f.correction && (
        <p>
          <span className="font-medium">{t("study.finding.correction")}: </span>
          {f.correction}
        </p>
      )}
    </div>
  );

  // ── Render: report ─────────────────────────────────────────────────────────
  if (phase === "report" && report) {
    const history = loadHistory().slice(-6, -1);
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{t("study.report.title")}</h2>
          <Button onClick={() => setPhase("setup")}>{t("study.report.back")}</Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            [t("study.report.coverage"), `${report.coveragePct}%`],
            [t("study.verdict.correct"), report.counts.correct],
            [t("study.verdict.incomplete"), report.counts.incomplete],
            [t("study.verdict.wrong"), report.counts.wrong],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-2xl font-semibold tabular-nums">{value}</div>
            </div>
          ))}
        </div>

        <section className="rounded-lg border border-border p-4">
          <h3 className="mb-2 font-medium">{t("study.report.summary")}</h3>
          {narrative === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> {t("study.report.writing")}
            </div>
          ) : narrative ? (
            <MarkdownRenderer content={narrative} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("study.report.noSummary")}</p>
          )}
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <section className="rounded-lg border border-border p-4">
            <h3 className="mb-2 font-medium">{t("study.report.strengths")}</h3>
            {report.strengths.length ? (
              <ul className="space-y-1 text-sm">
                {report.strengths.map((s) => (
                  <li key={s.topicId} className="flex items-center gap-2">
                    <Check size={14} className="text-emerald-600" /> {s.title}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("study.report.none")}</p>
            )}
          </section>
          <section className="rounded-lg border border-border p-4">
            <h3 className="mb-2 font-medium">{t("study.report.toImprove")}</h3>
            {report.toImprove.length ? (
              <ul className="space-y-1 text-sm">
                {report.toImprove.slice(0, 10).map((s) => (
                  <li key={s.topicId} className="flex justify-between gap-2">
                    <span>{s.title}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {t("study.report.topicStat", { pct: s.coveredPct, errors: s.errors })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("study.report.none")}</p>
            )}
          </section>
        </div>

        <section className="space-y-3">
          <h3 className="font-medium">
            {t("study.report.mistakes", { count: report.mistakes.length })}
          </h3>
          {report.mistakes.map((m) => (
            <div key={m.id} className="space-y-2 rounded-lg border border-border p-3">
              {m.question && <p className="text-sm font-medium">{m.question}</p>}
              <div className="flex items-start gap-2">
                {verdictBadge(m.verdict)}
                <p className="text-sm italic text-muted-foreground">“{m.userSaid}”</p>
              </div>
              <FindingBody f={m} />
            </div>
          ))}
        </section>

        <section className="rounded-lg border border-border p-4">
          <h3 className="mb-2 font-medium">{t("study.report.topics")}</h3>
          <div className="space-y-1.5">
            {report.topics.map((tp) => (
              <div key={tp.topicId} className="flex items-center gap-3 text-sm">
                <span className="w-1/2 truncate">{tp.title}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${tp.coveredPct}%` }} />
                </div>
                <span className="w-10 text-right tabular-nums text-muted-foreground">
                  {tp.coveredPct}%
                </span>
              </div>
            ))}
          </div>
        </section>

        {history.length > 0 && (
          <section className="text-sm text-muted-foreground">
            {t("study.report.history")}:{" "}
            {history
              .map((h) => `${new Date(h.at).toLocaleDateString()} ${h.coveragePct}%`)
              .join(" · ")}
          </section>
        )}
      </div>
    );
  }

  // ── Render: running ────────────────────────────────────────────────────────
  if (phase === "running") {
    const levelPct = Math.min(100, Math.round(listener.level * 900));
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {mode === "free" ? t("study.mode.free") : t("study.mode.quiz")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {feedback === "immediate"
                ? t("study.feedback.immediate")
                : t("study.feedback.deferred")}
            </p>
          </div>
          <Button variant="outline" onClick={finishSession}>
            <Square size={14} /> {t("study.run.finish")}
          </Button>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-border p-3">
          <Mic
            size={18}
            className={listener.listening ? "text-red-500" : "text-muted-foreground"}
          />
          <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-red-500 transition-[width]"
              style={{ width: `${listener.listening ? levelPct : 0}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {listener.listening
              ? t("study.run.listening")
              : listener.pending || evaluating
                ? t("study.run.thinking")
                : t("study.run.paused")}
          </span>
        </div>

        {error && (
          <div className="flex items-start justify-between gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label={t("study.dismiss")}>
              <X size={14} />
            </button>
          </div>
        )}

        {interruption && (
          <div className="space-y-3 rounded-lg border-2 border-amber-500 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2 font-medium">
              {verdictBadge(interruption.verdict)} {t("study.run.stopped")}
            </div>
            <p className="text-sm italic text-muted-foreground">“{interruption.userSaid}”</p>
            <FindingBody f={interruption} />
            <Button onClick={continueAfterInterruption}>{t("study.run.continue")}</Button>
          </div>
        )}

        {mode === "quiz" && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            {quizState === "asking" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> {t("study.quiz.preparing")}
              </div>
            )}
            {quizState === "done" && <p className="text-sm">{t("study.quiz.allCovered")}</p>}
            {question && quizState !== "asking" && quizState !== "done" && (
              <>
                <p className="text-base font-medium">{question}</p>
                {quizState === "listening" && (
                  <div className="flex gap-2">
                    <Button onClick={() => listener.stop(true)}>
                      {t("study.quiz.doneAnswering")}
                    </Button>
                    <Button variant="outline" onClick={() => speak(question, questionLang)}>
                      {t("study.quiz.repeat")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        listener.stop(false);
                        void askNext();
                      }}
                    >
                      {t("study.quiz.skip")}
                    </Button>
                  </div>
                )}
                {quizState === "evaluating" && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" /> {t("study.quiz.evaluating")}
                  </div>
                )}
                {quizState === "feedback" && (
                  <div className="space-y-3">
                    {lastAnswer && (
                      <>
                        <div>{verdictBadge(lastAnswer.verdict)}</div>
                        <FindingBody f={lastAnswer} />
                      </>
                    )}
                    <div className="flex gap-2">
                      {lastAnswer?.verdict !== "correct" && (
                        <Button variant="outline" onClick={retryAnswer}>
                          {t("study.quiz.retry")}
                        </Button>
                      )}
                      <Button onClick={() => void askNext()}>{t("study.quiz.next")}</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="rounded-lg border border-border p-3 text-sm">
              {it.question && <p className="mb-1 text-xs text-muted-foreground">{it.question}</p>}
              <p>{it.text}</p>
              {/* Deferred feedback keeps verdicts hidden until the report. */}
              {feedback === "immediate" && it.finding && it.finding.verdict !== "offtopic" && (
                <div className="mt-2">{verdictBadge(it.finding.verdict)}</div>
              )}
            </div>
          ))}
          {mode === "free" && !items.length && (
            <p className="text-sm text-muted-foreground">{t("study.run.freeHint")}</p>
          )}
        </div>
      </div>
    );
  }

  // ── Render: setup ──────────────────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Brain size={20} /> {t("study.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("study.subtitle")}</p>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label={t("study.dismiss")}>
            <X size={14} />
          </button>
        </div>
      )}

      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">{t("study.materials.title")}</h3>
          <span className="text-xs text-muted-foreground">
            {t("study.materials.coverage", { pct: overallCoverage, topics: corpus.topics.length })}
          </span>
        </div>
        {docs.length > 0 && (
          <ul className="divide-y divide-border rounded border border-border">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <FileText size={14} className="text-muted-foreground" />
                <span className="flex-1 truncate">{d.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t("study.materials.topicCount", {
                    count: corpus.topics.filter((tp) => tp.id.startsWith(`${d.id}:`)).length,
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => updateDocs(docs.filter((x) => x.id !== d.id))}
                  aria-label={t("study.materials.remove")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="cursor-pointer">
            <input
              type="file"
              multiple
              accept={SUPPORTED_EXTENSIONS.join(",")}
              className="hidden"
              onChange={(e) => {
                void onFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <span className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm hover:bg-muted/50">
              {t("study.materials.upload")}
            </span>
          </label>
          <span className="text-xs text-muted-foreground">{t("study.materials.formats")}</span>
          {progress.covered.length > 0 && (
            <button
              type="button"
              className="ml-auto text-xs text-muted-foreground underline"
              onClick={() => {
                const empty = { covered: [], weak: {} };
                setProgress(empty);
                saveProgress(empty);
              }}
            >
              {t("study.materials.resetProgress")}
            </button>
          )}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t("study.materials.pasteToggle")}
          </summary>
          <div className="mt-2 space-y-2">
            <input
              dir="auto"
              value={pasteName}
              onChange={(e) => setPasteName(e.target.value)}
              placeholder={t("study.materials.pasteName")}
              className="h-8 w-full rounded-md border border-border bg-transparent px-2"
            />
            <textarea
              dir="auto"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={t("study.materials.pastePlaceholder")}
              rows={6}
              className="w-full rounded-md border border-border bg-transparent p-2"
            />
            <Button
              variant="outline"
              disabled={!pasteName.trim() || !pasteText.trim()}
              onClick={() => {
                addDoc(pasteName.trim(), pasteText);
                setPasteName("");
                setPasteText("");
              }}
            >
              {t("study.materials.pasteAdd")}
            </Button>
          </div>
        </details>
      </section>

      <section className="space-y-4 rounded-lg border border-border p-4">
        <div className="space-y-2">
          <h3 className="font-medium">{t("study.mode.label")}</h3>
          <Segmented<StudyMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: "free", label: t("study.mode.free"), hint: t("study.mode.freeHint") },
              { value: "quiz", label: t("study.mode.quiz"), hint: t("study.mode.quizHint") },
            ]}
          />
        </div>
        <div className="space-y-2">
          <h3 className="font-medium">{t("study.feedback.label")}</h3>
          <Segmented<FeedbackTiming>
            value={feedback}
            onChange={setFeedback}
            options={[
              {
                value: "immediate",
                label: t("study.feedback.immediate"),
                hint: t("study.feedback.immediateHint"),
              },
              {
                value: "deferred",
                label: t("study.feedback.deferred"),
                hint: t("study.feedback.deferredHint"),
              },
            ]}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("study.lang.spoken")}</h3>
            <Segmented<"auto" | "it" | "en">
              value={sttLang}
              onChange={setSttLang}
              options={[
                { value: "auto", label: t("study.lang.auto") },
                { value: "it", label: "Italiano" },
                { value: "en", label: "English" },
              ]}
            />
          </div>
          {mode === "quiz" && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t("study.lang.questions")}</h3>
              <Segmented<"it" | "en">
                value={questionLang}
                onChange={setQuestionLang}
                options={[
                  { value: "it", label: "Italiano" },
                  { value: "en", label: "English" },
                ]}
              />
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={speakAloud}
            onChange={(e) => setSpeakAloud(e.target.checked)}
          />
          {t("study.speakAloud")}
        </label>
        <p className="text-xs text-muted-foreground">
          {(() => {
            const llm = describeStudyLLM();
            return t("study.tutorModel", {
              provider: llm.provider || "—",
              model: llm.model || "—",
            });
          })()}
        </p>
        <Button onClick={startSession} disabled={!docs.length}>
          <Mic size={14} /> {t("study.start")}
        </Button>
      </section>
    </div>
  );
}
