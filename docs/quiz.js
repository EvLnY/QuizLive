// Configuration optimisée avec backoff exponentiel
const CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbzhmLYw_vwrJhQW-15V1gae3DW_or6M7DoceBq49teLytqgy18yc9Q9Bse-ZSApjMsj/exec",
  POLL_INTERVAL: 5000,
  POLL_INTERVAL_MAX: 30000, // Backoff maximum
  RESET_CHECK_INTERVAL: 15000, // Réduit car moins critique
  INACTIVITY_TIMEOUT: 10000,
  TOKEN_KEY: "quiz_user_token",
  USER_TOKEN_KEY: "quizToken",
  RESET_TIMESTAMP_KEY: "lastKnownResetTimestamp",
  CACHE_TTL: 60000, // TTL pour le cache des questions
  MAX_RETRY_ATTEMPTS: 3
};

// State management consolidé
const state = {
  lastQuestionId: null,
  currentQuestion: null,
  isFirstLoad: true,
  selectedChoices: new Set(),
  isPollingSuspended: false,
  pollInterval: null,
  resetCheckInterval: null,
  currentPollInterval: CONFIG.POLL_INTERVAL,
  retryCount: 0,
  lastSuccessfulPoll: Date.now(),
  isOnline: navigator.onLine,
  hasValidToken: false
};

// DOM Elements avec mise en cache
const elements = (() => {
  const cache = {};
  return {
    get: (id) => cache[id] || (cache[id] = document.getElementById(id)),
    question: document.getElementById('question'),
    quizForm: document.getElementById('quiz-form'),
    loading: document.getElementById('loading'),
    questionCard: document.getElementById('question-card'),
    toast: document.getElementById('toast')
  };
})();

// Cache utility optimisé avec compression et TTL
const cache = {
  // Compression simple pour économiser l'espace
  compress: (data) => JSON.stringify(data),
  decompress: (data) => {
    try { return JSON.parse(data); } 
    catch { return null; }
  },
  
  set: (key, value, ttl = null) => {
    const item = {
      value,
      timestamp: Date.now(),
      ttl: ttl || CONFIG.CACHE_TTL
    };
    localStorage.setItem(key, JSON.stringify(item));
  },
  
  get: (key) => {
    try {
      const item = JSON.parse(localStorage.getItem(key));
      if (!item) return null;
      
      if (item.ttl && Date.now() - item.timestamp > item.ttl) {
        localStorage.removeItem(key);
        return null;
      }
      
      return item.value || item; // Support ancien format
    } catch {
      return localStorage.getItem(key); // Fallback ancien format
    }
  },
  
  remove: key => localStorage.removeItem(key),
  
  hasAnswered: questionId => !!cache.get(`answered_${questionId}`),
  markAnswered: questionId => cache.set(`answered_${questionId}`, "1"),
  
  getChoices: questionId => {
    const savedChoices = cache.get(`choices_${questionId}`);
    return Array.isArray(savedChoices) ? savedChoices : [];
  },
  
  saveChoices: (questionId, choices) => {
    cache.set(`choices_${questionId}`, Array.from(choices));
  },
  
  clearChoices: questionId => {
    cache.remove(`choices_${questionId}`);
  },
  
  // Nettoyage optimisé par batch
  cleanupOldChoices: () => {
    const now = Date.now();
    const keysToRemove = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('choices_') || key?.startsWith('answered_')) {
        try {
          const item = JSON.parse(localStorage.getItem(key));
          if (item?.timestamp && now - item.timestamp > 86400000) {
            keysToRemove.push(key);
          }
        } catch {
          // Ancien format, garder pour compatibilité
        }
      }
    }
    
    keysToRemove.forEach(key => localStorage.removeItem(key));
  },
  
  resetAllAnswers: () => {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("answered_") || key?.startsWith("choices_")) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  }
};

// User identification optimisé
const userToken = (() => {
  let token = localStorage.getItem(CONFIG.USER_TOKEN_KEY);
  if (!token) {
    token = 't_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    localStorage.setItem(CONFIG.USER_TOKEN_KEY, token);
  }
  return token;
})();

// UI Utilities avec debouncing
const ui = (() => {
  let toastTimeout;
  
  return {
    showLoading: () => {
      elements.loading.style.display = 'flex';
      elements.quizForm.style.display = 'none';
    },
    
    hideLoading: () => {
      elements.loading.style.display = 'none';
      elements.quizForm.style.display = 'block';
    },
    
    showToast: (message, duration = 3000) => {
      clearTimeout(toastTimeout);
      elements.toast.textContent = message;
      elements.toast.classList.add('show');
      toastTimeout = setTimeout(() => elements.toast.classList.remove('show'), duration);
    },
    
    // Pool de ripples pour éviter les créations/destructions
    ripplePool: [],
    createRipple: (event, element) => {
      let ripple = ui.ripplePool.pop() || document.createElement('span');
      ripple.className = 'ripple';
      element.appendChild(ripple);
      
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      
      setTimeout(() => {
        if (ripple.parentElement) {
          ripple.parentElement.removeChild(ripple);
        }
        ui.ripplePool.push(ripple);
      }, 600);
    },
    
    shakeElement: (element) => {
      if (element.classList.contains('shake')) return;
      element.classList.add('shake');
      setTimeout(() => element.classList.remove('shake'), 500);
      
      if ('vibrate' in navigator) {
        navigator.vibrate([50, 50, 50]);
      }
    },
    
    successVibration: () => {
      if ('vibrate' in navigator) {
        navigator.vibrate(200);
      }
    },
    
    // Templates pour éviter la reconstruction HTML
    templates: {
      errorState: (message) => `
        <div class="error-state">
          <p>Impossible de se connecter au serveur</p>
          <p class="error-message">${message || 'Veuillez vérifier votre connexion et rafraîchir la page'}</p>
        </div>
      `,
      waitingState: () => `
        <div class="waiting-state">
          <div class="pulse"></div>
          <p>En attente d'une nouvelle question...</p>
        </div>
      `,
      connectionError: () => `
        <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; flex-direction: column; background: #f8fafc; color: #004750; font-family: sans-serif; padding: 1rem; text-align: center;">
          <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <h2 style="margin-top: 1rem;">Erreur de connexion au quiz</h2>
          <p style="margin-top: 0.5rem; color: #6b7280;">Veuillez rafraîchir la page ou réessayer plus tard.</p>
          <button style="margin-top: 1rem; padding: 0.75rem 1.5rem; background: #00CE7C; color: white; border: none; border-radius: 8px; font-weight: 600;" onclick="window.location.reload()">Rafraîchir</button>
        </div>
      `
    },
    
    showError: (message) => {
      elements.question.textContent = "Erreur de connexion";
      elements.loading.style.display = 'none';
      elements.quizForm.innerHTML = ui.templates.errorState(message);
    },
    
    showWaiting: () => {
      elements.question.textContent = "En attente d'une nouvelle question...";
      elements.loading.style.display = 'none';
      elements.quizForm.innerHTML = ui.templates.waitingState();
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
    
    showConnectionError: () => {
      document.body.innerHTML = ui.templates.connectionError();
    },
    
    showAlreadyAnswered: (question) => {
      elements.question.innerHTML = `${helpers.stripMultiTag(question)} <span class="answered-tag">Répondu</span>`;
      elements.quizForm.innerHTML = "<p class='message'>Vous avez déjà répondu à cette question.</p>";
    }
  };
})();

// Helper functions optimisées
const helpers = {
  stripMultiTag: (text) => text?.replace("::multi", "").trim() || "",
  
  // Debounced toggle pour éviter les clicks multiples
  toggleChoice: (() => {
    let timeout;
    return (choiceBtn, isMultiple) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
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
          document.querySelectorAll('.choice-btn.selected').forEach(btn => {
            btn.classList.remove('selected');
          });
          state.selectedChoices.clear();
          state.selectedChoices.add(value);
          choiceBtn.classList.add('selected');
        }
        
        cache.saveChoices(state.currentQuestion.id, state.selectedChoices);
      }, 50);
    };
  })(),
  
  // Backoff exponentiel pour les erreurs
  calculateBackoff: (retryCount) => {
    return Math.min(CONFIG.POLL_INTERVAL * Math.pow(2, retryCount), CONFIG.POLL_INTERVAL_MAX);
  }
};

// API service avec retry et circuit breaker
const api = (() => {
  let circuitBreakerOpen = false;
  let lastFailureTime = 0;
  const CIRCUIT_BREAKER_TIMEOUT = 60000; // 1 minute
  
  const shouldSkipRequest = () => {
    if (!circuitBreakerOpen) return false;
    if (Date.now() - lastFailureTime > CIRCUIT_BREAKER_TIMEOUT) {
      circuitBreakerOpen = false;
      return false;
    }
    return true;
  };
  
  const handleFailure = () => {
    circuitBreakerOpen = true;
    lastFailureTime = Date.now();
    state.retryCount++;
  };
  
  const handleSuccess = () => {
    circuitBreakerOpen = false;
    state.retryCount = 0;
    state.currentPollInterval = CONFIG.POLL_INTERVAL;
    state.lastSuccessfulPoll = Date.now();
  };
  
  return {
    getQuestion: async () => {
      if (shouldSkipRequest()) {
        throw new Error('Circuit breaker open');
      }
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(`${CONFIG.API_URL}?action=getQuestion&cacheBuster=${Date.now()}`, {
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        handleSuccess();
        return data;
      } catch (error) {
        handleFailure();
        throw error;
      }
    },
    
    submitAnswer: async (questionId, choices, isMultiple) => {
      try {
        const formData = new URLSearchParams();
        formData.append("questionId", questionId);
        choices.forEach(choice => formData.append("choice", choice));
        formData.append("userToken", userToken);
        formData.append("isMultiple", isMultiple.toString());
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        
        const response = await fetch(`${CONFIG.API_URL}?action=submitAnswer`, {
          method: "POST",
          body: formData,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return true;
      } catch (error) {
        console.error("Error submitting answer:", error);
        throw error;
      }
    },
    
    // Cache pour éviter les appels répétés
    resetStatusCache: { data: null, timestamp: 0 },
    checkResetStatus: async () => {
      const now = Date.now();
      if (api.resetStatusCache.data && now - api.resetStatusCache.timestamp < 30000) {
        return api.resetStatusCache.data;
      }
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const response = await fetch(`${CONFIG.API_URL}?action=checkResetStatus&cacheBuster=${now}`, {
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        api.resetStatusCache = { data, timestamp: now };
        return data;
      } catch (error) {
        console.error("Error checking reset status:", error);
        throw error;
      }
    }
  };
})();

// Quiz functionality optimisé
const quiz = {
  // Pool d'éléments DOM pour éviter les re-créations
  choiceElementPool: [],
  
  renderQuestion: (data, isNewQuestion = false) => {
    if (!data || data.id === "") {
      ui.showWaiting();
      return;
    }
    
    const alreadyAnswered = cache.hasAnswered(data.id);
    
    // Éviter les re-renders inutiles
    if (state.lastQuestionId === data.id && !isNewQuestion) {
      return;
    }
    
    // Save current state
    if (state.currentQuestion && state.selectedChoices.size > 0) {
      cache.saveChoices(state.currentQuestion.id, state.selectedChoices);
    }
    
    // Update state
    state.lastQuestionId = data.id;
    state.currentQuestion = data;
    state.selectedChoices.clear();
    
    // Load saved choices
    const savedChoices = cache.getChoices(data.id);
    savedChoices.forEach(choice => state.selectedChoices.add(choice));
    
    ui.hideLoading();
    
    if (alreadyAnswered) {
      ui.showAlreadyAnswered(data.question);
      return;
    }
    
    const isMultiple = data.question.includes("::multi");
    elements.question.textContent = helpers.stripMultiTag(data.question);
    
    if (isNewQuestion) {
      ui.shakeElement(elements.questionCard);
      if ('vibrate' in navigator) {
        navigator.vibrate(100);
      }
    }
    
    // Fragment pour une seule manipulation DOM
    const fragment = document.createDocumentFragment();
    
    data.choices.forEach((choice, i) => {
      const div = quiz.choiceElementPool.pop() || document.createElement("div");
      div.className = "choice-container";
      div.innerHTML = ""; // Reset content
      
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.dataset.value = choice;
      
      if (state.selectedChoices.has(choice)) {
        btn.classList.add('selected');
      }
      
      btn.innerHTML = `
        <div class="choice-icon ${isMultiple ? 'choice-checkbox' : 'choice-radio'}"></div>
        <span class="choice-text">${choice}</span>
      `;
      
      // Event delegation plus efficace
      btn.addEventListener('click', (e) => {
        helpers.toggleChoice(btn, isMultiple);
        ui.createRipple(e, btn);
      }, { passive: true });
      
      if (isNewQuestion) {
        btn.style.opacity = "0";
        btn.style.transform = "translateX(20px)";
        setTimeout(() => {
          btn.style.opacity = "1";
          btn.style.transform = "translateX(0)";
          btn.style.transition = "all 0.3s ease";
        }, 100 + (i * 80));
      }
      
      div.appendChild(btn);
      fragment.appendChild(div);
    });
    
    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "submit-btn";
    submitBtn.textContent = isMultiple ? "Envoyer mes réponses" : "Envoyer ma réponse";
    
    fragment.appendChild(submitBtn);
    
    // Une seule manipulation DOM
    elements.quizForm.innerHTML = "";
    elements.quizForm.appendChild(fragment);
    
    if (isNewQuestion) {
      setTimeout(() => {
        submitBtn.style.opacity = "1";
        submitBtn.style.transition = "opacity 0.3s ease";
      }, 100 + (data.choices.length * 80));
    }
    
    state.isFirstLoad = false;
  },
  
  pollQuestion: async () => {
    if (!state.isOnline) return;
    
    try {
      const data = await api.getQuestion();
      const isNewQuestion = data && data.id !== state.lastQuestionId;
      quiz.renderQuestion(data, isNewQuestion);
      
      // Reset polling interval on success
      if (state.currentPollInterval !== CONFIG.POLL_INTERVAL) {
        state.currentPollInterval = CONFIG.POLL_INTERVAL;
        quiz.restartPolling();
      }
    } catch (error) {
      console.error("Polling error:", error);
      
      // Backoff exponentiel
      state.currentPollInterval = helpers.calculateBackoff(state.retryCount);
      
      // Afficher erreur seulement après plusieurs échecs
      if (state.retryCount > 2) {
        ui.showError("Connexion instable");
      }
      
      quiz.restartPolling();
    }
  },
  
  checkForReset: async () => {
    if (!state.isOnline || !state.hasValidToken) return true;
    
    try {
      const data = await api.checkResetStatus();
      const resetTimestamp = data?.resetTimestamp || "0";
      const validToken = data?.accessToken || "";
      const storedTimestamp = cache.get(CONFIG.RESET_TIMESTAMP_KEY) || "0";
      const urlToken = new URLSearchParams(window.location.search).get("token");
      
      if (!urlToken || !validToken || urlToken !== validToken) {
        state.hasValidToken = false;
        ui.showAccessDenied();
        return false;
      }
      
      state.hasValidToken = true;
      
      if (resetTimestamp !== storedTimestamp) {
        cache.set(CONFIG.RESET_TIMESTAMP_KEY, resetTimestamp);
        cache.resetAllAnswers();
        ui.showToast("Quiz réinitialisé par l'administrateur !");
        await quiz.pollQuestion();
      }
      
      return true;
    } catch (error) {
      console.error("Error checking reset token:", error);
      return false;
    }
  },
  
  restartPolling: () => {
    quiz.stopPolling();
    state.pollInterval = setTimeout(() => {
      quiz.pollQuestion();
      state.pollInterval = setInterval(quiz.pollQuestion, state.currentPollInterval);
    }, state.currentPollInterval);
  },
  
  startPolling: () => {
    state.pollInterval = setInterval(quiz.pollQuestion, CONFIG.POLL_INTERVAL);
    state.resetCheckInterval = setInterval(quiz.checkForReset, CONFIG.RESET_CHECK_INTERVAL);
  },
  
  stopPolling: () => {
    clearInterval(state.pollInterval);
    clearTimeout(state.pollInterval);
    clearInterval(state.resetCheckInterval);
  },
  
  setupEventListeners: () => {
    // Event delegation sur le form
    elements.quizForm.addEventListener("submit", async (e) => {
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
        console.error("Error submitting answer:", err);
        elements.quizForm.innerHTML = `
          <div class="error-state">
            <p class="error-message">Erreur lors de l'envoi. Veuillez réessayer.</p>
            <button class="submit-btn" onclick="window.location.reload()">Réessayer</button>
          </div>`;
      }
    });
    
    // Optimisation des événements tactiles
    let touchTimeout;
    document.addEventListener('touchstart', () => {
      clearTimeout(touchTimeout);
      if (!state.isPollingSuspended) {
        state.isPollingSuspended = true;
        quiz.stopPolling();
      }
      
      touchTimeout = setTimeout(() => {
        state.isPollingSuspended = false;
        quiz.pollQuestion();
        quiz.startPolling();
      }, CONFIG.INACTIVITY_TIMEOUT);
    }, { passive: true });
    
    // Network status monitoring
    window.addEventListener('online', () => {
      state.isOnline = true;
      ui.showToast("Connexion rétablie");
      quiz.pollQuestion();
      if (!state.pollInterval) quiz.startPolling();
    });
    
    window.addEventListener('offline', () => {
      state.isOnline = false;
      ui.showToast("Connexion perdue");
      quiz.stopPolling();
    });
    
    // Page visibility API pour économiser les ressources
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        quiz.stopPolling();
      } else if (state.isOnline && state.hasValidToken) {
        quiz.pollQuestion();
        quiz.startPolling();
      }
    });
  },
  
  init: async () => {
    // Cleanup initial optimisé
    requestIdleCallback ? 
      requestIdleCallback(cache.cleanupOldChoices) : 
      setTimeout(cache.cleanupOldChoices, 1000);
    
    const urlToken = new URLSearchParams(window.location.search).get("token");
    if (urlToken) {
      sessionStorage.setItem(CONFIG.TOKEN_KEY, urlToken);
    }
    
    try {
      const statusData = await api.checkResetStatus();
      const validToken = statusData?.accessToken || "";
      const resetTimestamp = statusData?.resetTimestamp || "0";
      const storedTimestamp = cache.get(CONFIG.RESET_TIMESTAMP_KEY) || "0";
      
      if (!urlToken || urlToken !== validToken) {
        ui.showAccessDenied();
        return;
      }
      
      state.hasValidToken = true;
      ui.showLoading();
      elements.questionCard.classList.add('show');
      
      if (resetTimestamp !== storedTimestamp) {
        cache.set(CONFIG.RESET_TIMESTAMP_KEY, resetTimestamp);
        cache.resetAllAnswers();
        ui.showToast("Quiz initialisé !");
      }
      
      await quiz.pollQuestion();
      quiz.setupEventListeners();
      quiz.startPolling();
    } catch (err) {
      console.error("Token validation error:", err);
      ui.showConnectionError();
    }
  }
};

// Initialize with better error handling
document.addEventListener('DOMContentLoaded', () => {
  try {
    quiz.init();
  } catch (error) {
    console.error('Initialization error:', error);
    ui.showConnectionError();
  }
});