"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { LANGUAGES, type LanguageConfig } from "@/lib/languages";

type TranslateResponse = {
  translatedText?: string;
  targetLang?: string;
  error?: string;
};

async function translateText(
  fromLang: string,
  toLang: string,
  text: string
): Promise<{ translatedText: string; targetLang: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { translatedText: "", targetLang: toLang };
  if (fromLang === toLang) return { translatedText: trimmed, targetLang: toLang };

  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, fromLang, toLang }),
    });

    if (!res.ok) {
      console.error("[Learn] translate API not ok", res.status);
      return { translatedText: trimmed, targetLang: toLang };
    }

    const data: TranslateResponse = await res.json();
    if (!data || !data.translatedText) {
      console.warn("[Learn] translate API missing translatedText", data);
      return { translatedText: trimmed, targetLang: toLang };
    }

    return { translatedText: data.translatedText, targetLang: data.targetLang || toLang };
  } catch (err) {
    console.error("[Learn] translate API failed", err);
    return { translatedText: trimmed, targetLang: toLang };
  }
}

function speakText(text: string, lang: string, rate = 1.0) {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) {
    console.warn("[Learn] speechSynthesis not available");
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) return;

  const doSpeak = () => {
    try {
      synth.cancel();
    } catch {}

    const utterance = new SpeechSynthesisUtterance(trimmed);
    const voices = synth.getVoices();

    if (voices && voices.length > 0) {
      const voice =
        voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
        voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
      if (voice) utterance.voice = voice;
    }

    utterance.lang = lang || "en-US";
    utterance.rate = rate;
    synth.speak(utterance);
  };

  const currentVoices = synth.getVoices();

  // Speak immediately (default voice), then retry once when voices load (some Android browsers never fire before first speak).
  doSpeak();

  if (!currentVoices || currentVoices.length === 0) {
    synth.onvoiceschanged = () => {
      synth.onvoiceschanged = null;
      doSpeak();
    };
  }
}

function scoreSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,!?;:]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const aa = normalize(a);
  const bb = normalize(b);
  if (!aa || !bb) return 0;

  const aWords = aa.split(" ");
  const bWords = bb.split(" ");

  let matches = 0;
  const maxLen = Math.max(aWords.length, bWords.length);
  for (let i = 0; i < maxLen; i++) {
    if (aWords[i] && bWords[i] && aWords[i] === bWords[i]) matches++;
  }

  return Math.round((matches / maxLen) * 100);
}

function normalizeWords(s: string) {
  return s
    .toLowerCase()
    .replace(/[.,!?;:]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function pickSupportedLang(code: string, fallback: string) {
  const has = LANGUAGES.some((l) => l.code === code);
  if (has) return code;

  // Try base language match: pt-BR -> pt-PT style or vice versa
  const base = code.slice(0, 2).toLowerCase();
  const baseMatch = LANGUAGES.find((l) => l.code.slice(0, 2).toLowerCase() === base);
  if (baseMatch) return baseMatch.code;

  return fallback;
}

function getDeviceLang() {
  if (typeof navigator === "undefined") return "en-US";
  const raw = navigator.language || "en-US";
  // Normalize common Portuguese variants to pt-BR if available
  if (raw.toLowerCase().startsWith("pt")) return "pt-BR";
  return raw;
}

type UiLang = "en" | "pt";

function getUiLang(deviceLang: string): UiLang {
  return deviceLang.toLowerCase().startsWith("pt") ? "pt" : "en";
}

const UI_BASE = {
  en: {

    title: "Any-Speak Learn",
    subtitle: "Say or type something. It translates automatically. Then practice saying it.",
    from: "From language",
    to: "To language",
    typeMode: "Type mode",
    listening: "Listening…",
    recordSentence: "Record sentence",
    stopRecording: "Stop",
    micBlocked:
      "Mic access was blocked by the browser. Check microphone permission if you want to use speech input.",
    sttNotSupported:
      "Speech features are not supported on this browser. You can still type, translate, and listen.",
    inputPlaceholder: "Type what you want to say…",
    translating: "Translating…",
    translation: "Translation",
    translationPlaceholder: "Start typing or record a sentence to see it here.",
    playTranslation: "Play translation",
    speed: "Speed",
    practiceTitle: "Practice",
    recordAttempt: "Record my attempt",
    stopAttempt: "Stop attempt",
    playAttempt: "Play my attempt",
    noAudioSupport: "Audio recording is not supported on this browser.",
    recognized: "What you said (recognized)",
    recognizedPlaceholder: "After recording, your attempt will appear here.",
    showFeedback: "Show feedback",
    hideFeedback: "Hide feedback",
    accuracy: "Accuracy (rough estimate)",
    scorePlaceholder: "You'll see a score after an attempt.",
    scoreLine: (n: number) => `${n}% match to the ideal sentence.`,
  },
  pt: {

    title: "Any-Speak Learn",
    subtitle: "Fale ou digite. Tradução automática. Depois pratique falando.",
    from: "Do idioma",
    to: "Para o idioma",
    typeMode: "Modo digitar",
    listening: "Ouvindo…",
    recordSentence: "Gravar frase",
    stopRecording: "Parar",
    micBlocked:
      "O microfone foi bloqueado pelo navegador. Verifique a permissão do microfone para usar a fala.",
    sttNotSupported:
      "Recursos de fala não são suportados neste navegador. Você ainda pode digitar, traduzir e ouvir.",
    inputPlaceholder: "Digite o que você quer dizer…",
    translating: "Traduzindo…",
    translation: "Tradução",
    translationPlaceholder: "Digite ou grave uma frase para ver a tradução aqui.",
    playTranslation: "Ouvir tradução",
    speed: "Velocidade",
    practiceTitle: "Prática",
    recordAttempt: "Gravar minha tentativa",
    stopAttempt: "Parar tentativa",
    playAttempt: "Ouvir minha tentativa",
    noAudioSupport: "Gravação de áudio não é suportada neste navegador.",
    recognized: "O que você falou (reconhecido)",
    recognizedPlaceholder: "Depois de gravar, sua tentativa aparece aqui.",
    showFeedback: "Mostrar feedback",
    hideFeedback: "Ocultar feedback",
    accuracy: "Precisão (estimativa)",
    scorePlaceholder: "Você verá uma pontuação após uma tentativa.",
    scoreLine: (n: number) => `${n}% de correspondência com a frase ideal.`,
  },
  es: {
    title: "Any-Speak Learn",
    subtitle: "Di o escribe algo. Se traduce automáticamente. Luego practica diciéndolo.",
    from: "Idioma de origen",
    to: "Idioma de destino",
    typeMode: "Modo de escritura",
    listening: "Escuchando…",
    recordSentence: "Grabar frase",
    stopRecording: "Detener",
    micBlocked: "El navegador bloqueó el acceso al micrófono. Revisa el permiso del micrófono si quieres usar la voz.",
    sttNotSupported: "Las funciones de voz no están disponibles en este navegador. Aun así puedes escribir, traducir y escuchar.",
    inputPlaceholder: "Escribe lo que quieres decir…",
    translating: "Traduciendo…",
    translation: "Traducción",
    translationPlaceholder: "Empieza a escribir o graba una frase para verla aquí.",
    playTranslation: "Reproducir traducción",
    speed: "Velocidad",
    practiceTitle: "Práctica",
    recordAttempt: "Grabar mi intento",
    stopAttempt: "Detener intento",
    playAttempt: "Reproducir mi intento",
    noAudioSupport: "La grabación de audio no es compatible con este navegador.",
    recognized: "Lo que dijiste (reconocido)",
    recognizedPlaceholder: "Después de grabar, tu intento aparecerá aquí.",
    showFeedback: "Mostrar comentarios",
    hideFeedback: "Ocultar comentarios",
    accuracy: "Precisión (estimación aproximada)",
    scorePlaceholder: "Verás una puntuación después de un intento.",
    scoreLine: (n: number) => `${n}% de coincidencia con la frase ideal.`,
  },
  zh: {
    title: "Any-Speak 练习",
    subtitle: "说或输入一句话。系统会自动翻译。然后练习把它说出来。",
    from: "源语言",
    to: "目标语言",
    typeMode: "输入模式",
    listening: "正在聆听…",
    recordSentence: "录制句子",
    stopRecording: "停止",
    micBlocked: "浏览器已阻止麦克风访问。如需语音输入，请检查麦克风权限。",
    sttNotSupported: "此浏览器不支持语音功能。你仍可以输入、翻译并收听。",
    inputPlaceholder: "输入你想说的话…",
    translating: "正在翻译…",
    translation: "翻译",
    translationPlaceholder: "开始输入或录制句子以在此查看。",
    playTranslation: "播放翻译",
    speed: "语速",
    practiceTitle: "练习",
    recordAttempt: "录制我的尝试",
    stopAttempt: "停止尝试",
    playAttempt: "播放我的尝试",
    noAudioSupport: "此浏览器不支持录音。",
    recognized: "你说的内容（识别）",
    recognizedPlaceholder: "录制后，你的尝试会显示在这里。",
    showFeedback: "显示反馈",
    hideFeedback: "隐藏反馈",
    accuracy: "准确度（粗略估计）",
    scorePlaceholder: "完成一次尝试后会显示评分。",
    scoreLine: (n: number) => `与理想句子匹配 ${n}%。`,
  },
  ar: {
    title: "Any-Speak للتعلّم",
    subtitle: "قل أو اكتب شيئًا. تتم الترجمة تلقائيًا. ثم تدرّب على نطقه.",
    from: "لغة المصدر",
    to: "لغة الهدف",
    typeMode: "وضع الكتابة",
    listening: "جارٍ الاستماع…",
    recordSentence: "سجّل الجملة",
    stopRecording: "إيقاف",
    micBlocked: "تم حظر الوصول إلى الميكروفون بواسطة المتصفح. تحقّق من إذن الميكروفون لاستخدام الإدخال الصوتي.",
    sttNotSupported: "ميزات الصوت غير مدعومة في هذا المتصفح. يمكنك ما زلت الكتابة والترجمة والاستماع.",
    inputPlaceholder: "اكتب ما تريد قوله…",
    translating: "جارٍ الترجمة…",
    translation: "الترجمة",
    translationPlaceholder: "ابدأ بالكتابة أو سجّل جملة لعرضها هنا.",
    playTranslation: "تشغيل الترجمة",
    speed: "السرعة",
    practiceTitle: "تدريب",
    recordAttempt: "سجّل محاولتي",
    stopAttempt: "إيقاف المحاولة",
    playAttempt: "تشغيل محاولتي",
    noAudioSupport: "تسجيل الصوت غير مدعوم في هذا المتصفح.",
    recognized: "ما قلته (تم التعرّف عليه)",
    recognizedPlaceholder: "بعد التسجيل ستظهر محاولتك هنا.",
    showFeedback: "إظهار الملاحظات",
    hideFeedback: "إخفاء الملاحظات",
    accuracy: "الدقّة (تقدير تقريبي)",
    scorePlaceholder: "سترى نتيجة بعد محاولة.",
    scoreLine: (n: number) => `نسبة التطابق مع الجملة المثالية: ${n}%.`,
  },
  fr: {
    title: "Any-Speak Apprentissage",
    subtitle: "Dites ou tapez quelque chose. Traduction automatique. Puis entraînez-vous à le dire.",
    from: "Langue source",
    to: "Langue cible",
    typeMode: "Mode saisie",
    listening: "Écoute…",
    recordSentence: "Enregistrer la phrase",
    stopRecording: "Arrêter",
    micBlocked: "L’accès au micro a été bloqué par le navigateur. Vérifiez l’autorisation du micro pour utiliser la voix.",
    sttNotSupported: "Les fonctions vocales ne sont pas prises en charge sur ce navigateur. Vous pouvez toujours saisir, traduire et écouter.",
    inputPlaceholder: "Tapez ce que vous voulez dire…",
    translating: "Traduction…",
    translation: "Traduction",
    translationPlaceholder: "Commencez à taper ou enregistrez une phrase pour l’afficher ici.",
    playTranslation: "Lire la traduction",
    speed: "Vitesse",
    practiceTitle: "Entraînement",
    recordAttempt: "Enregistrer mon essai",
    stopAttempt: "Arrêter l’essai",
    playAttempt: "Lire mon essai",
    noAudioSupport: "L’enregistrement audio n’est pas pris en charge sur ce navigateur.",
    recognized: "Ce que vous avez dit (reconnu)",
    recognizedPlaceholder: "Après l’enregistrement, votre essai apparaîtra ici.",
    showFeedback: "Afficher les retours",
    hideFeedback: "Masquer les retours",
    accuracy: "Précision (estimation)",
    scorePlaceholder: "Vous verrez un score après un essai.",
    scoreLine: (n: number) => `${n} % de correspondance avec la phrase idéale.`,
  },
  hi: {
    title: "Any-Speak सीखें",
    subtitle: "कुछ बोलें या लिखें। यह अपने आप अनुवाद करता है। फिर उसे बोलने का अभ्यास करें।",
    from: "स्रोत भाषा",
    to: "लक्ष्य भाषा",
    typeMode: "टाइप मोड",
    listening: "सुन रहा है…",
    recordSentence: "वाक्य रिकॉर्ड करें",
    stopRecording: "रोकें",
    micBlocked: "ब्राउज़र ने माइक्रोफ़ोन की अनुमति रोक दी है। आवाज़ इनपुट के लिए माइक्रोफ़ोन अनुमति जाँचें।",
    sttNotSupported: "इस ब्राउज़र में बोलने की सुविधाएँ उपलब्ध नहीं हैं। आप फिर भी टाइप, अनुवाद और सुन सकते हैं।",
    inputPlaceholder: "जो कहना है वह टाइप करें…",
    translating: "अनुवाद हो रहा है…",
    translation: "अनुवाद",
    translationPlaceholder: "यहाँ देखने के लिए लिखना शुरू करें या वाक्य रिकॉर्ड करें।",
    playTranslation: "अनुवाद चलाएँ",
    speed: "गति",
    practiceTitle: "अभ्यास",
    recordAttempt: "मेरा प्रयास रिकॉर्ड करें",
    stopAttempt: "प्रयास रोकें",
    playAttempt: "मेरा प्रयास चलाएँ",
    noAudioSupport: "इस ब्राउज़र में ऑडियो रिकॉर्डिंग समर्थित नहीं है।",
    recognized: "आपने क्या कहा (पहचाना गया)",
    recognizedPlaceholder: "रिकॉर्ड करने के बाद आपका प्रयास यहाँ दिखेगा।",
    showFeedback: "फ़ीडबैक दिखाएँ",
    hideFeedback: "फ़ीडबैक छिपाएँ",
    accuracy: "सटीकता (लगभग अनुमान)",
    scorePlaceholder: "एक प्रयास के बाद स्कोर दिखेगा।",
    scoreLine: (n: number) => `आदर्श वाक्य से ${n}% मिलान।`,
  },
  bn: {
    title: "Any-Speak শেখা",
    subtitle: "কিছু বলুন বা লিখুন। এটি স্বয়ংক্রিয়ভাবে অনুবাদ করবে। তারপর বলার অনুশীলন করুন।",
    from: "উৎস ভাষা",
    to: "লক্ষ্য ভাষা",
    typeMode: "টাইপ মোড",
    listening: "শুনছে…",
    recordSentence: "বাক্য রেকর্ড করুন",
    stopRecording: "থামান",
    micBlocked: "ব্রাউজার মাইক্রোফোনের অনুমতি ব্লক করেছে। ভয়েস ইনপুটের জন্য অনুমতি পরীক্ষা করুন।",
    sttNotSupported: "এই ব্রাউজারে ভয়েস ফিচার সমর্থিত নয়। তবুও আপনি টাইপ, অনুবাদ ও শুনতে পারবেন।",
    inputPlaceholder: "আপনি যা বলতে চান তা লিখুন…",
    translating: "অনুবাদ হচ্ছে…",
    translation: "অনুবাদ",
    translationPlaceholder: "এখানে দেখতে লিখতে শুরু করুন বা বাক্য রেকর্ড করুন।",
    playTranslation: "অনুবাদ চালান",
    speed: "গতি",
    practiceTitle: "অনুশীলন",
    recordAttempt: "আমার চেষ্টা রেকর্ড করুন",
    stopAttempt: "চেষ্টা থামান",
    playAttempt: "আমার চেষ্টা চালান",
    noAudioSupport: "এই ব্রাউজারে অডিও রেকর্ডিং সমর্থিত নয়।",
    recognized: "আপনি যা বলেছেন (স্বীকৃত)",
    recognizedPlaceholder: "রেকর্ড করার পর আপনার চেষ্টা এখানে দেখা যাবে।",
    showFeedback: "ফিডব্যাক দেখান",
    hideFeedback: "ফিডব্যাক লুকান",
    accuracy: "নির্ভুলতা (আনুমানিক)",
    scorePlaceholder: "একবার চেষ্টা করার পরে স্কোর দেখাবে।",
    scoreLine: (n: number) => `আদর্শ বাক্যের সাথে ${n}% মিল।`,
  },
  id: {
    title: "Any-Speak Belajar",
    subtitle: "Ucapkan atau ketik sesuatu. Terjemahan otomatis. Lalu berlatih mengucapkannya.",
    from: "Bahasa sumber",
    to: "Bahasa tujuan",
    typeMode: "Mode ketik",
    listening: "Mendengarkan…",
    recordSentence: "Rekam kalimat",
    stopRecording: "Berhenti",
    micBlocked: "Akses mikrofon diblokir oleh browser. Periksa izin mikrofon untuk menggunakan input suara.",
    sttNotSupported: "Fitur suara tidak didukung di browser ini. Anda tetap bisa mengetik, menerjemahkan, dan mendengarkan.",
    inputPlaceholder: "Ketik apa yang ingin Anda ucapkan…",
    translating: "Menerjemahkan…",
    translation: "Terjemahan",
    translationPlaceholder: "Mulai mengetik atau rekam kalimat untuk melihatnya di sini.",
    playTranslation: "Putar terjemahan",
    speed: "Kecepatan",
    practiceTitle: "Latihan",
    recordAttempt: "Rekam percobaan saya",
    stopAttempt: "Hentikan percobaan",
    playAttempt: "Putar percobaan saya",
    noAudioSupport: "Perekaman audio tidak didukung di browser ini.",
    recognized: "Yang Anda ucapkan (terdeteksi)",
    recognizedPlaceholder: "Setelah merekam, percobaan Anda akan muncul di sini.",
    showFeedback: "Tampilkan masukan",
    hideFeedback: "Sembunyikan masukan",
    accuracy: "Akurasi (perkiraan)",
    scorePlaceholder: "Anda akan melihat skor setelah percobaan.",
    scoreLine: (n: number) => `${n}% cocok dengan kalimat ideal.`,
  },
  ru: {
    title: "Any-Speak Обучение",
    subtitle: "Скажите или напишите фразу. Перевод автоматически. Затем потренируйтесь произнести её.",
    from: "Исходный язык",
    to: "Целевой язык",
    typeMode: "Режим ввода",
    listening: "Слушаю…",
    recordSentence: "Записать фразу",
    stopRecording: "Стоп",
    micBlocked: "Доступ к микрофону заблокирован браузером. Проверьте разрешение микрофона для голосового ввода.",
    sttNotSupported: "Голосовые функции не поддерживаются в этом браузере. Вы всё равно можете вводить текст, переводить и слушать.",
    inputPlaceholder: "Введите то, что хотите сказать…",
    translating: "Перевод…",
    translation: "Перевод",
    translationPlaceholder: "Начните ввод или запишите фразу, чтобы увидеть перевод здесь.",
    playTranslation: "Проиграть перевод",
    speed: "Скорость",
    practiceTitle: "Практика",
    recordAttempt: "Записать мою попытку",
    stopAttempt: "Остановить попытку",
    playAttempt: "Проиграть мою попытку",
    noAudioSupport: "Запись аудио не поддерживается в этом браузере.",
    recognized: "Что вы сказали (распознано)",
    recognizedPlaceholder: "После записи ваша попытка появится здесь.",
    showFeedback: "Показать отзыв",
    hideFeedback: "Скрыть отзыв",
    accuracy: "Точность (примерно)",
    scorePlaceholder: "После попытки появится оценка.",
    scoreLine: (n: number) => `Совпадение с идеальной фразой: ${n}%.`,
  },
  de: {
    title: "Any-Speak Lernen",
    subtitle: "Sag oder tippe etwas. Es wird automatisch übersetzt. Danach übe, es zu sagen.",
    from: "Ausgangssprache",
    to: "Zielsprache",
    typeMode: "Eingabemodus",
    listening: "Hört zu…",
    recordSentence: "Satz aufnehmen",
    stopRecording: "Stopp",
    micBlocked: "Der Browser hat den Mikrofonzugriff blockiert. Prüfe die Mikrofonberechtigung für Spracheingabe.",
    sttNotSupported: "Sprachfunktionen werden in diesem Browser nicht unterstützt. Du kannst trotzdem tippen, übersetzen und anhören.",
    inputPlaceholder: "Tippe, was du sagen möchtest…",
    translating: "Übersetzen…",
    translation: "Übersetzung",
    translationPlaceholder: "Beginne zu tippen oder nimm einen Satz auf, um ihn hier zu sehen.",
    playTranslation: "Übersetzung abspielen",
    speed: "Tempo",
    practiceTitle: "Übung",
    recordAttempt: "Meinen Versuch aufnehmen",
    stopAttempt: "Versuch stoppen",
    playAttempt: "Meinen Versuch abspielen",
    noAudioSupport: "Audioaufnahme wird in diesem Browser nicht unterstützt.",
    recognized: "Was du gesagt hast (erkannt)",
    recognizedPlaceholder: "Nach der Aufnahme erscheint dein Versuch hier.",
    showFeedback: "Feedback anzeigen",
    hideFeedback: "Feedback ausblenden",
    accuracy: "Genauigkeit (grobe Schätzung)",
    scorePlaceholder: "Nach einem Versuch siehst du eine Bewertung.",
    scoreLine: (n: number) => `${n}% Übereinstimmung mit dem idealen Satz.`,
  },
  ja: {
    title: "Any-Speak 学習",
    subtitle: "話すか入力してください。自動で翻訳します。その後、発話練習をします。",
    from: "元の言語",
    to: "翻訳先の言語",
    typeMode: "入力モード",
    listening: "聞き取り中…",
    recordSentence: "文を録音",
    stopRecording: "停止",
    micBlocked: "ブラウザがマイクアクセスをブロックしました。音声入力を使うにはマイク許可を確認してください。",
    sttNotSupported: "このブラウザでは音声機能がサポートされていません。入力・翻訳・再生は利用できます。",
    inputPlaceholder: "言いたいことを入力…",
    translating: "翻訳中…",
    translation: "翻訳",
    translationPlaceholder: "入力または録音するとここに表示されます。",
    playTranslation: "翻訳を再生",
    speed: "速度",
    practiceTitle: "練習",
    recordAttempt: "自分の試しを録音",
    stopAttempt: "試しを停止",
    playAttempt: "自分の試しを再生",
    noAudioSupport: "このブラウザでは録音できません。",
    recognized: "あなたの発話（認識結果）",
    recognizedPlaceholder: "録音後、ここに表示されます。",
    showFeedback: "フィードバックを表示",
    hideFeedback: "フィードバックを非表示",
    accuracy: "正確さ（目安）",
    scorePlaceholder: "試した後にスコアが表示されます。",
    scoreLine: (n: number) => `理想文との一致率 ${n}%。`,
  },
  ur: {
    title: "Any-Speak سیکھیں",
    subtitle: "کچھ بولیں یا لکھیں۔ یہ خودکار طور پر ترجمہ کرتا ہے۔ پھر اسے بولنے کی مشق کریں۔",
    from: "ماخذ زبان",
    to: "ہدف زبان",
    typeMode: "ٹائپ موڈ",
    listening: "سن رہا ہے…",
    recordSentence: "جملہ ریکارڈ کریں",
    stopRecording: "روکیں",
    micBlocked: "براؤزر نے مائیک تک رسائی روک دی ہے۔ آواز کے لیے مائیک اجازت چیک کریں۔",
    sttNotSupported: "اس براؤزر میں وائس فیچرز دستیاب نہیں ہیں۔ آپ پھر بھی ٹائپ، ترجمہ اور سن سکتے ہیں۔",
    inputPlaceholder: "جو کہنا چاہتے ہیں وہ لکھیں…",
    translating: "ترجمہ ہو رہا ہے…",
    translation: "ترجمہ",
    translationPlaceholder: "یہاں دیکھنے کے لیے لکھنا شروع کریں یا جملہ ریکارڈ کریں۔",
    playTranslation: "ترجمہ چلائیں",
    speed: "رفتار",
    practiceTitle: "مشق",
    recordAttempt: "میری کوشش ریکارڈ کریں",
    stopAttempt: "کوشش روکیں",
    playAttempt: "میری کوشش چلائیں",
    noAudioSupport: "اس براؤزر میں آڈیو ریکارڈنگ سپورٹ نہیں ہے۔",
    recognized: "آپ نے کیا کہا (پہچانا گیا)",
    recognizedPlaceholder: "ریکارڈ کے بعد آپ کی کوشش یہاں ظاہر ہوگی۔",
    showFeedback: "فیڈبیک دکھائیں",
    hideFeedback: "فیڈبیک چھپائیں",
    accuracy: "درستگی (تقریبی اندازہ)",
    scorePlaceholder: "کوشش کے بعد اسکور نظر آئے گا۔",
    scoreLine: (n: number) => `مثالی جملے سے ${n}% مماثلت۔`,
  },
} as const;

const UI = {
  ...UI_BASE,
  "es-ES": UI_BASE.es,
  "es-MX": UI_BASE.es,
  "es-US": UI_BASE.es,
  "es-419": UI_BASE.es,
  "pt-BR": UI_BASE.pt,
  "pt-PT": UI_BASE.pt,
  "zh-CN": UI_BASE.zh,
  "zh-Hans": UI_BASE.zh,
  "zh-SG": UI_BASE.zh,
  "zh-TW": UI_BASE.zh,
  "ar-EG": UI_BASE.ar,
  "ar-SA": UI_BASE.ar,
  "ar-AE": UI_BASE.ar,
  "fr-FR": UI_BASE.fr,
  "fr-CA": UI_BASE.fr,
  "hi-IN": UI_BASE.hi,
  "bn-BD": UI_BASE.bn,
  "id-ID": UI_BASE.id,
  "ru-RU": UI_BASE.ru,
  "de-DE": UI_BASE.de,
  "ja-JP": UI_BASE.ja,
  "ur-PK": UI_BASE.ur,
} as const;

export default function LearnPage() {
  const deviceLang = useMemo(() => getDeviceLang(), []);
  const uiLang = useMemo(() => getUiLang(deviceLang), [deviceLang]);
  const t = UI[uiLang];

  const [fromLang, setFromLang] = useState(() => pickSupportedLang(deviceLang, "en-US"));
  const [toLang, setToLang] = useState("en-US");

  // Keep this only for the “Type mode” button (focus/stop recording). Text is always allowed.
  const [inputMode, setInputMode] = useState<"type" | "speak">("type");

  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [attemptText, setAttemptText] = useState("");
  const [attemptAudioUrl, setAttemptAudioUrl] = useState<string | null>(null);
  const [attemptScore, setAttemptScore] = useState<number | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);

  const [isRecordingSource, setIsRecordingSource] = useState(false);
  const [isRecordingAttempt, setIsRecordingAttempt] = useState(false);
  const [sttSupported, setSttSupported] = useState<boolean | null>(null);
  const [mediaRecorderSupported, setMediaRecorderSupported] = useState<boolean | null>(null);

  // Device TTS speed
  const [ttsRate, setTtsRate] = useState<number>(0.85);

  const sourceRecRef = useRef<any>(null);
  const attemptRecRef = useRef<any>(null);
  const attemptMrRef = useRef<MediaRecorder | null>(null);
  const attemptStreamRef = useRef<MediaStream | null>(null);
  const attemptChunksRef = useRef<BlobPart[]>([]);
  const attemptAudioRef = useRef<HTMLAudioElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Debounce + ignore stale translate responses
  const translateTimerRef = useRef<number | null>(null);
  const translateReqIdRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const w = window as any;
    setMediaRecorderSupported(typeof (window as any).MediaRecorder !== "undefined");
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      console.warn("[Learn] SpeechRecognition not supported on this device");
      setSttSupported(false);
      return;
    }

    setSttSupported(true);

    const srcRec = new SpeechRecognitionCtor();
    srcRec.continuous = false;
    srcRec.interimResults = false;
    srcRec.lang = fromLang;

    srcRec.onresult = (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;
      const last = results[results.length - 1];
      const raw = last[0]?.transcript || "";
      setSourceText(raw.trim());
      setIsRecordingSource(false);
      setInputMode("type");
    };

    srcRec.onerror = (event: any) => {
      console.error("[Learn] source STT error", event.error);
      setError(event.error || "Speech recognition error.");
      setIsRecordingSource(false);
      setInputMode("type");
    };

    srcRec.onend = () => setIsRecordingSource(false);

    const attRec = new SpeechRecognitionCtor();
    attRec.continuous = false;
    attRec.interimResults = false;
    attRec.lang = toLang;

    attRec.onresult = (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;
      const last = results[results.length - 1];
      const raw = last[0]?.transcript || "";
      const text = raw.trim();
      setAttemptText(text);

      if (translatedText) setAttemptScore(scoreSimilarity(translatedText, text));
      setShowFeedback(false); // keep it collapsed by default
    };

    attRec.onerror = (event: any) => {
      console.error("[Learn] attempt STT error", event.error);
      setError(event.error || "Speech recognition error.");
      setIsRecordingAttempt(false);
    };

    attRec.onend = () => {};

    sourceRecRef.current = srcRec;
    attemptRecRef.current = attRec;

    return () => {
      try {
        srcRec.stop();
        attRec.stop();
      } catch {}
      sourceRecRef.current = null;
      attemptRecRef.current = null;
    };
  }, [fromLang, toLang, translatedText]);

  // Auto-translate (debounced)
  useEffect(() => {
    setError(null);

    // Clear any pending timer
    if (translateTimerRef.current) {
      window.clearTimeout(translateTimerRef.current);
      translateTimerRef.current = null;
    }

    const trimmed = sourceText.trim();

    // If empty, clear output immediately
    if (!trimmed) {
      setTranslatedText("");
      setLoading(false);
      return;
    }

    // Debounce typing; if it's coming from STT, it still runs fast enough.
    setLoading(true);
    const reqId = ++translateReqIdRef.current;

    translateTimerRef.current = window.setTimeout(() => {
      (async () => {
        try {
          const res = await translateText(fromLang, toLang, trimmed);
          // Ignore stale results
          if (reqId !== translateReqIdRef.current) return;
          setTranslatedText(res.translatedText);
        } catch (err: any) {
          console.error("[Learn] translate error", err);
          if (reqId !== translateReqIdRef.current) return;
          setError(err?.message || "Unexpected error in translation.");
        } finally {
          if (reqId === translateReqIdRef.current) setLoading(false);
        }
      })();
    }, 550);

    return () => {
      if (translateTimerRef.current) {
        window.clearTimeout(translateTimerRef.current);
        translateTimerRef.current = null;
      }
    };
  }, [sourceText, fromLang, toLang]);

// Cleanup attempt audio URL
useEffect(() => {
  return () => {
    if (attemptAudioUrl) {
      try {
        URL.revokeObjectURL(attemptAudioUrl);
      } catch {}
    }
  };
}, [attemptAudioUrl]);

  function handlePlayTarget() {
    const tts = translatedText.trim();
    if (!tts) return;
    speakText(tts, toLang, ttsRate);
  }

  function startSourceRecord() {
    setError(null);
    if (sttSupported === false || !sourceRecRef.current) {
      setError(t.sttNotSupported);
      return;
    }
    try {
      setInputMode("speak");
      setIsRecordingSource(true);
      sourceRecRef.current.lang = fromLang;
      sourceRecRef.current.start();
    } catch (err) {
      console.error("[Learn] start source error", err);
      setIsRecordingSource(false);
      setInputMode("type");
    }
  }

  function stopSourceRecord() {
    try {
      sourceRecRef.current?.stop?.();
    } catch {}
    setIsRecordingSource(false);
    setInputMode("type");
  }

  async function startAttemptRecord() {
  setError(null);
  if (!translatedText.trim()) return;

  if (!sttSupported || !attemptRecRef.current) {
    setError(t.sttNotSupported);
    return;
  }

  // Audio capture (for playback)
  const canRecordAudio = typeof window !== "undefined" && typeof (window as any).MediaRecorder !== "undefined";
  if (!canRecordAudio) {
    setError(t.noAudioSupport);
    // Still allow STT attempt without audio playback
  }

  try {
    // Reset attempt state
    setIsRecordingAttempt(true);
    setAttemptText("");
    setAttemptScore(null);
    setShowFeedback(false);

    // Clear previous audio
    if (attemptAudioUrl) {
      try {
        URL.revokeObjectURL(attemptAudioUrl);
      } catch {}
    }
    setAttemptAudioUrl(null);

    // Start MediaRecorder if available
    if (canRecordAudio) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      attemptStreamRef.current = stream;
      attemptChunksRef.current = [];

      const mr = new MediaRecorder(stream);
      attemptMrRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) attemptChunksRef.current.push(e.data);
      };

      mr.onstop = () => {
        const parts = attemptChunksRef.current;
        attemptChunksRef.current = [];
        const blob = new Blob(parts, { type: mr.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        setAttemptAudioUrl(url);

        // Auto-play once recording is ready
        setTimeout(() => {
          try {
            attemptAudioRef.current?.play?.();
          } catch {}
        }, 0);
      };

      mr.start();
    }

    // Start speech recognition (for transcript + scoring)
    attemptRecRef.current.lang = toLang;
    attemptRecRef.current.start();
  } catch (err) {
    console.error("[Learn] start attempt error", err);
    setIsRecordingAttempt(false);

    // Cleanup stream if it was opened
    try {
      attemptMrRef.current?.stop?.();
    } catch {}
    attemptMrRef.current = null;

    if (attemptStreamRef.current) {
      try {
        attemptStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
    }
    attemptStreamRef.current = null;
  }
}

function stopAttemptRecord() {
  // Stop speech recognition
  try {
    attemptRecRef.current?.stop?.();
  } catch {}

  // Stop audio recording
  try {
    if (attemptMrRef.current && attemptMrRef.current.state !== "inactive") {
      attemptMrRef.current.stop();
    }
  } catch {}

  // Stop mic tracks
  if (attemptStreamRef.current) {
    try {
      attemptStreamRef.current.getTracks().forEach((t) => t.stop());
    } catch {}
  }
  attemptStreamRef.current = null;
  attemptMrRef.current = null;

  setIsRecordingAttempt(false);
}

  function swapLangs() {
    setFromLang((prevFrom) => {
      setToLang(prevFrom);
      return toLang;
    });
    // Reset practice bits
    setAttemptText("");
    setAttemptScore(null);
    setShowFeedback(false);
  }

  function focusTypeMode() {
    setInputMode("type");
    stopSourceRecord();
    // Focus after state settles
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const sttWarning =
    sttSupported === false
      ? t.sttNotSupported
      : null;

  const translationDisplay = useMemo(() => {
    if (!translatedText.trim()) return null;

    // Only highlight when user explicitly opens feedback AND there is an attempt
    if (!showFeedback || !attemptText.trim()) {
      return <div className="leading-relaxed text-slate-50">{translatedText}</div>;
    }

    const originalWords = translatedText.split(/\s+/).filter(Boolean);
    const idealNorm = normalizeWords(translatedText);
    const attemptNorm = normalizeWords(attemptText || "");

    return (
      <div className="leading-relaxed">
        {originalWords.map((w, i) => {
          const ok = idealNorm[i] && attemptNorm[i] && idealNorm[i] === attemptNorm[i];
          return (
            <span
              key={`${w}-${i}`}
              className={`px-0.5 rounded ${
                ok ? "bg-emerald-500/15 text-emerald-100" : "bg-red-500/15 text-red-100"
              }`}
            >
              {w}
              {i < originalWords.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    );
  }, [translatedText, attemptText, showFeedback]);

  const canPlay = translatedText.trim().length > 0;

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-900 text-slate-100 px-4 py-4">
      <Card className="w-full max-w-xl md:max-w-2xl bg-slate-800 border border-slate-400 shadow-2xl flex flex-col">
        <CardHeader className="pb-2 text-center">
          <CardTitle className="text-2xl font-bold text-white">{t.title}</CardTitle>
          <p className="text-sm text-slate-200 mt-1">{t.subtitle}</p>
        </CardHeader>

        <CardContent className="space-y-3 px-5 pb-3">
          {/* Language selectors */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-slate-100">{t.from}</Label>
              <select
                value={fromLang}
                onChange={(e) => setFromLang(e.target.value)}
                className="w-full rounded-md border border-slate-500 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {LANGUAGES.map((lang: LanguageConfig) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-slate-100">{t.to}</Label>
                <button
                  type="button"
                  onClick={swapLangs}
                  className="text-[11px] text-slate-200 hover:text-white underline underline-offset-2"
                >
                  ↔
                </button>
              </div>
              <select
                value={toLang}
                onChange={(e) => setToLang(e.target.value)}
                className="w-full rounded-md border border-slate-500 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {LANGUAGES.map((lang: LanguageConfig) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Input card */}
          <div className="space-y-2">
            <Textarea
              ref={inputRef}
              rows={3}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder={inputMode === "speak" ? t.listening : t.inputPlaceholder}
              className="bg-slate-900 border border-slate-500 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />

            {/* Controls row: Type mode (left), Record sentence (center), Play translation (right) */}
            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={focusTypeMode}
                className="border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 text-[11px]"
              >
                {t.typeMode}
              </Button>

              <Button
  size="sm"
  onClick={() => {
    if (isRecordingSource) stopSourceRecord();
    else startSourceRecord();
  }}
  disabled={sttSupported === false}
  className="bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-semibold disabled:opacity-60 text-[11px]"
>
  {isRecordingSource ? t.stopRecording : t.recordSentence}
</Button>

              <Button
                size="sm"
                variant="outline"
                onClick={handlePlayTarget}
                disabled={!canPlay}
                className="border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-[11px]"
              >
                {t.playTranslation}
              </Button>
            </div>

            {/* Speed + translating status */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 px-2 py-1 rounded-md border border-slate-600 bg-slate-900">
                <span className="text-[11px] text-slate-200">{t.speed}</span>
                <input
                  type="range"
                  min={0.6}
                  max={1.2}
                  step={0.05}
                  value={ttsRate}
                  onChange={(e) => setTtsRate(Number(e.target.value))}
                />
                <span className="text-[11px] text-slate-200 w-10 text-right">
                  {ttsRate.toFixed(2)}x
                </span>
              </div>

              <div className="text-[11px] text-slate-200">
                {loading ? t.translating : null}
              </div>
            </div>
          </div>

          {error && (
            <div className="text-[11px] text-red-200">
              {error === "not-allowed" ? t.micBlocked : error}
            </div>
          )}

          {sttWarning && <div className="text-[11px] text-amber-200">{sttWarning}</div>}

          {/* Translation output */}
          <div className="space-y-1">
            <Label className="text-xs text-slate-100">{t.translation}</Label>
            <div className="min-h-[2.5rem] rounded-md border border-slate-500 bg-slate-900 px-3 py-2 text-sm text-slate-50">
              {translatedText ? (
                translationDisplay
              ) : (
                <span className="text-slate-400">{t.translationPlaceholder}</span>
              )}
            </div>
          </div>

          {/* Practice */}
          <div className="space-y-2 border-t border-slate-600 pt-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm text-slate-100">{t.practiceTitle}</Label>
              <Button
  size="sm"
  onClick={() => {
    if (isRecordingAttempt) stopAttemptRecord();
    else startAttemptRecord();
  }}
  disabled={!translatedText.trim()}
  className="bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-semibold disabled:opacity-60 text-[11px]"
>
  {isRecordingAttempt ? t.stopAttempt : t.recordAttempt}
</Button>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-slate-300">{t.recognized}</Label>
              <div className="min-h-[2.5rem] rounded-md border border-slate-500 bg-slate-900 px-3 py-2 text-sm text-slate-50">
                {attemptText || <span className="text-slate-400">{t.recognizedPlaceholder}</span>}
              </div>

{/* Attempt playback */}
{attemptAudioUrl && (
  <div className="flex items-center justify-between gap-2">
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
                      try {
                        if (attemptAudioUrl) {
                          attemptAudioRef.current?.play?.();
                        } else {
                          const said = (attemptText || "").trim();
                          if (said) speakText(said, toLang, ttsRate);
                        }
                      } catch {}
                    }}
      className="border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 text-[11px]"
    >
      {t.playAttempt}
    </Button>

    <audio ref={attemptAudioRef} src={attemptAudioUrl} preload="auto" />
  </div>
)}
            </div>

            {/* Collapsed feedback */}
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setShowFeedback((v) => !v)}
                className="text-[11px] text-slate-200 hover:text-white underline underline-offset-2"
                disabled={!attemptText.trim() && attemptScore === null}
                title={!attemptText.trim() && attemptScore === null ? t.scorePlaceholder : ""}
              >
                {showFeedback ? t.hideFeedback : t.showFeedback}
              </button>

              {showFeedback && (
                <div className="space-y-1">
                  <Label className="text-[11px] text-slate-300">{t.accuracy}</Label>
                  <div className="text-sm text-slate-50">
                    {attemptScore === null ? (
                      <span className="text-slate-400">{t.scorePlaceholder}</span>
                    ) : (
                      <span>{t.scoreLine(attemptScore)}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
