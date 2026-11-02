import type { SourceDoc } from "./chunker";
import type { StudyReport } from "./report";
import type { StudyProgress } from "./types";

const DOCS = "studyDocs";
const PROGRESS = "studyProgress";
const HISTORY = "studyHistory";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota exceeded: the caller tells the user
  }
}

export const loadDocs = () => read<SourceDoc[]>(DOCS, []);
export const saveDocs = (docs: SourceDoc[]) => write(DOCS, docs);
export const loadProgress = () => read<StudyProgress>(PROGRESS, { covered: [], weak: {} });
export const saveProgress = (p: StudyProgress) => write(PROGRESS, p);

export interface HistoryEntry {
  at: number;
  mode: string;
  coveragePct: number;
  counts: StudyReport["counts"];
}
export const loadHistory = () => read<HistoryEntry[]>(HISTORY, []);
export const appendHistory = (e: HistoryEntry) => write(HISTORY, [...loadHistory(), e].slice(-100));

/** Doc id = its name, so re-importing updated notes keeps progress on unchanged parts. */
export function docIdFor(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "doc"
  );
}
