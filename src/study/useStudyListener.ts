import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useSettings } from "../hooks/useSettings";
import { useSettingsStore } from "../stores/settingsStore";
import { getBaseLanguageCode } from "../utils/languageSupport";
import {
  transcribeFile,
  getTranscriptionApiKey,
  type FileTranscriptionConfig,
} from "../services/fileTranscription";
import { analyserRms } from "../utils/audioLevel";

const VOICE_RMS = 0.015;
const TICK_MS = 100;
const MIN_SEGMENT_MS = 1500;
const MAX_SEGMENT_MS = 45_000;
const IDLE_RESET_MS = 30_000;

interface Options {
  /** Called in order with each transcribed passage. */
  onSegment: (text: string) => void;
  onError: (message: string) => void;
  /** Pause length that closes a passage (free recall ~1.2 s, quiz answer ~2.5 s). */
  silenceMs: number;
  /** "auto", "it" or "en". "auto" follows the app's dictation language setting. */
  language: string;
  /** Quiz: stop listening after the first passage instead of continuing. */
  singleSegment?: boolean;
}

/**
 * Continuous listening that cuts the mic stream into passages at natural pauses
 * and sends each through OpenWhispr's normal transcription pipeline (local
 * Whisper/Parakeet, OpenWhispr Cloud or BYOK).
 */
export function useStudyListener(opts: Options) {
  const { isSignedIn } = useAuth();
  const settings = useSettings();
  const cortiEnvironment = useSettingsStore((s) => s.cortiEnvironment);
  const cortiTenant = useSettingsStore((s) => s.cortiTenant);

  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState(0);
  const [level, setLevel] = useState(0);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const buildConfig = (): FileTranscriptionConfig => {
    const lang = optsRef.current.language;
    return {
      useLocalWhisper: settings.useLocalWhisper,
      localTranscriptionProvider: settings.localTranscriptionProvider as string,
      whisperModel: settings.whisperModel,
      parakeetModel: settings.parakeetModel,
      cohereModel: settings.cohereModel,
      isOpenWhisprCloud:
        isSignedIn && settings.cloudTranscriptionMode === "openwhispr" && !settings.useLocalWhisper,
      getApiKey: () =>
        getTranscriptionApiKey(settings.cloudTranscriptionProvider as string, settings),
      cloudTranscriptionProvider: settings.cloudTranscriptionProvider as string,
      cloudTranscriptionBaseUrl: settings.cloudTranscriptionBaseUrl || "",
      cloudTranscriptionModel: settings.cloudTranscriptionModel,
      language: lang === "auto" ? getBaseLanguageCode(settings.preferredLanguage) || "" : lang,
      cortiEnvironment,
      cortiTenant,
      transcriptionMode: settings.transcriptionMode,
      remoteTranscriptionUrl: settings.remoteTranscriptionUrl,
      remoteTranscriptionModel: settings.remoteTranscriptionModel,
    };
  };
  const buildConfigRef = useRef(buildConfig);
  buildConfigRef.current = buildConfig;

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);
  const seg = useRef({ start: 0, lastVoice: 0, voiced: false, discard: false });
  const queue = useRef<Promise<void>>(Promise.resolve());

  const transcribe = useCallback((blob: Blob) => {
    setPending((n) => n + 1);
    // Chained so passages reach the caller in the order they were spoken.
    queue.current = queue.current.then(async () => {
      let tempPath: string | null = null;
      try {
        const saved = await window.electronAPI.saveTempAudio(await blob.arrayBuffer());
        tempPath = saved.path;
        const result = await transcribeFile(tempPath, buildConfigRef.current(), false, {
          purpose: "dictation",
        });
        const text = result.text?.trim();
        if (result.success && text) optsRef.current.onSegment(text);
        else if (!result.success) optsRef.current.onError(result.error || "");
      } catch (e) {
        optsRef.current.onError(e instanceof Error ? e.message : String(e));
      } finally {
        if (tempPath) void window.electronAPI.deleteTempAudio(tempPath);
        setPending((n) => n - 1);
      }
    });
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    analyserRef.current = null;
    setLevel(0);
    setListening(false);
  }, []);

  const startSegment = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const state = { start: Date.now(), lastVoice: 0, voiced: false, discard: false };
    seg.current = state;
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = () => {
      if (state.voiced && !state.discard) transcribe(new Blob(chunks, { type: "audio/webm" }));
      if (activeRef.current) startSegment();
      else teardown();
    };
    recorder.start(500);
    recorderRef.current = recorder;
  }, [teardown, transcribe]);

  const cut = useCallback((discard: boolean) => {
    seg.current.discard = discard;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(analyser);
      analyser.connect(sink);
      sink.connect(ctx.destination);
      streamRef.current = stream;
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      activeRef.current = true;
      setListening(true);
      startSegment();

      timerRef.current = setInterval(() => {
        const a = analyserRef.current;
        if (!a) return;
        const rms = analyserRms(a, bufRef);
        setLevel(rms);
        const now = Date.now();
        const s = seg.current;
        if (rms > VOICE_RMS) {
          s.voiced = true;
          s.lastVoice = now;
        }
        const age = now - s.start;
        if (s.voiced && age > MIN_SEGMENT_MS && now - s.lastVoice > optsRef.current.silenceMs) {
          if (optsRef.current.singleSegment) activeRef.current = false;
          cut(false);
        } else if (s.voiced && age > MAX_SEGMENT_MS) {
          cut(false);
        } else if (!s.voiced && age > IDLE_RESET_MS) {
          cut(true); // keep silent recordings from piling up
        }
      }, TICK_MS);
    } catch (e) {
      teardown();
      optsRef.current.onError(e instanceof Error ? e.message : String(e));
    }
  }, [cut, startSegment, teardown]);

  /** Stops listening. `flush` transcribes what was said since the last pause. */
  const stop = useCallback(
    (flush = true) => {
      if (!activeRef.current && !recorderRef.current) return;
      activeRef.current = false;
      if (recorderRef.current?.state === "recording") cut(!flush);
      else teardown();
    },
    [cut, teardown]
  );

  useEffect(
    () => () => {
      activeRef.current = false;
      seg.current.discard = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      teardown();
    },
    [teardown]
  );

  /** Resolves once every passage already captured has been transcribed and delivered. */
  const drain = useCallback(() => queue.current, []);

  return { listening, pending, level, start, stop, drain };
}
