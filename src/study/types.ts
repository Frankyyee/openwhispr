export interface Chunk {
  id: string;
  docId: string;
  docName: string;
  heading: string;
  topicId: string;
  text: string;
}

export interface Topic {
  id: string;
  title: string;
  chunkIds: string[];
}

export interface StudyCorpus {
  chunks: Chunk[];
  topics: Topic[];
}

export type StudyMode = "free" | "quiz";
export type FeedbackTiming = "immediate" | "deferred";
export type Verdict = "correct" | "incomplete" | "wrong" | "offtopic";

export interface Evaluation {
  verdict: Verdict;
  issue: string;
  correction: string;
  /** Chunk ids whose content the user stated correctly. */
  coveredChunkIds: string[];
  /** Chunk ids the user got wrong or left out. */
  missedChunkIds: string[];
  /** A teacher would stop the student here (always true for "wrong"). */
  major: boolean;
}

export interface Finding extends Evaluation {
  id: number;
  mode: StudyMode;
  question?: string;
  userSaid: string;
  topicIds: string[];
  at: number;
}

/** Sends a system + user prompt to any configured LLM and returns its text. */
export type LLM = (system: string, user: string) => Promise<string>;

/** What carries over between sessions so later ones pick up where you left off. */
export interface StudyProgress {
  covered: string[];
  weak: Record<string, number>;
}
