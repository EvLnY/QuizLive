// Configuration centralisée avec validation
const CONFIG = Object.freeze({
  API_URL: "https://script.google.com/macros/s/AKfycbzhmLYw_vwrJhQW-15V1gae3DW_or6M7DoceBq49teLytqgy18yc9Q9Bse-ZSApjMsj/exec",
  POLL_INTERVAL: 5000,
  RESET_CHECK_INTERVAL: 8000,
  INACTIVITY_TIMEOUT: 10000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  DEBOUNCE_DELAY: 300,
  TOKEN_KEY: "quiz_user_token",
  USER_TOKEN_KEY: "quizToken",
  RESET_TIMESTAMP_KEY: "lastKnownResetTimestamp"
});

// State management avec proxy pour debugging
const createState = () => {
  const state = {
    lastQuestionId: null,
    currentQuestion: null,
    isFirstLoad: true,
    selectedChoices: new Set(),
    isPollingSuspended: false,
    pollInterval: null,
    resetCheckInterval: null,
    isOnline: navigator.onLine,
    lastActivity: Date.now(),
    animationQueue: []
  };
  
  // Proxy pour debugging en dev
  return new Proxy(state, {
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  });
};

const state = createState();

// Cache optimisé avec compression et TTL
const cache = {
  _compress: (data) => {
    try {
      return btoa(JSON.stringify(data));
    } catch {
      return JSON.stringify(data);
    }
  },
  
  _decompress: (data) => {
    try {
      return JSON.parse(atob(data));
    } catch {
      return JSON.parse(data);
    }
  },
  
  set: (key, value, ttl = 86400000) => {
    const item = {
      value,
      timestamp: Date.now(),
      ttl
    };
    try {
      localStorage.setItem(key, cache._compress(item));
    } catch (e) {
      console.warn('LocalStorage full, cleaning up old entries');
      cache.cleanup();
      localStorage.setItem(key, cache._compress(item));
    }
  },
  
  get: (key) => {
    try {
      const item = cache._decompress(localStorage.getItem(key));
      if (!item) return null;
      
      if (Date.now() - item.timestamp > item.ttl) {
        localStorage.removeItem(key);
        return null;
      }
      return item.value;
    } catch {
      localStorage.removeItem(key);
      return null;
    }
  },
  
  remove: key => localStorage.removeItem(key),
  
  hasAnswered: questionId => !!cache.get(`answered_${questionId}`),
  
  markAnswered: questionId => cache.set(`answered_${questionId}`, true, 86400000),
  
  getChoices: questionId => cache.get(`choices_${questionId}`) || [],
  
  saveChoices: (questionId, choices) => {
    cache.set(`choices_${questionId}`, Array.from(choices), 3600000); // 1h TTL
  },
  
  clearChoices: questionId => cache.remove(`choices_${questionId}`),
  
  cleanup: () => {
    const now = Date.now();
    Object.keys(localStorage).forEach(key => {
      try {
        const item = cache._decompress(localStorage.getItem(key));
        if (item && item.timestamp && now - item.timestamp > item.ttl) {
          localStorage.removeItem(key);
        }
      } catch {
        // Invalid item, remove it
        localStorage.removeItem(key);
      }
    });
  },
  
  resetAllAnswers: () => {
    Object.keys(localStorage)
      .filter(k => k.startsWith("answered_") || k.startsWith("choices_"))
      .forEach(k => localStorage.removeItem(k));
  }
};

// User identification avec fallback
const getUserToken = () => {
  let token = cache.get(CONFIG.USER_TOKEN_KEY);
  if (!token) {
    token = `t_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    cache.set(CONFIG.USER_TOKEN_KEY, token);
  }
  return token;
};

const userToken = getUserToken();

// DOM Elements avec lazy loading
const getElements = (() => {
  let elements = null;
  return () => {
    if (!elements) {
      elements = {
        question: document.getElementById('question'),
        quizForm: document.getElementById('quiz-form'),
        loading: document.getElementById('loading'),
        questionCard: document.getElementById('question-card'),
        toast: document.getElementById('toast')
      };
    }
    return elements;
  };
})();

// Utilities optimisées
const utils = {
  debounce: (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },
  
  throttle: (func, limit) => {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },
  
  retry: async (fn, attempts = CONFIG.RETRY_ATTEMPTS) => {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === attempts - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY * (i + 1)));
      }
    }
  },
  
  queueAnimation: (fn) => {
    state.animationQueue.push(fn);
    if (state.animationQueue.length === 1) {
      utils.processAnimationQueue();
    }
  },
  
  processAnimationQueue: () => {
    if (state.animationQueue.length === 0) return;
    
    const animation = state.animationQueue.shift();
    requestAnimationFrame(() => {
      animation();
      if (state.animationQueue.length > 0) {
        setTimeout(utils.processAnimationQueue, 50);
      }
    });
  }
};

// UI optimisé avec animations en queue
const ui = {
  showLoading: () => {
    const elements = getElements();
    elements.loading.style.display = 'flex';
    elements.quizForm.style.display = 'none';
  },
  
  hideLoading: () => {
    const elements = getElements();
    elements.loading.style.display = 'none';
    elements.quizForm.style.display = 'block';
  },
  
  showToast: (message, duration = 3000) => {
    const elements = getElements();
    elements.toast.textContent = message;
    elements.toast.classList.add('show');
    setTimeout(() => elements.toast.classList.remove('show'), duration);
  },
  
  createRipple: (event, element) => {
    // Éviter les ripples multiples
    if (element.querySelector('.ripple')) return;
    
    utils.queueAnimation(() => {
      const ripple = document.createElement('span');
      ripple.classList.add('ripple');
      element.appendChild(ripple);
      
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      
      setTimeout(() => ripple?.remove(), 600);
    });
  },
  
  shakeElement: utils.throttle((element) => {
    element.classList.add('shake');
    setTimeout(() => element.classList.remove('shake'), 500);
    
    if ('vibrate' in navigator) {
      navigator.vibrate([50, 50, 50]);
    }
  }, 1000),
  
  successVibration: () => {
    if ('vibrate' in navigator) {
      navigator.vibrate(200);
    }
  },
  
  showError: (message) => {
    const elements = getElements();
    elements.question.textContent = "Erreur de connexion";
    elements.loading.style.display = 'none';
    elements.quizForm.innerHTML = `
      <div class="error-state">
        <p>Impossible de se connecter au serveur</p>
        <p class="error-message">${message || 'Veuillez vérifier votre connexion et rafraîchir la page'}</p>
        <button class="submit-btn" onclick="quiz.retry()" style="margin-top: 1rem;">Réessayer</button>
      </div>
    `;
  },
  
  showWaiting: () => {
    const elements = getElements();
    elements.question.textContent = "En attente d'une nouvelle question...";
    elements.loading.style.display = 'none';
    elements.quizForm.innerHTML = `
      <div class="waiting-state">
        <div class="pulse"></div>
        <p>En attente d'une nouvelle question...</p>
      </div>
    `;
  },
  
  showAccessDenied: () => {
    document.body.innerHTML = `
      <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; flex-direction: column; background: #f8fafc; color: #004750; font-family: sans-serif; padding: 1rem; text-align: center;">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#00CE7C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        <h2 style="margin-top: 1rem;">Merci d'avoir participé</h2>
        <p style="margin-top: 0.5rem; color: #6b7280;">Le quiz est maintenant terminé.</p>
      </div>
    `;
  },
  
  showAlreadyAnswered: (question) => {
    const elements = getElements();
    elements.question.innerHTML = `${helpers.stripMultiTag(question)} <span class="answered-tag">Répondu</span>`;
    elements.quizForm.innerHTML = "<p class='message'>Vous avez déjà répondu à cette question.</p>";
  }
};

// Helpers optimisés
const helpers = {
  stripMultiTag: (text) => text?.replace("::multi", "").trim() || "",
  
  toggleChoice: utils.debounce((choiceBtn, isMultiple) => {
    const value = choiceBtn.dataset.value;
    
    if (isMultiple) {
      if (state.selectedChoices.has(value)) {
        state.selectedChoices.delete(value);
        choiceBtn.classList.remove('selected');
      } else {
        state.selectedChoices.add(value);
        choiceBtn.classList.add('selected');
      }
    } else {
      document.querySelectorAll('.choice-btn').forEach(btn => {
        btn.classList.remove('selected');
      });
      state.selectedChoices.clear();
      state.selectedChoices.add(value);
      choiceBtn.classList.add('selected');
    }
    
    // Sauvegarde optimisée
    if (state.currentQuestion?.id) {
      cache.saveChoices(state.currentQuestion.id, state.selectedChoices);
    }
  }, CONFIG.DEBOUNCE_DELAY)
};

// API service avec gestion d'erreurs améliorée
const api = {
  _request: async (url, options = {}) => {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 10000);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: abortController.signal
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Timeout de connexion');
      }
      throw error;
    }
  },
  
  getQuestion: () => utils.retry(() => 
    api._request(`${CONFIG.API_URL}?action=getQuestion&cacheBuster=${Date.now()}`)
  ),
  
  submitAnswer: (questionId, choices, isMultiple) => {
    const formData = new URLSearchParams();
    formData.append("questionId", questionId);
    choices.forEach(choice => formData.append("choice", choice));
    formData.append("userToken", userToken);
    formData.append("isMultiple", isMultiple.toString());
    
    return utils.retry(() => api._request(`${CONFIG.API_URL}?action=submitAnswer`, {
      method: "POST",
      body: formData,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }));
  },
  
  checkResetStatus: () => utils.retry(() =>
    api._request(`${CONFIG.API_URL}?action=checkResetStatus&cacheBuster=${Date.now()}`)
  )
};

// Quiz functionality optimisée
const quiz = {
  renderQuestion: (data, isNewQuestion = false) => {
    if (!data || data.id === "") {
      ui.showWaiting();
      return;
    }
    
    const alreadyAnswered = cache.hasAnswered(data.id);
    
    // Éviter le re-render inutile
    if (state.lastQuestionId === data.id && !isNewQuestion) {
      if (alreadyAnswered && !getElements().quizForm.querySelector('.message')) {
        ui.showAlreadyAnswered(data.question);
      }
      return;
    }
    
    // Sauvegarde de l'état précédent
    if (state.currentQuestion?.id && state.selectedChoices.size > 0) {
      cache.saveChoices(state.currentQuestion.id, state.selectedChoices);
    }
    
    // Mise à jour de l'état
    state.lastQuestionId = data.id;
    state.currentQuestion = data;
    state.selectedChoices.clear();
    
    // Chargement des choix sauvegardés
    const savedChoices = cache.getChoices(data.id);
    savedChoices.forEach(choice => state.selectedChoices.add(choice));
    
    ui.hideLoading();
    
    if (alreadyAnswered) {
      ui.showAlreadyAnswered(data.question);
      return;
    }
    
    quiz._buildQuestionForm(data, isNewQuestion);
  },
  
  _buildQuestionForm: (data, isNewQuestion) => {
    const elements = getElements();
    const isMultiple = data.question.includes("::multi");
    
    elements.question.textContent = helpers.stripMultiTag(data.question);
    
    if (isNewQuestion) {
      ui.shakeElement(elements.questionCard);
      if ('vibrate' in navigator) {
        navigator.vibrate(100);
      }
    }
    
    // Construction optimisée du formulaire
    const fragment = document.createDocumentFragment();
    
    data.choices.forEach((choice, i) => {
      const div = document.createElement("div");
      div.className = "choice-container";
      
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `choice-btn ${state.selectedChoices.has(choice) ? 'selected' : ''}`;
      btn.dataset.value = choice;
      
      btn.innerHTML = `
        <div class="choice-icon ${isMultiple ? 'choice-checkbox' : 'choice-radio'}"></div>
        <span class="choice-text">${choice}</span>
      `;
      
      btn.addEventListener('click', (e) => {
        state.lastActivity = Date.now();
        helpers.toggleChoice(btn, isMultiple);
        ui.createRipple(e, btn);
      }, { passive: false });
      
      if (state.isFirstLoad || isNewQuestion) {
        btn.style.opacity = "0";
        btn.style.transform = "translateX(20px)";
        btn.style.transition = "all 0.3s ease";
        
        utils.queueAnimation(() => {
          setTimeout(() => {
            btn.style.opacity = "1";
            btn.style.transform = "translateX(0)";
          }, 100 + (i * 80));
        });
      }
      
      div.appendChild(btn);
      fragment.appendChild(div);
    });
    
    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "submit-btn";
    submitBtn.textContent = isMultiple ? "Envoyer mes réponses" : "Envoyer ma réponse";
    submitBtn.addEventListener('click', ui.createRipple);
    
    if (state.isFirstLoad || isNewQuestion) {
      submitBtn.style.opacity = "0";
      utils.queueAnimation(() => {
        setTimeout(() => {
          submitBtn.style.opacity = "1";
          submitBtn.style.transition = "opacity 0.3s ease";
        }, 100 + (data.choices.length * 80));
      });
    }
    
    fragment.appendChild(submitBtn);
    elements.quizForm.innerHTML = "";
    elements.quizForm.appendChild(fragment);
    
    state.isFirstLoad = false;
  },
  
  pollQuestion: async () => {
    if (!state.isOnline || state.isPollingSuspended) return;
    
    try {
      const data = await api.getQuestion();
      const isNewQuestion = data && data.id !== state.lastQuestionId;
      quiz.renderQuestion(data, isNewQuestion);
    } catch (error) {
      console.error("Polling error:", error);
      if (state.isOnline) {
        ui.showError(error.message);
      }
    }
  },
  
  checkForReset: async () => {
    if (!state.isOnline) return true;
    
    try {
      const data = await api.checkResetStatus();
      const resetTimestamp = data?.resetTimestamp || "0";
      const validToken = data?.accessToken || "";
      const storedTimestamp = cache.get(CONFIG.RESET_TIMESTAMP_KEY) || "0";
      const urlToken = new URLSearchParams(window.location.search).get("token");
      
      if (!urlToken || !validToken || urlToken !== validToken) {
        ui.showAccessDenied();
        return false;
      }
      
      if (resetTimestamp !== storedTimestamp) {
        cache.set(CONFIG.RESET_TIMESTAMP_KEY, resetTimestamp);
        cache.resetAllAnswers();
        ui.showToast("Quiz réinitialisé par l'administrateur !");
        await quiz.pollQuestion();
      }
      
      return true;
    } catch (error) {
      console.error("Reset check error:", error);
      return false;
    }
  },
  
  startPolling: () => {
    quiz.stopPolling();
    state.pollInterval = setInterval(quiz.pollQuestion, CONFIG.POLL_INTERVAL);
    state.resetCheckInterval = setInterval(quiz.checkForReset, CONFIG.RESET_CHECK_INTERVAL);
  },
  
  stopPolling: () => {
    clearInterval(state.pollInterval);
    clearInterval(state.resetCheckInterval);
    state.pollInterval = null;
    state.resetCheckInterval = null;
  },
  
  retry: async () => {
    ui.showLoading();
    await quiz.pollQuestion();
  },
  
  setupEventListeners: () => {
    const elements = getElements();
    
    // Gestion du formulaire avec debounce
    elements.quizForm.addEventListener("submit", utils.debounce(async (e) => {
      e.preventDefault();
      if (!state.currentQuestion) return;
      
      const submitBtn = e.target.querySelector("button[type='submit']");
      if (submitBtn?.disabled) return;
      
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Envoi en cours...";
        submitBtn.style.opacity = "0.7";
      }
      
      const isMultiple = state.currentQuestion.question.includes("::multi");
      const selected = Array.from(state.selectedChoices);
      
      if (selected.length === 0) {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = isMultiple ? "Envoyer mes réponses" : "Envoyer ma réponse";
          submitBtn.style.opacity = "1";
        }
        ui.shakeElement(elements.questionCard);
        return;
      }
      
      try {
        await api.submitAnswer(state.currentQuestion.id, selected, isMultiple);
        
        cache.markAnswered(state.currentQuestion.id);
        cache.clearChoices(state.currentQuestion.id);
        
        elements.quizForm.innerHTML = "<p class='message'>Réponse envoyée avec succès !</p>";
        elements.question.innerHTML = `${helpers.stripMultiTag(state.currentQuestion.question)} <span class="answered-tag">Répondu</span>`;
        
        ui.successVibration();
      } catch (err) {
        console.error("Submit error:", err);
        elements.quizForm.innerHTML = `
          <div class="error-state">
            <p class="error-message">Erreur lors de l'envoi: ${err.message}</p>
            <button class="submit-btn" onclick="quiz.retry()">Réessayer</button>
          </div>`;
      }
    }, CONFIG.DEBOUNCE_DELAY));
    
    // Optimisation pour mobile avec gestion de l'inactivité
    let inactivityTimer;
    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      state.lastActivity = Date.now();
      
      if (state.isPollingSuspended) {
        state.isPollingSuspended = false;
        quiz.startPolling();
      }
      
      inactivityTimer = setTimeout(() => {
        state.isPollingSuspended = true;
        quiz.stopPolling();
      }, CONFIG.INACTIVITY_TIMEOUT);
    };
    
    ['touchstart', 'mousedown', 'keydown', 'scroll'].forEach(event => {
      document.addEventListener(event, resetInactivityTimer, { passive: true });
    });
    
    // Gestion de l'état en ligne/hors ligne
    window.addEventListener('online', () => {
      state.isOnline = true;
      ui.showToast("Connexion rétablie");
      quiz.startPolling();
    });
    
    window.addEventListener('offline', () => {
      state.isOnline = false;
      quiz.stopPolling();
      ui.showToast("Connexion perdue - Mode hors ligne");
    });
    
    // Gestion de la visibilité de la page
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        quiz.stopPolling();
      } else {
        setTimeout(() => {
          quiz.pollQuestion();
          quiz.startPolling();
        }, 1000);
      }
    });
    
    resetInactivityTimer();
  },
  
  init: async () => {
    try {
      cache.cleanup();
      
      const urlToken = new URLSearchParams(window.location.search).get("token");
      if (urlToken) {
        sessionStorage.setItem(CONFIG.TOKEN_KEY, urlToken);
      }
      
      const statusData = await api.checkResetStatus();
      const validToken = statusData?.accessToken || "";
      const resetTimestamp = statusData?.resetTimestamp || "0";
      const storedTimestamp = cache.get(CONFIG.RESET_TIMESTAMP_KEY) || "0";
      
      if (!urlToken || urlToken !== validToken) {
        ui.showAccessDenied();
        return;
      }
      
      ui.showLoading();
      getElements().questionCard.classList.add('show');
      
      if (resetTimestamp !== storedTimestamp) {
        cache.set(CONFIG.RESET_TIMESTAMP_KEY, resetTimestamp);
        cache.resetAllAnswers();
        ui.showToast("Quiz initialisé !");
      }
      
      await quiz.pollQuestion();
      quiz.setupEventListeners();
      quiz.startPolling();
      
    } catch (err) {
      console.error("Initialization error:", err);
      ui.showError(err.message);
    }
  }
};

// Initialisation avec support des modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { quiz, CONFIG, state };
} else {
  document.addEventListener('DOMContentLoaded', quiz.init);
}