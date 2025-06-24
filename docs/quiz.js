// ✅ Ultra-optimized version of quiz.js — same behavior, much lighter

const CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbzhmLYw_vwrJhQW-15V1gae3DW_or6M7DoceBq49teLytqgy18yc9Q9Bse-ZSApjMsj/exec",
  POLL_INTERVAL: 5000,
  RESET_KEY: "lastKnownResetTimestamp",
  TOKEN_KEY: "quizToken"
};

const el = id => document.getElementById(id);
const ui = {
  question: el("question"),
  form: el("quiz-form"),
  loading: el("loading"),
  toast: el("toast"),

  showLoading() {
    this.loading.style.display = 'flex';
    this.form.style.display = 'none';
  },
  hideLoading() {
    this.loading.style.display = 'none';
    this.form.style.display = 'block';
  },
  showToast(msg) {
    this.toast.textContent = msg;
    this.toast.classList.add("visible");
    setTimeout(() => this.toast.classList.remove("visible"), 2000);
  },
  render(q, selected, onChange) {
    this.question.textContent = q.question;
    this.form.innerHTML = '';
    q.choices.forEach((c, i) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = q.multiple ? "checkbox" : "radio";
      input.name = "choice";
      input.value = i;
      input.checked = selected.has(i);
      input.addEventListener("change", onChange);
      label.append(input, c);
      this.form.appendChild(label);
    });
  }
};

const cache = {
  get: k => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: k => localStorage.removeItem(k),

  userToken() {
    let t = this.get(CONFIG.TOKEN_KEY);
    if (!t) {
      t = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      this.set(CONFIG.TOKEN_KEY, t);
    }
    return t;
  },

  saveChoices(id, choices) {
    this.set(`c_${id}`, JSON.stringify([...choices]));
    this.set(`t_${id}`, Date.now());
  },
  loadChoices(id) {
    try {
      const raw = this.get(`c_${id}`);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  },
  resetAll() {
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith("c_") || k.startsWith("t_")) this.remove(k);
    });
  },
  cleanOld(threshold = 86400000) {
    const now = Date.now();
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith("t_")) {
        const ts = parseInt(this.get(k), 10);
        if (now - ts > threshold) {
          const cid = k.replace("t_", "c_");
          this.remove(k);
          this.remove(cid);
        }
      }
    });
  }
};

const state = {
  lastId: null,
  current: null,
  choices: new Set(),
  paused: false
};

function onChoiceChange() {
  const inputs = ui.form.querySelectorAll("input[name='choice']");
  state.choices = new Set([...inputs].filter(i => i.checked).map(i => +i.value));
  cache.saveChoices(state.current.id, state.choices);
}

async function fetchQuestion() {
  if (state.paused) return;
  try {
    const res = await fetch(`${CONFIG.API_URL}?action=question&token=${cache.userToken()}`);
    const data = await res.json();
    if (data.success && data.question?.id !== state.lastId) {
      const q = data.question;
      state.lastId = q.id;
      state.current = q;
      state.choices = cache.loadChoices(q.id);
      ui.render(q, state.choices, onChoiceChange);
      ui.hideLoading();
    }
  } catch (e) {
    console.error("Question fetch failed", e);
  }
}

async function checkReset() {
  try {
    const res = await fetch(`${CONFIG.API_URL}?action=resetCheck`);
    const data = await res.json();
    if (data.timestamp && data.timestamp !== cache.get(CONFIG.RESET_KEY)) {
      cache.set(CONFIG.RESET_KEY, data.timestamp);
      cache.resetAll();
      location.reload();
    }
  } catch (e) {
    console.error("Reset check failed", e);
  }
}

function init() {
  ui.showLoading();
  cache.cleanOld();
  fetchQuestion();
  setInterval(fetchQuestion, CONFIG.POLL_INTERVAL);
  setInterval(checkReset, CONFIG.POLL_INTERVAL * 1.5);
}

document.addEventListener("DOMContentLoaded", init);
