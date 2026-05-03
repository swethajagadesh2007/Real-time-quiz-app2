(function () {
  const app = document.querySelector("#app");
  const toast = document.querySelector("#toast");
  const socket = io();
  const avatars = [
    { key: "blue", label: "Blue" },
    { key: "purple", label: "Purple" },
    { key: "teal", label: "Teal" },
    { key: "indigo", label: "Indigo" },
    { key: "rose", label: "Rose" },
    { key: "amber", label: "Amber" }
  ];

  const state = {
    mode: localStorage.getItem("quizMode") || "home",
    loginRole: "",
    adminIsRegistering: false,
    adminToken: localStorage.getItem("adminToken") || "",
    adminQuizzes: [],
    activeQuizCode: "",
    quizState: null,
    clockOffset: 0,
    participantId: getOrCreateParticipantId(),
    participantName: localStorage.getItem("participantName") || "",
    participantAvatar: avatarKey(localStorage.getItem("participantAvatar") || "blue"),
    participantCode: "",
    joined: false,
    selectedAnswer: null,
    selectedQuestionId: "",
    timerHandle: null,
    builder: {
      title: "",
      timePerQuestion: 15,
      questions: [emptyQuestion()]
    }
  };

  const query = new URLSearchParams(window.location.search);
  const joinCode = (query.get("join") || "").trim().toUpperCase();
  if (joinCode) {
    state.mode = "home";
    state.loginRole = "participant";
    state.participantCode = joinCode;
  }

  socket.on("quiz:state", (incoming) => {
    applyQuizState(incoming);
  });

  socket.on("participant:answered", (payload) => {
    state.selectedAnswer = payload.selectedIndex;
    render();
  });

  socket.on("connect", () => {
    if (state.joined && state.participantCode && state.participantName) {
      joinQuiz({ quiet: true });
    }
    if (state.mode === "admin" && state.activeQuizCode && state.adminToken) {
      watchQuiz(state.activeQuizCode, { quiet: true });
    }
  });

  init();

  async function init() {
    if (state.adminToken) {
      await loadAdminQuizzes({ quiet: true });
    }
    render();
  }

  function render() {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
    document.body.dataset.mode = state.mode;
    document.body.dataset.status = state.quizState ? state.quizState.status : "home";

    if (state.mode === "admin" && state.adminToken) {
      renderAdmin();
      return;
    }

    if (state.mode === "participant" && state.joined) {
      renderParticipantStage();
      return;
    }

    renderHome();
  }

  function renderHome() {
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-card panel">
          ${state.loginRole ? renderSelectedLogin() : renderLoginChoice()}
        </section>
      </main>
    `;

    const adminForm = document.querySelector("#adminLoginForm");
    const adminRegForm = document.querySelector("#adminRegisterForm");
    const joinForm = document.querySelector("#joinQuizForm");

    if (adminForm) {
      adminForm.addEventListener("submit", handleAdminLogin);
    }
    if (adminRegForm) {
      adminRegForm.addEventListener("submit", handleAdminRegister);
    }
    if (joinForm) {
      joinForm.addEventListener("submit", handleJoinSubmit);
    }

    app.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", handleActionClick);
    });
  }

  function renderLoginChoice() {
    return `
      <div class="login-heading">
        <div class="brand-mark">Q</div>
        <h1>Choose Your Login</h1>
        <p>Enter as an admin to run a quiz or as a participant to join the live room.</p>
      </div>
      <div class="login-choice-grid">
        <button class="login-choice" type="button" data-action="choose-login" data-role="admin">
          ${renderRoleIcon("admin")}
          <span>
            <strong>Admin Login</strong>
            <small>Create questions, publish links, and control the live quiz.</small>
          </span>
        </button>
        <button class="login-choice" type="button" data-action="choose-login" data-role="participant">
          ${renderRoleIcon("participant")}
          <span>
            <strong>Participant Login</strong>
            <small>Join with a quiz code or link and answer in real time.</small>
          </span>
        </button>
      </div>
    `;
  }

  function renderSelectedLogin() {
    if (state.loginRole === "admin") {
      const isReg = state.adminIsRegistering;
      return `
        <button class="back-link" type="button" data-action="back-login">Back</button>
        <div class="login-heading compact">
          ${renderRoleIcon("admin")}
          <h1>${isReg ? "Admin Register" : "Admin Login"}</h1>
          <p>${isReg ? "Create a new admin account." : "Access your quiz dashboard."}</p>
        </div>
        <form id="${isReg ? 'adminRegisterForm' : 'adminLoginForm'}" class="form-grid">
          <label class="field">
            <span>Username</span>
            <input name="username" autocomplete="username" placeholder="admin" required minlength="3" />
          </label>
          <label class="field">
            <span>Password</span>
            <input name="password" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}" placeholder="******" required minlength="6" />
          </label>
          <button class="button" type="submit">${isReg ? "Register" : "Login as Admin"}</button>
          <p class="hint">
            ${isReg ? "Already have an account? " : "Don't have an account? "}
            <a href="#" data-action="toggle-admin-reg">${isReg ? "Login here" : "Register here"}</a>
          </p>
        </form>
      `;
    }

    return `
      <button class="back-link" type="button" data-action="back-login">Back</button>
      <div class="login-heading compact">
        ${renderRoleIcon("participant")}
        <h1>Participant Login</h1>
        <p>Use your quiz code and a professional initials avatar.</p>
      </div>
      <form id="joinQuizForm" class="form-grid">
        <label class="field">
          <span>Your Name</span>
          <input name="name" value="${escapeAttr(state.participantName)}" autocomplete="name" required />
        </label>
        <label class="field">
          <span>Quiz Code</span>
          <input name="code" value="${escapeAttr(state.participantCode)}" maxlength="12" required />
        </label>
        <div class="field">
          <span>Avatar Gradient</span>
          ${renderAvatarPicker()}
        </div>
        <button class="button success" type="submit">Start Quiz</button>
      </form>
    `;
  }

  function renderRoleIcon(role) {
    if (role === "admin") {
      return `
        <span class="role-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 3 5 6v5c0 4.4 2.8 8.4 7 10 4.2-1.6 7-5.6 7-10V6l-7-3Z"></path>
            <path d="M9.4 12.1 11.2 14l3.6-4"></path>
          </svg>
        </span>
      `;
    }

    return `
      <span class="role-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2Z"></path>
          <path d="M4.8 20c1.1-3.6 3.6-5.5 7.2-5.5s6.1 1.9 7.2 5.5"></path>
        </svg>
      </span>
    `;
  }

  function renderAdmin() {
    app.innerHTML = `
      <main class="page">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">A</div>
            <div>
              <h1>Admin Dashboard</h1>
              <p>Create quizzes, share QR codes, and start live rounds.</p>
            </div>
          </div>
          <div class="button-row">
            <button class="button secondary" id="refreshQuizzes" type="button">Refresh</button>
            <button class="button ghost" id="logoutAdmin" type="button">Logout</button>
          </div>
        </header>

        <section class="admin-grid">
          <div class="stack">
            <div class="panel builder">
              <h2 class="panel-title">Create Quiz</h2>
              ${renderBuilderForm()}
            </div>
          </div>

          <div class="stack">
            <div class="panel quiz-list">
              <h2 class="panel-title">Published Quizzes</h2>
              ${renderQuizList()}
            </div>
            <div class="panel live-panel">
              <h2 class="panel-title">Live Control</h2>
              ${renderLivePanel()}
            </div>
          </div>
        </section>
      </main>
    `;

    document.querySelector("#logoutAdmin").addEventListener("click", logoutAdmin);
    document.querySelector("#refreshQuizzes").addEventListener("click", () => loadAdminQuizzes());
    document.querySelector("#quizBuilderForm").addEventListener("submit", handleCreateQuiz);

    app.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", handleActionClick);
    });
  }

  function renderBuilderForm() {
    return `
      <form id="quizBuilderForm">
        <div class="quiz-form-head">
          <label class="field">
            <span>Quiz Title</span>
            <input name="title" value="${escapeAttr(state.builder.title)}" required />
          </label>
          <label class="field">
            <span>Seconds per Question</span>
            <input name="timePerQuestion" type="number" min="5" max="120" value="${escapeAttr(state.builder.timePerQuestion)}" required />
          </label>
        </div>

        <div id="questionsEditor">
          ${state.builder.questions.map(renderQuestionEditor).join("")}
        </div>

        <div class="button-row">
          <button class="button secondary" type="button" data-action="add-question">Add Question</button>
          <button class="button" type="submit">Save and Publish</button>
        </div>
      </form>
    `;
  }

  function renderQuestionEditor(question, questionIndex) {
    const options = question.options
      .map((option, optionIndex) => {
        const checked = Number(question.correctIndex) === optionIndex ? "checked" : "";
        return `
          <div class="option-editor">
            <input type="radio" name="correct-${questionIndex}" value="${optionIndex}" ${checked} aria-label="Correct option ${optionIndex + 1}" />
            <label class="field">
              <span>Option ${optionIndex + 1}</span>
              <input name="option-${questionIndex}-${optionIndex}" value="${escapeAttr(option)}" required />
            </label>
            <button class="button danger" type="button" data-action="remove-option" data-question="${questionIndex}" data-option="${optionIndex}">Remove</button>
          </div>
        `;
      })
      .join("");

    return `
      <div class="question-editor">
        <div class="question-head">
          <h3>Question ${questionIndex + 1}</h3>
          <button class="button danger" type="button" data-action="remove-question" data-question="${questionIndex}">Remove Question</button>
        </div>
        <label class="field">
          <span>Question Text</span>
          <textarea name="questionText-${questionIndex}" required>${escapeHtml(question.text)}</textarea>
        </label>
        <div class="options-list">
          ${options}
        </div>
        <div class="button-row">
          <button class="button secondary" type="button" data-action="add-option" data-question="${questionIndex}">Add Option</button>
        </div>
      </div>
    `;
  }

  function renderQuizList() {
    if (!state.adminQuizzes.length) {
      return `<p class="empty">No quizzes yet.</p>`;
    }

    return state.adminQuizzes
      .map((quiz) => {
        return `
          <article class="quiz-card">
            <div class="quiz-card-head">
              <div>
                <h3>${escapeHtml(quiz.title)}</h3>
                <div class="meta">${quiz.totalQuestions} questions | ${quiz.timePerQuestion}s each</div>
              </div>
              <span class="status-pill">${escapeHtml(quiz.code)}</span>
            </div>

            <div class="qr-row">
              <img src="${quiz.qrDataUrl}" alt="QR code for ${escapeAttr(quiz.title)}" />
              <div>
                <div class="link-box">${escapeHtml(quiz.link)}</div>
                <div class="button-row" style="margin-top: 10px;">
                  <button class="button secondary" type="button" data-action="copy-link" data-link="${escapeAttr(quiz.link)}">Copy Link</button>
                  <a class="button ghost" href="${escapeAttr(quiz.link)}" target="_blank" rel="noreferrer">Open</a>
                </div>
              </div>
            </div>

            <div class="button-row">
              <button class="button success" type="button" data-action="start-quiz" data-code="${escapeAttr(quiz.code)}">Start Quiz</button>
              <button class="button secondary" type="button" data-action="watch-quiz" data-code="${escapeAttr(quiz.code)}">Watch</button>
              <button class="button ghost" type="button" data-action="reset-quiz" data-code="${escapeAttr(quiz.code)}">Reset</button>
              <button class="button danger" type="button" data-action="delete-quiz" data-code="${escapeAttr(quiz.code)}">Delete</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderLivePanel() {
    const quizState = state.quizState;
    if (!state.activeQuizCode || !quizState) {
      return `<p class="empty">Select Watch or Start on a quiz.</p>`;
    }

    const status = statusLabel(quizState.status);
    const questionNumber =
      quizState.status === "question" && quizState.question
        ? `${quizState.question.number} / ${quizState.question.total}`
        : quizState.status === "leaderboard" && quizState.result
          ? `${quizState.result.number} / ${quizState.result.total}`
          : quizState.status === "completed"
            ? `${quizState.totalQuestions} / ${quizState.totalQuestions}`
            : "0 / " + quizState.totalQuestions;

    return `
      <div class="live-summary">
        <div class="metric"><strong>${escapeHtml(status)}</strong><span>Status</span></div>
        <div class="metric"><strong>${escapeHtml(questionNumber)}</strong><span>Question</span></div>
        <div class="metric"><strong>${quizState.participantCount}</strong><span>Participants</span></div>
      </div>
      ${renderStateDetail(quizState)}
      ${renderLeaderboard(quizState.leaderboard)}
    `;
  }

  function renderParticipantStage() {
    const quizState = state.quizState;
    app.innerHTML = `
      <main class="participant-wrap">
        <section class="panel quiz-stage">
          ${renderParticipantHeader(quizState)}
          ${renderStateDetail(quizState, true)}
        </section>
      </main>
    `;

    app.querySelectorAll("[data-answer]").forEach((button) => {
      button.addEventListener("click", handleAnswerClick);
    });
    app.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", handleActionClick);
    });

    mountTimers();
  }

  function renderParticipantHeader(quizState) {
    return `
      <div class="stage-head">
        <div class="player-title">
          ${renderAvatar(state.participantAvatar, "lg", initialsFromName(state.participantName))}
          <div>
            <h2>${escapeHtml(quizState ? quizState.title : "Quiz")}</h2>
            <p>${escapeHtml(state.participantName)} | Code ${escapeHtml(state.participantCode)}</p>
          </div>
        </div>
        <span class="status-pill">${escapeHtml(statusLabel(quizState ? quizState.status : "waiting"))}</span>
      </div>
    `;
  }

  function renderStateDetail(quizState, isParticipant) {
    if (!quizState || quizState.status === "waiting") {
      return `
        <div class="waiting-box">
          <h3>Waiting for admin to start</h3>
          <p class="hint">Participants joined: ${quizState ? quizState.participantCount : 0}</p>
        </div>
      `;
    }

    if (quizState.status === "question" && quizState.question) {
      return renderQuestion(quizState, isParticipant);
    }

    if (quizState.status === "leaderboard" && quizState.result) {
      return renderQuestionResult(quizState);
    }

    if (quizState.status === "completed") {
      return `
        <div class="done-box final-showcase">
          <h3>Quiz Completed</h3>
          <p class="hint">Final top performers are ready.</p>
        </div>
        ${renderPodium(quizState.leaderboard)}
        ${renderLeaderboard(quizState.leaderboard)}
      `;
    }

    if (quizState.status === "deleted") {
      return `
        <div class="done-box">
          <h3>Quiz Removed</h3>
          <p class="hint">${escapeHtml(quizState.message || "This quiz is no longer available.")}</p>
          <button class="button secondary" type="button" data-action="leave-participant">Back</button>
        </div>
      `;
    }

    return `<p class="empty">Preparing quiz.</p>`;
  }

  function renderQuestion(quizState, isParticipant) {
    const question = quizState.question;
    const choices = question.options
      .map((option, index) => {
        const selected = state.selectedAnswer === index ? "selected" : "";
        const disabled = isParticipant ? "" : "disabled";
        return `
          <button class="choice ${selected}" type="button" data-answer="${index}" ${disabled}>
            <span class="choice-letter">${optionLetter(index)}</span>
            <span>${escapeHtml(option)}</span>
          </button>
        `;
      })
      .join("");

    const adminControls = !isParticipant ? `
      <div class="button-row" style="margin-top: 16px;">
        <button class="button success" type="button" data-action="next-question">Next Question (End Timer)</button>
        <button class="button ghost" type="button" data-action="skip-question">Skip Question</button>
      </div>
    ` : '';

    return `
      <div>
        <div class="meta">Question ${question.number} of ${question.total}</div>
        <div class="timer-track" id="timerTrack" aria-hidden="true">
          <div class="timer-bar" id="timerBar"></div>
        </div>
        <div class="meta" id="timerText">--</div>
        <h3 class="question-text">${escapeHtml(question.text)}</h3>
        <div class="choice-grid">
          ${choices}
        </div>
        <div class="answer-note" id="answerNote">${state.selectedAnswer === null ? "" : "Answer locked in."}</div>
        ${adminControls}
      </div>
    `;
  }

  function renderQuestionResult(quizState) {
    const result = quizState.result;
    
    const choices = result.options
      .map((option, index) => {
        const isCorrect = index === result.correctIndex;
        const isSelected = state.selectedAnswer === index;
        const highlightClass = isCorrect ? "correct" : (isSelected ? "incorrect" : "");
        return `
          <button class="choice ${highlightClass}" type="button" disabled>
            <span class="choice-letter">${optionLetter(index)}</span>
            <span>${escapeHtml(option)}</span>
          </button>
        `;
      })
      .join("");

    return `
      <div class="leaderboard-scene">
        ${renderCelebration()}
        <div class="meta">Question ${result.number} of ${result.total}</div>
        <h3 class="question-text">${escapeHtml(result.questionText)}</h3>
        <div class="choice-grid">
          ${choices}
        </div>
        <p class="hint" id="nextText" style="margin-top: 16px;">Next round starting soon.</p>
        ${renderLeaderboard(quizState.leaderboard)}
      </div>
    `;
  }

  function renderLeaderboard(leaderboard) {
    if (!leaderboard || !leaderboard.length) {
      return `<p class="empty" style="margin-top: 16px;">No scores yet.</p>`;
    }

    return `
      <div class="leaderboard-list" style="margin-top: 16px;">
        ${leaderboard
          .map(
            (row) => `
              <div class="leaderboard-row rank-${row.rank <= 3 ? row.rank : "other"}">
                <div class="rank-badge">${row.rank}</div>
                ${renderAvatar(row.avatar || "blue", "sm", initialsFromName(row.name))}
                <div class="leader-name">
                  <strong>${escapeHtml(row.name)}</strong>
                  <span>${avatarLabel(row.avatar || "blue")} gradient</span>
                </div>
                <div class="score-pill">${row.score}</div>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderPodium(leaderboard) {
    const topThree = (leaderboard || []).slice(0, 3);
    if (!topThree.length) {
      return `<p class="empty" style="margin-top: 16px;">No final scores yet.</p>`;
    }

    return `
      <div class="podium">
        ${topThree
          .map(
            (row) => `
              <div class="podium-card podium-${row.rank}">
                <div class="podium-rank">${rankLabel(row.rank)}</div>
                ${renderAvatar(row.avatar || "blue", "xl", initialsFromName(row.name))}
                <strong>${escapeHtml(row.name)}</strong>
                <span>${row.score} points</span>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderCelebration() {
    return `
      <div class="celebration" aria-hidden="true">
        <span class="spark spark-a">WOW</span>
        <span class="spark spark-b">TOP</span>
        <span class="spark spark-c">+10</span>
      </div>
    `;
  }

  function renderAvatarPicker() {
    return `
      <div class="avatar-picker">
        ${avatars
          .map((avatar) => {
            const checked = state.participantAvatar === avatar.key ? "checked" : "";
            return `
              <label class="avatar-option">
                <input type="radio" name="avatar" value="${avatar.key}" ${checked} />
                ${renderAvatar(avatar.key, "md", initialsFromName(state.participantName) || "ID")}
                <span>${avatar.label}</span>
              </label>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderAvatar(key, size, initials) {
    const safeKey = avatarKey(key);
    return `
      <span class="avatar-token avatar-${safeKey} avatar-${size || "md"}" aria-label="${avatarLabel(safeKey)} avatar">
        ${escapeHtml(initials || initialsFromName(state.participantName) || "ID")}
      </span>
    `;
  }

  async function handleAdminLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      username: form.username.value.trim(),
      password: form.password.value
    };

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.message || "Unable to login.");
      }

      state.adminToken = result.token;
      localStorage.setItem("adminToken", result.token);
      localStorage.setItem("quizMode", "admin");
      state.mode = "admin";
      await loadAdminQuizzes({ quiet: true });
      render();
      showToast("Admin logged in.");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function handleAdminRegister(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      username: form.username.value.trim(),
      password: form.password.value
    };

    try {
      const response = await fetch("/api/admin/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.message || "Unable to register.");
      }

      state.adminToken = result.token;
      localStorage.setItem("adminToken", result.token);
      localStorage.setItem("quizMode", "admin");
      state.mode = "admin";
      await loadAdminQuizzes({ quiet: true });
      render();
      showToast("Admin registered and logged in.");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function handleJoinSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    state.participantName = form.name.value.trim();
    state.participantCode = normalizeCode(form.code.value);
    state.participantAvatar = avatarKey(form.avatar.value);
    await joinQuiz();
  }

  async function handleCreateQuiz(event) {
    event.preventDefault();
    syncBuilderFromForm();

    try {
      const response = await fetch("/api/admin/quizzes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeaders()
        },
        body: JSON.stringify(state.builder)
      });
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.message || "Could not save quiz.");
      }

      state.builder = {
        title: "",
        timePerQuestion: 15,
        questions: [emptyQuestion()]
      };
      await loadAdminQuizzes({ quiet: true });
      state.activeQuizCode = result.quiz.code;
      await watchQuiz(result.quiz.code, { quiet: true });
      render();
      showToast("Quiz saved and published.");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function handleActionClick(event) {
    const button = event.currentTarget;
    const action = button.dataset.action;

    if (action === "choose-login") {
      state.loginRole = button.dataset.role || "";
      render();
      return;
    }

    if (action === "back-login") {
      state.loginRole = "";
      state.adminIsRegistering = false;
      render();
      return;
    }

    if (action === "toggle-admin-reg") {
      event.preventDefault();
      state.adminIsRegistering = !state.adminIsRegistering;
      render();
      return;
    }

    if (action === "add-question") {
      syncBuilderFromForm();
      state.builder.questions.push(emptyQuestion());
      render();
      return;
    }

    if (action === "remove-question") {
      syncBuilderFromForm();
      const questionIndex = Number(button.dataset.question);
      if (state.builder.questions.length === 1) {
        showToast("Keep at least one question.");
        return;
      }
      state.builder.questions.splice(questionIndex, 1);
      render();
      return;
    }

    if (action === "add-option") {
      syncBuilderFromForm();
      const questionIndex = Number(button.dataset.question);
      state.builder.questions[questionIndex].options.push("");
      render();
      return;
    }

    if (action === "remove-option") {
      syncBuilderFromForm();
      const questionIndex = Number(button.dataset.question);
      const optionIndex = Number(button.dataset.option);
      const question = state.builder.questions[questionIndex];
      if (question.options.length <= 2) {
        showToast("Keep at least two options.");
        return;
      }
      question.options.splice(optionIndex, 1);
      if (question.correctIndex >= question.options.length) {
        question.correctIndex = question.options.length - 1;
      }
      render();
      return;
    }

    if (action === "copy-link") {
      await copyText(button.dataset.link);
      return;
    }

    if (action === "watch-quiz") {
      await watchQuiz(button.dataset.code);
      return;
    }

    if (action === "start-quiz") {
      await startQuiz(button.dataset.code);
      return;
    }

    if (action === "reset-quiz") {
      await resetQuiz(button.dataset.code);
      return;
    }

    if (action === "delete-quiz") {
      await deleteQuiz(button.dataset.code);
      return;
    }

    if (action === "next-question") {
      await emitWithReply("admin:next", {
        token: state.adminToken,
        code: state.activeQuizCode
      });
      return;
    }

    if (action === "skip-question") {
      await emitWithReply("admin:skip", {
        token: state.adminToken,
        code: state.activeQuizCode
      });
      return;
    }

    if (action === "leave-participant") {
      state.mode = "home";
      state.joined = false;
      state.quizState = null;
      localStorage.setItem("quizMode", "home");
      render();
    }
  }

  async function handleAnswerClick(event) {
    const selectedIndex = Number(event.currentTarget.dataset.answer);
    state.selectedAnswer = selectedIndex;
    render();

    const result = await emitWithReply("participant:answer", { selectedIndex });
    if (!result.ok) {
      state.selectedAnswer = null;
      render();
      showToast(result.message || "Answer not submitted.");
      return;
    }

    if (!result.accepted) {
      showToast(result.message || "Answer already submitted.");
    }
  }

  async function joinQuiz(options) {
    try {
      const result = await emitWithReply("participant:join", {
        code: state.participantCode,
        name: state.participantName,
        participantId: state.participantId,
        avatar: state.participantAvatar
      });

      if (!result.ok) {
        throw new Error(result.message || "Could not join quiz.");
      }

      state.participantId = result.participantId;
      state.joined = true;
      state.mode = "participant";
      localStorage.setItem("participantId", state.participantId);
      localStorage.setItem("participantName", state.participantName);
      localStorage.setItem("participantAvatar", state.participantAvatar);
      localStorage.setItem("quizMode", "participant");
      applyQuizState(result.state, { skipRender: true });
      render();

      if (!options || !options.quiet) {
        showToast("Joined quiz.");
      }
    } catch (error) {
      showToast(error.message);
    }
  }

  async function loadAdminQuizzes(options) {
    if (!state.adminToken) {
      return;
    }

    try {
      const response = await fetch("/api/admin/quizzes", {
        headers: adminHeaders()
      });
      const result = await response.json();

      if (response.status === 401) {
        logoutAdmin({ quiet: true });
        throw new Error("Admin session expired. Login again.");
      }

      if (!result.ok) {
        throw new Error(result.message || "Unable to load quizzes.");
      }

      state.adminQuizzes = result.quizzes;
      if (!options || !options.quiet) {
        render();
        showToast("Quizzes refreshed.");
      }
    } catch (error) {
      if (!options || !options.quiet) {
        showToast(error.message);
      }
    }
  }

  async function watchQuiz(code, options) {
    const result = await emitWithReply("admin:watch", {
      token: state.adminToken,
      code
    });

    if (!result.ok) {
      showToast(result.message || "Unable to watch quiz.");
      return false;
    }

    state.activeQuizCode = code;
    applyQuizState(result.state, { skipRender: true });
    if (!options || !options.quiet) {
      render();
      showToast("Live quiz selected.");
    }
    return true;
  }

  async function startQuiz(code) {
    const watching = await watchQuiz(code, { quiet: true });
    if (!watching) {
      return;
    }

    const result = await emitWithReply("admin:start", {
      token: state.adminToken,
      code
    });

    if (!result.ok) {
      showToast(result.message || "Unable to start quiz.");
      return;
    }

    render();
    showToast("Quiz started.");
  }

  async function resetQuiz(code) {
    const watching = await watchQuiz(code, { quiet: true });
    if (!watching) {
      return;
    }

    const result = await emitWithReply("admin:reset", {
      token: state.adminToken,
      code
    });

    if (!result.ok) {
      showToast(result.message || "Unable to reset quiz.");
      return;
    }

    render();
    showToast("Quiz reset.");
  }

  async function deleteQuiz(code) {
    const confirmed = window.confirm("Delete this quiz?");
    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/quizzes/${encodeURIComponent(code)}`, {
        method: "DELETE",
        headers: adminHeaders()
      });
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.message || "Unable to delete quiz.");
      }

      if (state.activeQuizCode === code) {
        state.activeQuizCode = "";
        state.quizState = null;
      }

      await loadAdminQuizzes({ quiet: true });
      render();
      showToast("Quiz deleted.");
    } catch (error) {
      showToast(error.message);
    }
  }

  function syncBuilderFromForm() {
    const form = document.querySelector("#quizBuilderForm");
    if (!form) {
      return;
    }

    state.builder.title = form.title.value.trim();
    state.builder.timePerQuestion = Number(form.timePerQuestion.value);
    state.builder.questions = state.builder.questions.map((question, questionIndex) => {
      const text = form[`questionText-${questionIndex}`].value.trim();
      const options = question.options.map((_, optionIndex) => {
        const input = form[`option-${questionIndex}-${optionIndex}`];
        return input ? input.value.trim() : "";
      });
      const checked = form.querySelector(`input[name="correct-${questionIndex}"]:checked`);
      const correctIndex = checked ? Number(checked.value) : 0;

      return {
        text,
        options,
        correctIndex
      };
    });
  }

  function mountTimers() {
    const quizState = state.quizState;
    if (!quizState) {
      return;
    }

    const update = () => {
      const serverNow = Date.now() + state.clockOffset;

      if (quizState.status === "question" && quizState.question) {
        const duration = quizState.question.endsAt - quizState.question.startedAt;
        const left = Math.max(0, quizState.question.endsAt - serverNow);
        const fraction = duration > 0 ? Math.max(0, Math.min(1, left / duration)) : 0;
        const timerBar = document.querySelector("#timerBar");
        const timerTrack = document.querySelector("#timerTrack");
        const timerText = document.querySelector("#timerText");
        const timerLevel = fraction < 0.25 ? "critical" : fraction < 0.5 ? "hot" : "calm";

        if (timerBar) {
          timerBar.style.transform = `scaleX(${fraction})`;
        }
        if (timerTrack) {
          timerTrack.dataset.level = timerLevel;
        }
        if (timerText) {
          timerText.textContent = `${Math.ceil(left / 1000)} seconds left`;
        }
      }

      if (quizState.status === "leaderboard" && quizState.result) {
        const left = Math.max(0, quizState.result.leaderboardEndsAt - serverNow);
        const nextText = document.querySelector("#nextText");
        if (nextText) {
          nextText.textContent = left > 0 ? `Next step in ${Math.ceil(left / 1000)} seconds.` : "Loading next step.";
        }
      }
    };

    update();
    state.timerHandle = setInterval(update, 250);
  }

  function applyQuizState(incoming, options) {
    if (!incoming) {
      return;
    }

    const previousQuestionId = state.quizState && state.quizState.question ? state.quizState.question.id : "";
    const nextQuestionId = incoming.question ? incoming.question.id : "";

    state.clockOffset = incoming.serverTime ? incoming.serverTime - Date.now() : 0;
    state.quizState = incoming;

    if (incoming.status === "question" && nextQuestionId && nextQuestionId !== previousQuestionId) {
      state.selectedAnswer = null;
      state.selectedQuestionId = nextQuestionId;
    }

    if (!options || !options.skipRender) {
      render();
    }
  }

  function emitWithReply(eventName, payload) {
    return new Promise((resolve) => {
      socket.emit(eventName, payload || {}, (reply) => {
        resolve(reply || { ok: false, message: "No response from server." });
      });
    });
  }

  function adminHeaders() {
    return { Authorization: `Bearer ${state.adminToken}` };
  }

  function logoutAdmin(options) {
    state.adminToken = "";
    state.adminQuizzes = [];
    state.activeQuizCode = "";
    state.quizState = null;
    state.mode = "home";
    localStorage.removeItem("adminToken");
    localStorage.setItem("quizMode", "home");

    if (!options || !options.quiet) {
      render();
      showToast("Logged out.");
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Link copied.");
    } catch (error) {
      showToast("Copy failed. Select the link and copy it manually.");
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.classList.remove("show");
    }, 2600);
  }

  function statusLabel(status) {
    const labels = {
      waiting: "Waiting",
      question: "Question Live",
      leaderboard: "Leaderboard",
      completed: "Completed",
      deleted: "Removed"
    };
    return labels[status] || "Ready";
  }

  function optionLetter(index) {
    return String.fromCharCode(65 + index);
  }

  function avatarKey(value) {
    const key = String(value || "").toLowerCase();
    return avatars.some((avatar) => avatar.key === key) ? key : "blue";
  }

  function avatarLabel(value) {
    const key = avatarKey(value);
    const match = avatars.find((avatar) => avatar.key === key);
    return match ? match.label : "Blue";
  }

  function initialsFromName(name) {
    const parts = String(name || "")
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (!parts.length) {
      return "";
    }

    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }

    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }

  function rankLabel(rank) {
    if (rank === 1) {
      return "1st";
    }
    if (rank === 2) {
      return "2nd";
    }
    if (rank === 3) {
      return "3rd";
    }
    return `${rank}th`;
  }

  function normalizeCode(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  function emptyQuestion() {
    return {
      text: "",
      options: ["", "", "", ""],
      correctIndex: 0
    };
  }

  function getOrCreateParticipantId() {
    const existing = localStorage.getItem("participantId");
    if (existing) {
      return existing;
    }

    const id =
      window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `participant-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    localStorage.setItem("participantId", id);
    return id;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
