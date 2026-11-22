const CRITICAL_KEYWORDS = [
  "chest pain", "breathing", "breath", "unconscious", "faint", "stroke",
  "bleeding", "heart attack", "severe pain", "suicidal", "paralysis",
  "high fever", "seizure", "dizzy", "swelling", "ಛಾತಿ ನೋವು", "ಉಸಿರಾಟ",
  "நெஞ்சு வலி", "सांस लेने में", "ఛాతి నొప్పి"
];

function currentAITranslations() {
  return I18N[state.lang] || I18N.en;
}

function setAIStatus(message, isError = false, isListening = false) {
  const status = document.getElementById("ai-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.classList.toggle("listening", isListening);
}

function appendAIMessage(className, text) {
  const box = document.getElementById("ai-chat-box");
  const message = document.createElement("div");
  message.className = `msg ${className}`;
  message.textContent = text;
  box.append(message);
  box.scrollTop = box.scrollHeight;
  return message;
}

function appendAIResponse(text) {
  const box = document.getElementById("ai-chat-box");
  const message = document.createElement("div");
  message.className = "msg ai";
  const response = document.createElement("div");
  response.className = "ai-response";
  response.textContent = text;
  const actions = document.createElement("div");
  actions.className = "ai-response-actions";
  const speaker = document.createElement("button");
  speaker.type = "button";
  speaker.className = "tts-btn";
  speaker.textContent = "🔊";
  speaker.setAttribute("aria-label", "Read this response aloud");
  speaker.addEventListener("click", () => speakAIResponse(text));
  actions.append(speaker);
  message.append(response, actions);
  box.append(message);
  box.scrollTop = box.scrollHeight;
}

function initAIChat() {
  const box = document.getElementById("ai-chat-box");
  if (!box) return;
  box.replaceChildren();
  appendAIMessage("ai", currentAITranslations().welcomeAI);
  setAIStatus("");
}

function sendQuickPrompt(text) {
  const input = document.getElementById("ai-input");
  if (!input) return;
  input.value = text;
  document.querySelector("#view-patient form[onsubmit*='handleAIChat']")?.requestSubmit();
}

async function handleAIChat(event) {
  event.preventDefault();
  if (aiRequestInFlight) return;
  const input = document.getElementById("ai-input");
  const question = input.value.trim();
  if (!question) return;

  const t = currentAITranslations();
  aiRequestInFlight = true;
  const askButton = document.querySelector("#view-patient form button[type='submit']");
  if (askButton) askButton.disabled = true;
  appendAIMessage("user", question);
  input.value = "";
  setAIStatus(t.ai_loading);
  const loadingMessage = appendAIMessage("ai", t.ai_loading);
  const isCritical = CRITICAL_KEYWORDS.some(keyword => question.toLowerCase().includes(keyword));

  if (isCritical) {
    try {
      await apiRequest("/api/alerts", {
        method: "POST",
        body: JSON.stringify({
          type: "CRITICAL_SYMPTOM",
          title: `Critical symptom reported: ${question.slice(0, 180)}`,
          detail: "The patient reported a potentially urgent symptom in the health assistant."
        })
      });
      await syncFromBackend();
    } catch (error) {
      setAIStatus(t.ai_alert_error, true);
    }
  }

  try {
    const data = await apiRequest("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({ message: question, language: state.lang })
    });
    loadingMessage.remove();
    appendAIResponse(data.reply);
    setAIStatus(isCritical ? t.ai_urgent_advice : "");
  } catch (error) {
    loadingMessage.remove();
    appendAIMessage("critical", t.ai_error);
    setAIStatus(t.ai_error, true);
  } finally {
    aiRequestInFlight = false;
    if (askButton) askButton.disabled = false;
  }
}

function toggleAIRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const t = currentAITranslations();
  if (!Recognition) {
    setAIStatus(t.ai_mic_unavailable, true);
    return;
  }
  if (recognition) {
    recognition.stop();
    return;
  }

  const activeRecognition = new Recognition();
  activeRecognition.lang = t.speechCode;
  activeRecognition.continuous = false;
  activeRecognition.interimResults = true;
  activeRecognition.maxAlternatives = 1;
  recognition = activeRecognition;
  const micButton = document.getElementById("ai-mic-btn");
  if (micButton) micButton.classList.add("listening");
  setAIStatus(t.ai_mic_listening, false, true);

  activeRecognition.onresult = event => {
    let transcript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript;
    }
    if (transcript) document.getElementById("ai-input").value = transcript.trim();
  };
  activeRecognition.onerror = () => setAIStatus(t.ai_mic_error, true);
  activeRecognition.onend = () => {
    recognition = null;
    if (micButton) micButton.classList.remove("listening");
    if (!document.getElementById("ai-status").classList.contains("error")) setAIStatus("");
    document.getElementById("ai-input").focus();
  };
  try {
    activeRecognition.start();
  } catch (error) {
    recognition = null;
    if (micButton) micButton.classList.remove("listening");
    setAIStatus(t.ai_mic_error, true);
  }
}

function speakAIResponse(text) {
  const t = currentAITranslations();
  if (!("speechSynthesis" in window)) {
    setAIStatus(t.ai_voice_unavailable, true);
    return;
  }
  stopBrowserSpeech();
  const voices = window.speechSynthesis.getVoices();
  const languagePrefix = t.speechCode.split("-")[0].toLowerCase();
  const voice = voices.find(item => item.lang.toLowerCase().startsWith(`${languagePrefix}-`));
  if (state.lang === "kn" && !voice) {
    setAIStatus(t.ai_voice_unavailable, true);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = t.speechCode;
  if (voice) utterance.voice = voice;
  utterance.rate = 0.95;
  utterance.onerror = () => setAIStatus(t.ai_voice_unavailable, true);
  window.speechSynthesis.speak(utterance);
}

function stopAISpeech() {
  stopBrowserSpeech();
  setAIStatus("");
}
