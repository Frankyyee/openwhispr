const EN = /\b(the|and|is|are|of|with|which|that|this|what|why|how)\b/gi;
const IT = /\b(il|lo|la|gli|che|della|sono|è|perché|come|quale|con|non)\b/gi;

export function guessLang(text: string): "it" | "en" {
  return (text.match(EN)?.length ?? 0) > (text.match(IT)?.length ?? 0) ? "en" : "it";
}

/** Reads text aloud with the system voice. Resolves when done (or at once if unsupported). */
export function speak(text: string, lang: "it" | "en" = guessLang(text)): Promise<void> {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || !text.trim()) return Promise.resolve();
  synth.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "en" ? "en-US" : "it-IT";
    const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
    if (voice) u.voice = voice;
    u.onend = u.onerror = () => resolve();
    synth.speak(u);
  });
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
}
