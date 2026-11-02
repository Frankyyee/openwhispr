# Studio (Study mode)

Ripasso orale sui propri appunti. Voce in italiano o inglese.

## Come si usa

1. **Studio** nella barra laterale → **Aggiungi file** (TXT, Markdown, DOCX) oppure incolla testo.
   I titoli (`#` in Markdown, stili *Titolo/Heading* in Word) diventano gli argomenti del programma.
2. Scegli la modalità:
   - **Ripetizione libera**: parli a ruota libera. A ogni pausa (~1,2 s) il passaggio viene trascritto e controllato sui materiali.
   - **Interrogazione guidata**: ti fa domande, partendo dagli argomenti non ancora coperti e da quelli in cui hai sbagliato.
3. Scegli le correzioni:
   - **Fermami quando sbaglio**: si interrompe e ti dice cosa non va e la versione corretta, anche a voce.
     In ripetizione libera ti ferma solo per errori o omissioni gravi, perché potresti ancora arrivarci.
   - **Dimmelo alla fine**: nessuna interruzione, tutto finisce nel report.
4. **Termina e mostra report** mostra:
   - la copertura del programma, totale e per argomento;
   - i conteggi corretto/incompleto/sbagliato;
   - punti di forza e cose da migliorare;
   - l'elenco degli errori con la correzione;
   - un commento del tutor.

La copertura e gli argomenti deboli vengono salvati tra una sessione e l'altra, sia in ripetizione libera sia nell'interrogazione. Così l'interrogazione non ti richiede quello che hai già ripetuto bene.

## Configurazione

- **Riconoscimento vocale**: usa quello configurato in Impostazioni → Speech-to-Text: Whisper o Parakeet in locale, OpenWhispr Cloud o BYOK.
  Per parlare sia in italiano sia in inglese scegli un modello multilingue (es. Whisper `turbo`/`large`, Parakeet v3) e lascia la lingua su *Automatico*, oppure fissala per la sessione.
- **LLM** (giudica le risposte, fa le domande, scrive il report): usa il modello di *Formattazione note* in Impostazioni → Modelli AI.
  Va bene qualsiasi provider supportato: Claude, OpenAI, Gemini, Groq, modelli locali GGUF o self-hosted.
  Con i modelli locali piccoli i giudizi sono meno affidabili.

## Architettura

Tutto in `src/study/`. Il motore è puro, senza Electron, e testato in `test/study/`.

| File | Ruolo |
| --- | --- |
| `chunker.ts` | divide i documenti in blocchi e argomenti |
| `retriever.ts` | BM25 offline IT/EN per trovare i blocchi pertinenti a ciò che dici |
| `prompts.ts`, `evaluator.ts` | giudizio JSON (`correct` / `incomplete` / `wrong` / `offtopic`, `major`), generazione domande |
| `session.ts` | stato della sessione: copertura, argomenti deboli, scelta dell'argomento successivo, quando interrompere |
| `report.ts` | report deterministico + commento LLM |
| `llm.ts` | adattatore verso `ReasoningService` (scope *noteFormatting*) |
| `useStudyListener.ts` | microfono continuo tagliato sulle pause → `transcribeFile` |
| `importFiles.ts` | lettura TXT/MD/DOCX (DOCX con `DecompressionStream`, nessuna dipendenza) |
| `storage.ts` | materiali, progressi e storico in `localStorage` |
| `speech.ts` | lettura ad alta voce con la sintesi vocale di sistema |

UI: `src/components/StudyView.tsx`, voce `study` in `controlPanelNav.ts`.

## Limiti attuali / prossimi passi

- **PDF** non ancora supportati: va aggiunto `pdfjs-dist`. Per ora esporta i PDF in testo o DOCX.
- I materiali stanno in `localStorage`, che regge qualche MB. Per programmi molto grandi conviene spostarli in SQLite e usare l'indice semantico già presente (Qdrant + MiniLM) al posto di BM25.
- La sintesi vocale su Linux richiede `speech-dispatcher`.
