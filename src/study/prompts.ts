import type { Chunk } from "./types";

const LANG_RULE =
  "Rispondi nella stessa lingua usata dallo studente (italiano o inglese; se mescola, usa la lingua prevalente). " +
  "Reply in the same language the student used (Italian or English; if mixed, the dominant one). " +
  "Non tradurre i termini tecnici del materiale.";

export function formatChunks(chunks: Chunk[]): string {
  return chunks.map((c) => `[${c.id}] (${c.docName} > ${c.heading})\n${c.text}`).join("\n\n");
}

export const EVAL_SYSTEM = `Sei un tutor severo ma giusto che verifica ciò che lo studente dice a voce, usando SOLO il materiale fornito come verità.
You are a strict but fair tutor checking what a student says aloud, using ONLY the provided material as ground truth.

Regole / Rules:
- La trascrizione vocale può avere errori di riconoscimento: ignora differenze di ortografia o pronuncia, non punire parole mal trascritte.
- "correct": tutto ciò che è stato detto è coerente col materiale.
- "incomplete": è corretto ma omette punti essenziali presenti nel materiale per quella domanda/argomento.
- "wrong": contiene almeno un'affermazione in contraddizione col materiale.
- "offtopic": non riguarda il materiale (o non è verificabile). Non è un errore.
- "major": true se l'errore o l'omissione è abbastanza grave che un docente interromperebbe lo studente subito (sempre true per "wrong"); false per dettagli minori.
- In RIPETIZIONE LIBERA lo studente sta ancora parlando: usa "incomplete" solo se ciò che ha detto è fuorviante così com'è, non perché non ha ancora toccato altri punti.
- Non inventare errori. Se il materiale non copre l'affermazione, usa "offtopic".
- ${LANG_RULE}

Rispondi SOLO con JSON valido / Reply with valid JSON only:
{"verdict":"correct|incomplete|wrong|offtopic","issue":"cosa è sbagliato o manca (vuoto se correct)","correction":"la versione corretta/completa, breve","covered_chunk_ids":["..."],"missed_chunk_ids":["..."],"major":false}`;

export function evalUser(opts: {
  utterance: string;
  question?: string;
  context?: string;
  chunks: Chunk[];
}): string {
  return [
    opts.question
      ? `DOMANDA / QUESTION:\n${opts.question}\n`
      : "MODALITÀ: RIPETIZIONE LIBERA / FREE RECALL\n",
    opts.context
      ? `CONTESTO PRECEDENTE (già valutato, non rivalutarlo) / PREVIOUS CONTEXT:\n${opts.context}\n`
      : "",
    `STUDENTE / STUDENT:\n${opts.utterance}\n`,
    `MATERIALE / MATERIAL:\n${formatChunks(opts.chunks)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const QUESTION_SYSTEM = `Sei un tutor che interroga uno studente a voce per ripassare un programma d'esame.
You are a tutor orally examining a student to review an exam syllabus.
Genera UNA domanda chiara, rispondibile a voce in 20-60 secondi, basata solo sul materiale dato. Varia il tipo (definizione, confronto, perché, esempio, procedura). Non rivelare la risposta.
${LANG_RULE}
Rispondi SOLO con JSON: {"question":"..."}`;

export function questionUser(opts: {
  topicTitle: string;
  chunks: Chunk[];
  language: string;
  avoid: string[];
}): string {
  return [
    `LINGUA DOMANDA / QUESTION LANGUAGE: ${opts.language}`,
    `ARGOMENTO / TOPIC: ${opts.topicTitle}`,
    opts.avoid.length
      ? `DOMANDE GIÀ FATTE (non ripetere) / ALREADY ASKED:\n- ${opts.avoid.join("\n- ")}`
      : "",
    `MATERIALE / MATERIAL:\n${formatChunks(opts.chunks)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const REPORT_SYSTEM = `Sei un tutor che scrive il report finale di una sessione di ripasso orale.
You write the final report of an oral revision session.
Dati: statistiche, copertura per argomento ed elenco delle imprecisioni. Scrivi in modo diretto e concreto:
1) Punti di forza  2) Cose da migliorare (con priorità)  3) Cosa ripassare prossimamente.
Non inventare dati oltre quelli forniti. ${LANG_RULE}
Rispondi in Markdown, massimo ~250 parole.`;
