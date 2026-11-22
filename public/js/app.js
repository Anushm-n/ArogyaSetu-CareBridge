const STORAGE_KEY = "arogyasetu_carebridge_state_v2";
const LEGACY_SESSION_KEY = "arogyasetu_session";
const REMINDER_AUDIO_KEY = "carebridge_voice_reminders";
const REMINDER_MARKER_PREFIX = "carebridge_reminders_";

const defaultState = {
  lang: localStorage.getItem("preferred_lang") || "en",
  activeRole: "patient",
  sosActive: false,
  sosTimestamp: null,
  dueMedId: null,
  users: [],
  medicines: [],
  alerts: [],
  vitals: []
};

let state = { ...defaultState };
let currentUser = null;
let reminderTimer = null;
let recognition = null;
let aiRequestInFlight = false;
let currentRecognition = null;
const inMemoryReminderMarkers = new Set();

function saveState() {
  try {
    localStorage.setItem("preferred_lang", state.lang);
  } catch (error) {
    setAppStatus("Could not save your language preference.", true);
  }
}

function stopBrowserSpeech() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function clearBrowserAuthState() {
  stopBrowserSpeech();
  if (recognition) {
    recognition.onend = null;
    recognition.abort();
    recognition = null;
  }
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_SESSION_KEY);
}

function forceLogin() {
  clearBrowserAuthState();
  window.location.replace("login.html");
}

async function apiRequest(endpoint, options = {}) {
  const response = await fetch(endpoint, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(options.body ? { "Content-Type": "application/json" } : {})
    }
  });
  if (response.status === 401) {
    forceLogin();
    throw new Error("Authentication required.");
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error("The server returned an invalid response.");
  }
  if (!response.ok || data.success === false) {
    throw new Error(data.message || "The request could not be completed.");
  }
  return data;
}

async function logoutSession() {
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    if (!response.ok) throw new Error("Logout request failed.");
    clearBrowserAuthState();
    window.location.replace("login.html");
  } catch (error) {
    setAppStatus("Logout could not reach the server. Your session is still active; try again.", true);
  }
}

function setAppStatus(message, isError = false) {
  const el = document.getElementById("api-sync-status");
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? "#fca5a5" : "#34d399";
}

function configureRoleUI(role) {
  document.querySelectorAll(".role-view").forEach(section => {
    if (section.id !== `view-${role}`) section.remove();
    else section.classList.add("active");
  });
  document.querySelectorAll(".role-tab").forEach(tab => {
    if (tab.getAttribute("data-role") !== role) tab.remove();
    else tab.classList.add("active");
  });
  if (role !== "patient") {
    const reminder = document.getElementById("demo-reminder-btn");
    const skip = document.getElementById("demo-skip-btn");
    if (reminder) reminder.remove();
    if (skip) skip.remove();
  }
  if (role !== "admin") {
    const reset = document.getElementById("demo-reset-btn");
    if (reset) reset.remove();
  }
}

async function initializeDashboard() {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) {
      forceLogin();
      return;
    }
    const result = await response.json();
    if (!result.success || !result.user || !result.user.role) {
      forceLogin();
      return;
    }

    currentUser = result.user;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
    state = {
      ...defaultState,
      lang: localStorage.getItem("preferred_lang") || currentUser.language || "en",
      activeRole: currentUser.role
    };
    document.getElementById("session-user-badge").textContent =
      `${currentUser.name} (${currentUser.role.toUpperCase()})`;
    configureRoleUI(currentUser.role);
    document.body.classList.remove("auth-pending");
    applyTranslations();
    if (currentUser.role === "patient") initAIChat();
    switchRole(currentUser.role);
    await syncFromBackend();
    if (currentUser.role === "patient") startScheduledReminders();
  } catch (error) {
    forceLogin();
  }
}

async function syncFromBackend() {
  try {
    const data = await apiRequest("/api/state");
    state.users = data.users || [];
    state.medicines = data.medicines || [];
    state.alerts = data.alerts || [];
    state.vitals = data.vitals || [];
    state.sosActive = Boolean(data.sos && data.sos.active);
    state.sosTimestamp = data.sos ? data.sos.timestamp : null;
    setAppStatus("● Backend Synced (MySQL)");
    renderAll();
  } catch (error) {
    setAppStatus(error.message || "Could not load dashboard data.", true);
  }
}

function changeLanguage(lang) {
  if (!Object.prototype.hasOwnProperty.call(I18N, lang)) return;
  state.lang = lang;
  saveState();
  applyTranslations();
  renderAll();
}

function applyTranslations() {
  const t = I18N[state.lang] || I18N.en;
  const selector = document.getElementById("lang-select");
  if (selector) selector.value = state.lang;
  const title = document.getElementById("ui-app-title");
  if (title) title.textContent = t.title;
  const subtitle = document.getElementById("ui-app-subtitle");
  if (subtitle) subtitle.textContent = t.subtitle;
  const listen = document.getElementById("ui-listen-btn");
  if (listen) listen.textContent = t.listen;
  const sos = document.getElementById("ui-sos-btn");
  if (sos) sos.textContent = t.sos;

  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (t[key]) el.textContent = t[key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (t[key]) el.setAttribute("placeholder", t[key]);
  });
  const micButton = document.getElementById("ai-mic-btn");
  if (micButton) {
    micButton.setAttribute("aria-label", t.ai_mic_button);
    micButton.setAttribute("title", t.ai_mic_button);
  }
}

function speakText(text) {
  if (!("speechSynthesis" in window)) {
    const reminderStatus = document.getElementById("reminder-status");
    if (reminderStatus) reminderStatus.textContent = (I18N[state.lang] || I18N.en).ai_voice_unavailable;
    return false;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = (I18N[state.lang] || I18N.en).speechCode;
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
  return true;
}

function speakPageSummary() {
  const t = I18N[state.lang] || I18N.en;
  const due = state.medicines.find(m => getMedicineStatus(m) === "due");
  if (due) speakText(`It is time to take your ${due.name} medicine.`);
  else speakText(`${t.title}. Your medicine reminders are active while this dashboard is open.`);
}

function speakMedicines() {
  if (!state.medicines.length) {
    speakText("No medicines scheduled.");
    return;
  }
  speakText(state.medicines.map(m => `${m.name}, ${m.dose}, at ${m.time}`).join(". "));
}

function switchRole(role) {
  if (!currentUser || role !== currentUser.role) return;
  state.activeRole = role;
  document.querySelectorAll(".role-tab").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-role") === role);
  });
  document.querySelectorAll(".role-view").forEach(section => {
    section.classList.toggle("active", section.id === `view-${role}`);
  });
  renderAll();
}

async function addMedicine(event) {
  event.preventDefault();
  const name = document.getElementById("med-name").value.trim();
  const dose = document.getElementById("med-dose").value.trim();
  const notes = document.getElementById("med-notes").value.trim();
  const time = document.getElementById("med-time").value;
  if (!name || !dose || !time) return;

  try {
    const data = await apiRequest("/api/medicines", {
      method: "POST",
      body: JSON.stringify({ name, dose, notes, time })
    });
    state.medicines = data.medicines;
    event.target.reset();
    setAppStatus("Medicine saved to MySQL.");
    renderAll();
  } catch (error) {
    setAppStatus(`Medicine was not saved: ${error.message}`, true);
  }
}

async function updateMedStatus(id, newStatus) {
  const medicine = state.medicines.find(item => String(item.id) === String(id));
  if (!medicine) return;
  try {
    const data = await apiRequest(`/api/medicines/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ status: newStatus })
    });
    state.medicines = data.medicines;
    state.alerts = data.alerts;
    if (String(state.dueMedId) === String(id)) state.dueMedId = null;
    if (newStatus === "skipped") speakText(`The skipped dose of ${medicine.name} was recorded. Caretaker and nurse notifications were sent.`);
    else if (newStatus === "taken") speakText(`Marked ${medicine.name} as taken.`);
    renderAll();
  } catch (error) {
    setAppStatus(`Medicine status was not saved: ${error.message}`, true);
  }
}

function getLocalDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function getMedicineStatus(medicine) {
  return medicine.status_date && medicine.status_date !== getLocalDate() ? "pending" : medicine.status;
}

function getReminderMarkers(date) {
  try {
    const markers = JSON.parse(localStorage.getItem(REMINDER_MARKER_PREFIX + date) || "[]");
    return new Set(Array.isArray(markers) ? markers : []);
  } catch (error) {
    return new Set([...inMemoryReminderMarkers].filter(marker => marker.startsWith(`${date}:`)));
  }
}

function markReminderShown(date, marker) {
  const key = `${date}:${marker}`;
  inMemoryReminderMarkers.add(key);
  try {
    const markers = getReminderMarkers(date);
    markers.add(marker);
    localStorage.setItem(REMINDER_MARKER_PREFIX + date, JSON.stringify([...markers]));
  } catch (error) {
    setAppStatus("Reminder state could not be saved in this browser.", true);
  }
}

function notifyMedicineDue(medicine, date) {
  const phrase = `It is time to take your ${medicine.name} medicine.`;
  state.dueMedId = medicine.id;
  const marker = `${medicine.id}:${medicine.time}`;
  markReminderShown(date, marker);

  const reminderStatus = document.getElementById("reminder-status");
  if (reminderStatus) reminderStatus.textContent = phrase;
  renderAll();
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Medicine reminder", { body: phrase, tag: `${date}-${marker}` });
  }
  if (localStorage.getItem(REMINDER_AUDIO_KEY) !== "false") speakText(phrase);

  updateMedStatus(medicine.id, "due");
}

function checkScheduledReminders() {
  if (!currentUser || currentUser.role !== "patient") return;
  const now = new Date();
  const date = getLocalDate();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const markers = getReminderMarkers(date);
  for (const medicine of state.medicines) {
    const status = getMedicineStatus(medicine);
    if (status === "taken" || status === "skipped" || !/^\d{2}:\d{2}$/.test(medicine.time)) continue;
    if (medicine.time > currentTime) continue;
    const marker = `${medicine.id}:${medicine.time}`;
    if (markers.has(marker)) continue;
    notifyMedicineDue(medicine, date);
  }
}

function startScheduledReminders() {
  if (reminderTimer) window.clearInterval(reminderTimer);
  checkScheduledReminders();
  reminderTimer = window.setInterval(checkScheduledReminders, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkScheduledReminders();
  });
}

async function enableMedicineReminders() {
  const t = I18N[state.lang] || I18N.en;
  try {
    if (!("Notification" in window)) {
      document.getElementById("reminder-status").textContent = t.reminder_notification_unavailable;
    } else {
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      document.getElementById("reminder-status").textContent =
        permission === "granted" ? t.reminder_enabled : t.reminder_permission_denied;
    }
    localStorage.setItem(REMINDER_AUDIO_KEY, "true");
    if ("speechSynthesis" in window) speakText("Voice medicine reminders are enabled.");
  } catch (error) {
    document.getElementById("reminder-status").textContent = t.reminder_permission_denied;
  }
}

function replayMedicineReminder(id) {
  const medicine = state.medicines.find(item => String(item.id) === String(id));
  if (medicine) speakText(`It is time to take your ${medicine.name} medicine.`);
}

function replayDueReminder() {
  const medicine = state.medicines.find(item => String(item.id) === String(state.dueMedId))
    || state.medicines.find(item => getMedicineStatus(item) === "due");
  if (medicine) replayMedicineReminder(medicine.id);
}

async function triggerDueReminder() {
  const medicine = state.medicines.find(item => getMedicineStatus(item) === "due")
    || state.medicines.find(item => getMedicineStatus(item) === "pending");
  if (!medicine) return;
  state.dueMedId = medicine.id;
  await updateMedStatus(medicine.id, "due");
  replayMedicineReminder(medicine.id);
}

function handleDueAction(action) {
  const medicine = state.medicines.find(item => String(item.id) === String(state.dueMedId))
    || state.medicines.find(item => getMedicineStatus(item) === "due");
  if (medicine) updateMedStatus(medicine.id, action);
}

async function simulateSkippedDose() {
  if (!currentUser || currentUser.role !== "patient") return;
  const target = state.medicines.find(medicine => getMedicineStatus(medicine) !== "skipped");
  if (target) await updateMedStatus(target.id, "skipped");
}

async function clearAlerts() {
  try {
    const data = await apiRequest("/api/alerts/ack", { method: "POST" });
    state.alerts = data.alerts;
    renderAll();
  } catch (error) {
    setAppStatus(`Alerts were not acknowledged: ${error.message}`, true);
  }
}

async function triggerSOS() {
  try {
    const data = await apiRequest("/api/sos", {
      method: "POST",
      body: JSON.stringify({ active: true, triggeredBy: currentUser.name })
    });
    state.sosActive = data.sos.active;
    state.sosTimestamp = data.sos.timestamp;
    state.alerts = data.alerts;
    renderAll();
    speakText("Emergency SOS activated. Please follow the instructions of local emergency services.");
  } catch (error) {
    setAppStatus(`SOS could not be saved: ${error.message}`, true);
  }
}

async function resolveSOS() {
  try {
    const data = await apiRequest("/api/sos", {
      method: "POST",
      body: JSON.stringify({ active: false })
    });
    state.sosActive = data.sos.active;
    state.sosTimestamp = data.sos.timestamp;
    renderAll();
  } catch (error) {
    setAppStatus(`SOS status could not be updated: ${error.message}`, true);
  }
}

async function doctorPrescribe(event) {
  event.preventDefault();
  const name = document.getElementById("doc-med-name").value.trim();
  const time = document.getElementById("doc-med-time").value;
  const notes = document.getElementById("doc-med-note").value.trim();
  if (!name || !time || !notes) return;
  try {
    const data = await apiRequest("/api/medicines", {
      method: "POST",
      body: JSON.stringify({ name: `${name} (Rx: Dr. Hegde)`, dose: "As prescribed", notes, time })
    });
    state.medicines = data.medicines;
    event.target.reset();
    setAppStatus("e-Prescription saved to the patient schedule.");
    renderAll();
  } catch (error) {
    setAppStatus(`Prescription was not saved: ${error.message}`, true);
  }
}

async function recordVitals(event) {
  event.preventDefault();
  const bp = document.getElementById("vital-bp").value.trim();
  const sugar = document.getElementById("vital-sugar").value.trim();
  try {
    const data = await apiRequest("/api/vitals", {
      method: "POST",
      body: JSON.stringify({ bp, sugar, by: currentUser.name })
    });
    state.vitals = data.vitals;
    event.target.reset();
    renderAll();
  } catch (error) {
    setAppStatus(`Vitals were not saved: ${error.message}`, true);
  }
}

function openTeleModal(who) {
  document.getElementById("tele-modal-title").textContent = `📞 Direct ${who} Emergency Call & Live Chat`;
  document.getElementById("tele-modal").classList.add("open");
}

function closeTeleModal() {
  document.getElementById("tele-modal").classList.remove("open");
}

function sendTeleMessage(event) {
  event.preventDefault();
  const input = document.getElementById("tele-input");
  const text = input.value.trim();
  if (!text) return;
  const log = document.getElementById("tele-chat-log");
  log.innerHTML += `<div style="margin-top:6px;"><strong>Patient/Caretaker:</strong> ${escapeHtml(text)}</div>`;
  log.innerHTML += `<div style="margin-top:6px; color:#0f766e;"><strong>Dr. S. Hegde:</strong> Nurse Kavita is reviewing the message and will follow up. For emergencies, contact local emergency services.</div>`;
  input.value = "";
  log.scrollTop = log.scrollHeight;
}

function updateBadges() {
  const unacknowledged = state.alerts.filter(alert => !alert.acknowledged).length;
  for (const id of ["caretaker-badge", "nurse-badge"]) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    badge.style.display = unacknowledged ? "inline-block" : "none";
    badge.textContent = unacknowledged;
  }
}

function renderAll() {
  const t = I18N[state.lang] || I18N.en;
  const sosBanner = document.getElementById("sos-banner");
  if (sosBanner) {
    sosBanner.classList.toggle("active", state.sosActive);
    if (state.sosActive) {
      const details = document.getElementById("sos-details");
      if (details) details.textContent = `Triggered at ${state.sosTimestamp} • Patient: Ramesh Kumar (64M, O+) • Location: Siddapur, Karnataka • Ambulance #KA-31-EM-108 Dispatched.`;
    }
  }
  const hospitalStatus = document.getElementById("hosp-patient-status");
  if (hospitalStatus) {
    hospitalStatus.innerHTML = state.sosActive
      ? `<span class="status-pill pill-skipped">🚨 SOS INCOMING</span>`
      : `<span class="status-pill pill-taken">Stable • Home Monitored</span>`;
  }

  const dueMedicine = state.medicines.find(medicine => getMedicineStatus(medicine) === "due");
  const dueBanner = document.getElementById("due-banner");
  if (dueBanner) {
    dueBanner.classList.toggle("active", Boolean(dueMedicine));
    if (dueMedicine) {
      state.dueMedId = dueMedicine.id;
      document.getElementById("due-desc").textContent =
        `${dueMedicine.name} (${dueMedicine.dose}) — Scheduled at ${dueMedicine.time}`;
    }
  }

  const medList = document.getElementById("patient-med-list");
  if (medList) {
    medList.innerHTML = state.medicines.map(medicine => {
      const status = getMedicineStatus(medicine);
      return `
        <div class="med-item ${escapeHtml(status)}">
          <div>
            <strong>${escapeHtml(medicine.name)}</strong> <span class="status-pill pill-${escapeHtml(status)}">${escapeHtml(status)}</span>
            <div style="font-size:0.85rem; color:var(--muted);">⏰ ${escapeHtml(medicine.time)} • ${escapeHtml(medicine.dose)}${medicine.notes ? ` • ${escapeHtml(medicine.notes)}` : ""}</div>
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="tts-btn" onclick="replayMedicineReminder(${Number(medicine.id)})" title="Replay reminder">🔊</button>
            <button class="btn btn-success btn-sm" onclick="updateMedStatus(${Number(medicine.id)}, 'taken')">✓ ${t.btn_taken}</button>
            <button class="btn btn-danger btn-sm" onclick="updateMedStatus(${Number(medicine.id)}, 'skipped')">✕ ${t.btn_skip}</button>
          </div>
        </div>`;
    }).join("");
  }

  const alertsDiv = document.getElementById("caretaker-alerts-list");
  if (alertsDiv) {
    alertsDiv.innerHTML = state.alerts.length
      ? state.alerts.map(alert => `
        <div class="med-item skipped" style="opacity:${alert.acknowledged ? 0.65 : 1};">
          <div><strong>${escapeHtml(alert.title)}</strong> <span style="font-size:0.78rem; color:var(--muted);">(${escapeHtml(alert.time)})</span>
            <p style="font-size:0.86rem; margin-top:4px;">${escapeHtml(alert.detail)}</p></div>
          <button class="btn btn-primary btn-sm" onclick="openTeleModal('Patient / Nurse')">📞 Follow Up</button>
        </div>`).join("")
      : `<p style="color:var(--muted); font-size:0.9rem;">✅ No missed doses or emergency alerts right now. Patient is on schedule.</p>`;
  }

  const caretakerMeds = document.getElementById("caretaker-med-mirror");
  if (caretakerMeds) {
    caretakerMeds.innerHTML = state.medicines.map(medicine => `
      <div class="med-item ${escapeHtml(getMedicineStatus(medicine))}">
        <div><strong>${escapeHtml(medicine.name)}</strong>
          <div style="font-size:0.84rem; color:var(--muted);">Scheduled: ${escapeHtml(medicine.time)} • ${escapeHtml(medicine.dose)}</div></div>
        <span class="status-pill pill-${escapeHtml(getMedicineStatus(medicine))}">${escapeHtml(getMedicineStatus(medicine))}</span>
      </div>`).join("");
  }

  const doctorEscalations = document.getElementById("doctor-escalations");
  if (doctorEscalations) {
    const criticalAlerts = state.alerts.filter(alert => alert.type === "CRITICAL_SYMPTOM" || alert.type === "SOS_PANIC");
    doctorEscalations.innerHTML = criticalAlerts.length
      ? criticalAlerts.map(alert => `<div class="med-item skipped"><div><strong>${escapeHtml(alert.title)}</strong><div style="font-size:0.84rem;">${escapeHtml(alert.detail)}</div></div></div>`).join("")
      : `<p style="font-size:0.88rem; color:var(--muted);">No critical AI escalations pending.</p>`;
  }

  const nurseTasks = document.getElementById("nurse-task-list");
  if (nurseTasks) {
    nurseTasks.innerHTML = state.medicines.map(medicine => {
      const status = getMedicineStatus(medicine);
      return `<div class="med-item ${escapeHtml(status)}"><div><strong>${escapeHtml(medicine.name)}</strong> (${escapeHtml(medicine.time)})
        <div style="font-size:0.84rem; color:var(--muted);">Patient: Ramesh Kumar • ${status === "skipped" ? "⚠️ Requires nurse check-in" : "Routine monitoring"}</div></div>
        <span class="status-pill pill-${escapeHtml(status)}">${escapeHtml(status)}</span></div>`;
    }).join("");
  }

  const vitalsLog = document.getElementById("vitals-log");
  if (vitalsLog) {
    vitalsLog.innerHTML = state.vitals.map(vital => `
      <div style="padding:8px; border-bottom:1px solid #e2e8f0;">
        <strong>${escapeHtml(vital.time)}:</strong> BP <strong>${escapeHtml(vital.bp)}</strong> | Sugar <strong>${escapeHtml(vital.sugar)}</strong> <span style="color:var(--muted);">(${escapeHtml(vital.by)})</span>
      </div>`).join("");
  }

  const adminBody = document.getElementById("admin-users-tbody");
  if (adminBody) {
    const count = document.getElementById("admin-user-count");
    if (count) count.textContent = state.users.length;
    adminBody.innerHTML = state.users.map(user => `
      <tr><td><code>${escapeHtml(user.id)}</code></td><td><strong>${escapeHtml(user.name)}</strong></td>
      <td style="text-transform:uppercase;">${escapeHtml(user.role)}</td><td><code>${escapeHtml(user.email)}</code></td>
      <td>${escapeHtml(user.language || "en")}</td></tr>`).join("");
  }

  const volunteerMissions = document.getElementById("volunteer-missions");
  if (volunteerMissions) {
    volunteerMissions.innerHTML = `
      <div class="med-item ${state.sosActive ? "skipped" : "taken"}">
        <div><strong>${state.sosActive ? "🚨 URGENT SOS DISPATCH: Assist Ramesh Kumar (1.2 km away)" : "🟢 Standby: Community First-Responder Network Active"}</strong>
          <div style="font-size:0.86rem; color:var(--muted);">${state.sosActive ? "Patient triggered SOS Panic Button. Coordinate ambulance arrival & bring emergency medical kit." : "Available for pharmacy medicine pickup, elderly check-ins, and emergency ambulance guidance."}</div></div>
        <button class="btn btn-primary btn-sm" onclick="alert('Volunteer Karthik M. accepted dispatch and shared live ETA (4 mins).')">
          ${state.sosActive ? "Accept SOS Dispatch" : "Mark Available"}</button>
      </div>`;
  }
  updateBadges();
}

async function resetDemoState() {
  try {
    await apiRequest("/api/reset", { method: "POST" });
    state.dueMedId = null;
    await syncFromBackend();
  } catch (error) {
    setAppStatus(`Demo data was not reset: ${error.message}`, true);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

window.addEventListener("pageshow", async event => {
  if (!event.persisted || !currentUser) return;
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) forceLogin();
  } catch (error) {
    forceLogin();
  }
});

initializeDashboard();
