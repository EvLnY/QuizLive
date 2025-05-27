// Configuration
const CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbzhmLYw_vwrJhQW-15V1gae3DW_or6M7DoceBq49teLytqgy18yc9Q9Bse-ZSApjMsj/exec",
  POLL_INTERVAL: 5000,
  RESET_CHECK_INTERVAL: 8000,
  INACTIVITY_TIMEOUT: 10000,
  TOKEN_KEY: "quiz_user_token",
  USER_TOKEN_KEY: "quizToken",
  RESET_TIMESTAMP_KEY: "lastKnownResetTimestamp"
};

// State management
const state = {
  lastQuestionId: null,
  currentQuestion: null,
  isFirstLoad: true,
  selectedChoices: new Set(),
  isPollingSuspended: false,
  pollInterval: null,
  resetCheckInterval: null
};

// DOM Elements
const elements = {
  question: document.getElementById('question'),
  quizForm: document.getElementById('quiz-form'),
  loading: document.getElementById('loading'),
  questionCard: document.getElementById('question-card'),
  toast: document.getElementById('toast')
};

// Cache utility
const cache = {
  set: (key, value) => localStorage.setItem(key, value),
  get: key => localStorage.getItem(key),
  remove: key => localStorage.removeItem(key),
  hasAnswered: questionId => !!localStorage.getItem(`answered_${questionId}`),
  markAnswered: questionId => localStorage.setItem(`answered_${questionId}`, "1"),
  getChoices: questionId => {
    try {
      const savedChoices = localStorage.getItem(`choices_${questionId}`);
      return savedChoices ? JSON.parse(savedChoices) : [];
    } catch (e) {
      console.error("Error retrieving saved choices", e);
      return [];
    }
  },
  saveChoices: (questionId, choices) => {
    localStorage.setItem(`choices_${questionId}`, JSON.stringify(Array.from(choices)));
    localStorage.setItem(`choices_${questionId}_timestamp`, Date.now().toString());
  },
  clearChoices: questionId => {
    localStorage.removeItem(`choices_${questionId}`);
    localStorage.removeItem(`choices_${questionId}_timestamp`);
  },
  cleanupOldChoices: () => {
    const now = Date.now();
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('choices_') && !key.endsWith('_timestamp')) {
        const timestamp = localStorage.getItem(`${key}_timestamp`);
        if (timestamp && now - parseInt(timestamp) > 86400000) { // 24 hours
          localStorage.removeItem(key);
          localStorage.removeItem(`${key}_timestamp`);
        }
      }
    });
  },
  resetAllAnswers: () => {
    Object.keys(localStorage)
      .filter(k => k.startsWith("answered_"))
      .forEach(k => localStorage.removeItem(k));
    Object.keys(localStorage)
      .filter(k => k.startsWith("choices_"))
      .forEach(k => localStorage.removeItem(k));
  }
};

// User identification
if (!localStorage.getItem(CONFIG.USER_TOKEN_KEY)) {
  localStorage.setItem(
    CONFIG.USER_TOKEN_KEY, 
    't_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
  );
}
const userToken = localStorage.getItem(CONFIG.USER_TOKEN_KEY);

// UI Utilities
const ui = {
  showLoading: () => {
    elements.loading.style.display = 'flex';
    elements.quizForm.style.display = 'none';
  },
  
  hideLoading: () => {
    elements.loading.style.display = 'none';
    elements.quizForm.style.display = 'block';
  },
  
  showToast: (message, duration = 3000) => {
    elements.toast.textContent = message;
    elements.toast.classList.add('show');
    setTimeout(() => elements.toast.classList.remove('show'), duration);
  },
  
  createRipple: (event, element) => {
    const ripple = document.createElement('span');
    ripple.classList.add('ripple');
    element.appendChild(ripple);
    
    const rect = element.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    
    setTimeout(() => ripple.remove(), 600);
  },
  
  shakeElement: (element) => {
    element.classList.add('shake');
    setTimeout(() => element.classList.remove('shake'), 500);
    
    // Vibration on mobile if supported
    if ('vibrate' in navigator) {
      navigator.vibrate([50, 50, 50]);
    }
  },
  
  successVibration: () => {
    if ('vibrate' in navigator) {
      navigator.vibrate(200);
    }
  },
  
  showError: (message) => {
    elements.question.textContent = "Erreur de connexion";
    elements.loading.style.display = 'none';
    elements.quizForm.innerHTML = `
      <div class="error-state">
        <p>Impossible de se connecter au serveur</p>
        <p class="error-message">${message || 'Veuillez vérifier votre connexion et rafraîchir la page'}</p>
      </div>
    `;
  },
  
  showWaiting: () => {
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
  
  showConnectionError: () => {
    document.body.innerHTML = `
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
    `;
  },
  
  showAlreadyAnswered: (question) => {
    elements.question.innerHTML = `${helpers.stripMultiTag(question)} <span class="answered-tag">Répondu</span>`;
    elements.quizForm.innerHTML = "<p class='message'>Vous avez déjà répondu à cette question.</p>";
  }
};

// Helper functions
const helpers = {
  stripMultiTag: (text) => text.replace("::multi", "").trim(),
  
  toggleChoice: (choiceBtn, isMultiple) => {
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
      // For single choice questions, deselect all others
      document.querySelectorAll('.choice-btn').forEach(btn => {
        btn.classList.remove('selected');
      });
      state.selectedChoices.clear();
      state.selectedChoices.add(value);
      choiceBtn.classList.add('selected');
    }
    
    // Save choices immediately after each click
    cache.saveChoices(state.currentQuestion.id, state.selectedChoices);
  }
};

// API service
const api = {
  getQuestion: async () => {
    try {
      const response = await fetch(`${CONFIG.API_URL}?action=getQuestion&cacheBuster=${Date.now()}`);
      if (!response.ok) throw new Error('Network response was not ok');
      return await response.json();
    } catch (error) {
      console.error("Error fetching question:", error);
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
      
      const response = await fetch(`${CONFIG.API_URL}?action=submitAnswer`, {
        method: "POST",
        body: formData,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      
      if (!response.ok) throw new Error('Network response was not ok');
      return true;
    } catch (error) {
      console.error("Error submitting answer:", error);
      throw error;
    }
  },
  
  checkResetStatus: async () => {
    try {
      const response = await fetch(`${CONFIG.API_URL}?action=checkResetStatus&cacheBuster=${Date.now()}`);
      if (!response.ok) throw new Error('Network response was not ok');
      return await response.json();
    } catch (error) {
      console.error("Error checking reset status:", error);
      throw error;
    }
  }
};

// Quiz functionality
const quiz = {
  renderQuestion: (data, isNewQuestion = false) => {
    if (!data || data.id === "") {
      ui.showWaiting();
      return;
    }
    
    const alreadyAnswered = cache.hasAnswered(data.id);
    
    // Check if it's the same question as currently displayed
    if (state.lastQuestionId === data.id) {
      if (alreadyAnswered && !elements.quizForm.querySelector('.message')) {
        ui.showAlreadyAnswered(data.question);
      }
      return;
    }
    
    // Save current state before changing question
    if (state.currentQuestion) {
      cache.saveChoices(state.currentQuestion.id, state.selectedChoices);
    }
    
    // Reset for new question
    state.lastQuestionId = data.id;
    state.currentQuestion = data;
    state.selectedChoices.clear();
    
    // Load saved choices if returning to a previously seen question
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
      // Visual effect for new question
      ui.shakeElement(elements.questionCard);
      
      // Vibration on mobile for new question (if supported)
      if ('vibrate' in navigator) {
        navigator.vibrate(100);
      }
    }
    
    // Build the form
    elements.quizForm.innerHTML = "";
    
    data.choices.forEach((choice, i) => {
      const div = document.createElement("div");
      div.className = "choice-container";
      
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
      
      btn.addEventListener('click', (e) => {
        helpers.toggleChoice(btn, isMultiple);
        ui.createRipple(e, btn);
      });
      
      if (state.isFirstLoad || isNewQuestion) {
        btn.style.opacity = "0";
        btn.style.transform = "translateX(20px)";
        btn.style.transition = "all 0.3s ease";
      }
      
      div.appendChild(btn);
      elements.quizForm.appendChild(div);
      
      if (state.isFirstLoad || isNewQuestion) {
        // Staggered animations
        setTimeout(() => {
          btn.style.opacity = "1";
          btn.style.transform = "translateX(0)";
        }, 100 + (i * 80));
      }
    });
    
    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "submit-btn";
    submitBtn.textContent = isMultiple ? "Envoyer mes réponses" : "Envoyer ma réponse";
    submitBtn.addEventListener('click', (e) => {
      ui.createRipple(e, submitBtn);
    });
    
    if (state.isFirstLoad || isNewQuestion) {
      submitBtn.style.opacity = "0";
    }
    
    elements.quizForm.appendChild(submitBtn);
    
    if (state.isFirstLoad || isNewQuestion) {
      setTimeout(() => {
        submitBtn.style.opacity = "1";
        submitBtn.style.transition = "opacity 0.3s ease";
      }, 100 + (data.choices.length * 80));
    }
    
    state.isFirstLoad = false;
  },
  
  pollQuestion: async () => {
    try {
      const data = await api.getQuestion();
      quiz.renderQuestion(data, data && data.id !== state.lastQuestionId);
    } catch (error) {
      ui.showError();
    }
  },
  
  checkForReset: async () => {
    try {
      const data = await api.checkResetStatus();
      const resetTimestamp = data?.resetTimestamp || "0";
      const validToken = data?.accessToken || "";
      const storedTimestamp = cache.get(CONFIG.RESET_TIMESTAMP_KEY) || "0";
      const urlToken = new URLSearchParams(window.location.search).get("token");
      
      // If no token or invalid token, block access
      if (!urlToken || !validToken || urlToken !== validToken) {
        ui.showAccessDenied();
        return false;
      }
      
      // Register timestamp if new reset detected
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
  
  startPolling: () => {
    state.pollInterval = setInterval(quiz.pollQuestion, CONFIG.POLL_INTERVAL);
    state.resetCheckInterval = setInterval(quiz.checkForReset, CONFIG.RESET_CHECK_INTERVAL);
  },
  
  stopPolling: () => {
    clearInterval(state.pollInterval);
    clearInterval(state.resetCheckInterval);
  },
  
  setupEventListeners: () => {
    // Handle form submission
    elements.quizForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.currentQuestion) return;
      
      const submitBtn = e.target.querySelector("button[type='submit']");
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
    
    // Touch optimization
    document.addEventListener('touchstart', () => {
      quiz.stopPolling();
      
      // Restart polling after inactivity
      const resumePolling = setTimeout(() => {
        quiz.pollQuestion();
        quiz.startPolling();
      }, CONFIG.INACTIVITY_TIMEOUT);
      
      // Reset timer on new interaction
      document.addEventListener('touchstart', () => {
        clearTimeout(resumePolling);
      }, { once: true });
    }, { passive: true });
  },
  
  init: async () => {
    cache.cleanupOldChoices();
    
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
      
      // Valid token: continue
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

// Initialize the application
document.addEventListener('DOMContentLoaded', quiz.init);