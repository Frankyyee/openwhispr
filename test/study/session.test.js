const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCorpus } = require("../../src/study/chunker.ts");
const { Retriever } = require("../../src/study/retriever.ts");
const { StudySession } = require("../../src/study/session.ts");
const { parseJson } = require("../../src/study/evaluator.ts");

const docs = [
  {
    id: "bio",
    name: "Biologia",
    text: "# Mitocondri\nI mitocondri producono ATP tramite la respirazione cellulare.\n\nHanno un proprio DNA circolare.\n\n# Ribosomi\nI ribosomi sintetizzano le proteine traducendo l'mRNA.",
  },
  {
    id: "hist",
    name: "History",
    text: "The French Revolution began in 1789 with the storming of the Bastille.",
  },
];

test("chunker builds topics from headings and from headless docs", () => {
  const c = buildCorpus(docs);
  assert.deepEqual(
    c.topics.map((t) => t.title),
    ["Mitocondri", "Ribosomi", "History (1)"]
  );
  assert.equal(c.chunks.length, 4);
  assert.ok(
    c.chunks.every((ch) => c.topics.find((t) => t.id === ch.topicId).chunkIds.includes(ch.id))
  );
});

test("retriever finds the right chunk in Italian and English", () => {
  const c = buildCorpus(docs);
  const r = new Retriever(c.chunks);
  assert.match(r.search("i mitocondri fanno l'ATP", 1)[0].text, /ATP/);
  assert.match(r.search("when did the revolution start, the bastille", 1)[0].text, /1789/);
});

test("parseJson tolerates prose and code fences around JSON", () => {
  assert.deepEqual(parseJson('Sure:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJson("no json"), null);
});

function fakeLLM(script) {
  const calls = [];
  const llm = async (system, user) => {
    calls.push({ system, user });
    return typeof script === "function" ? script(system, user) : script.shift();
  };
  llm.calls = calls;
  return llm;
}

test("free recall, immediate: wrong statement interrupts and is recorded", async () => {
  const corpus = buildCorpus(docs);
  const atp = corpus.chunks.find((c) => /ATP/.test(c.text)).id;
  const llm = fakeLLM([
    JSON.stringify({
      verdict: "wrong",
      issue: "Non producono glucosio",
      correction: "Producono ATP",
      covered_chunk_ids: [],
      missed_chunk_ids: [atp, "invented-id"],
    }),
  ]);
  const s = new StudySession(llm, corpus, { mode: "free", feedback: "immediate" });
  const turn = await s.submitFreeRecall("i mitocondri producono glucosio per la cellula");
  assert.equal(turn.interrupt, true);
  assert.deepEqual(turn.finding.missedChunkIds, [atp], "unknown chunk ids are dropped");
  assert.equal(s.finish().mistakes.length, 1);
});

test("free recall, deferred: never interrupts but report lists mistakes", async () => {
  const corpus = buildCorpus(docs);
  const llm = fakeLLM(() =>
    JSON.stringify({
      verdict: "incomplete",
      issue: "manca il DNA",
      correction: "",
      covered_chunk_ids: [],
      missed_chunk_ids: [],
    })
  );
  const s = new StudySession(llm, corpus, { mode: "free", feedback: "deferred" });
  const turn = await s.submitFreeRecall("i mitocondri producono ATP nella cellula");
  assert.equal(turn.interrupt, false);
  assert.equal(s.pendingFindings.length, 1);
});

test("free recall interrupts on minor gaps only when they are major; context is passed on", async () => {
  const corpus = buildCorpus(docs);
  const replies = [
    JSON.stringify({
      verdict: "incomplete",
      issue: "minor",
      correction: "",
      covered_chunk_ids: [],
      missed_chunk_ids: [],
      major: false,
    }),
    JSON.stringify({
      verdict: "incomplete",
      issue: "big",
      correction: "",
      covered_chunk_ids: [],
      missed_chunk_ids: [],
      major: true,
    }),
  ];
  const llm = fakeLLM(replies);
  const s = new StudySession(llm, corpus, { mode: "free", feedback: "immediate" });
  assert.equal(
    (await s.submitFreeRecall("i mitocondri sono organelli della cellula")).interrupt,
    false
  );
  assert.equal((await s.submitFreeRecall("producono ATP con la respirazione")).interrupt, true);
  assert.match(llm.calls[1].user, /CONTESTO PRECEDENTE[\s\S]*organelli/);
});

test("progress round-trips and ignores chunks no longer in the materials", async () => {
  const corpus = buildCorpus(docs);
  const s = new StudySession(fakeLLM([]), corpus, {
    mode: "quiz",
    feedback: "deferred",
    progress: { covered: [corpus.chunks[0].id, "gone:c0"], weak: { x: 2 } },
  });
  assert.deepEqual(s.progress(), { covered: [corpus.chunks[0].id], weak: { x: 2 } });
});

test("garbage LLM output is never shown as a mistake", async () => {
  const corpus = buildCorpus(docs);
  const s = new StudySession(fakeLLM(["oops"]), corpus, { mode: "free", feedback: "immediate" });
  const turn = await s.submitFreeRecall("i mitocondri producono ATP nella cellula");
  assert.equal(turn.finding.verdict, "offtopic");
  assert.equal(turn.interrupt, false);
});

test("quiz skips topics already covered (also from free recall) and prioritises weak ones", async () => {
  const corpus = buildCorpus(docs);
  const mito = corpus.topics[0];
  const ribo = corpus.topics[1];
  const riboChunk = ribo.chunkIds[0];
  const llm = fakeLLM((system, user) => {
    if (system.includes('{"question"'))
      return JSON.stringify({ question: "Q about " + user.match(/TOPIC: (.+)/)[1] });
    if (user.includes("glucosio"))
      return JSON.stringify({
        verdict: "wrong",
        issue: "x",
        correction: "y",
        covered_chunk_ids: [],
        missed_chunk_ids: [riboChunk],
      });
    return JSON.stringify({
      verdict: "correct",
      issue: "",
      correction: "",
      covered_chunk_ids: user.match(/\[([^\]]+)\]/g).map((m) => m.slice(1, -1)),
      missed_chunk_ids: [],
    });
  });
  const s = new StudySession(llm, corpus, {
    mode: "quiz",
    feedback: "deferred",
    progress: { covered: mito.chunkIds, weak: {} },
  });

  const q1 = await s.nextQuestion();
  assert.match(q1, /Ribosomi/, "Mitocondri was already covered");
  await s.answer("i ribosomi producono glucosio"); // wrong -> Ribosomi becomes weak
  assert.match(await s.nextQuestion(), /Ribosomi/, "weak topic is asked again");
  await s.answer("i ribosomi sintetizzano proteine leggendo l'mRNA");
  assert.match(await s.nextQuestion(), /History/);
  await s.answer("It began in 1789 with the Bastille");
  assert.equal(await s.nextQuestion(), null, "whole syllabus covered");

  const r = s.finish();
  assert.equal(r.coveragePct, 100);
  assert.equal(r.counts.wrong, 1);
  assert.equal(r.toImprove[0].title, "Ribosomi");
});
