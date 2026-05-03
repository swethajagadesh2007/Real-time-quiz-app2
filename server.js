const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";
const LEADERBOARD_MS = Number(process.env.LEADERBOARD_MS || 5000);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const QUIZ_FILE = path.join(DATA_DIR, "quizzes.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const AVATAR_KEYS = new Set(["blue", "purple", "teal", "indigo", "rose", "amber"]);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const adminTokens = new Set();
const sessions = new Map();
let store = loadStore();

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/admin/register", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ ok: false, message: "Username must be at least 3 chars and password at least 6 chars." });
  }

  if (store.admins[username]) {
    return res.status(400).json({ ok: false, message: "Username already exists." });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");

  store.admins[username] = { salt, hash };
  saveStore();

  const token = crypto.randomBytes(32).toString("hex");
  adminTokens.add(token);
  res.json({ ok: true, token });
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};

  const admin = store.admins[username];
  if (admin) {
    const hash = crypto.pbkdf2Sync(password, admin.salt, 1000, 64, "sha512").toString("hex");
    if (hash === admin.hash) {
      const token = crypto.randomBytes(32).toString("hex");
      adminTokens.add(token);
      return res.json({ ok: true, token });
    }
  }

  res.status(401).json({ ok: false, message: "Invalid admin username or password." });
});

app.get("/api/admin/quizzes", requireAdmin, async (req, res) => {
  const quizzes = await Promise.all(
    Object.values(store.quizzes)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((quiz) => formatAdminQuiz(req, quiz))
  );

  res.json({ ok: true, quizzes });
});

app.post("/api/admin/quizzes", requireAdmin, async (req, res) => {
  try {
    const quiz = normalizeQuizPayload(req.body);
    quiz.code = createQuizCode();
    quiz.createdAt = new Date().toISOString();
    quiz.updatedAt = quiz.createdAt;
    quiz.published = true;

    store.quizzes[quiz.code] = quiz;
    saveStore();

    res.status(201).json({ ok: true, quiz: await formatAdminQuiz(req, quiz) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.delete("/api/admin/quizzes/:code", requireAdmin, (req, res) => {
  const code = normalizeCode(req.params.code);

  if (!store.quizzes[code]) {
    res.status(404).json({ ok: false, message: "Quiz not found." });
    return;
  }

  delete store.quizzes[code];
  saveStore();

  const session = sessions.get(code);
  if (session) {
    clearSessionTimers(session);
    sessions.delete(code);
  }

  io.to(roomName(code)).emit("quiz:state", {
    status: "deleted",
    code,
    message: "This quiz was removed by the admin.",
    serverTime: Date.now()
  });

  res.json({ ok: true });
});

app.get("/api/quizzes/:code/public", async (req, res) => {
  const code = normalizeCode(req.params.code);
  const quiz = store.quizzes[code];

  if (!quiz || !quiz.published) {
    res.status(404).json({ ok: false, message: "Quiz not found." });
    return;
  }

  res.json({ ok: true, quiz: await formatPublicQuiz(req, quiz) });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

io.on("connection", (socket) => {
  socket.on("admin:watch", (payload, reply) => {
    handleSocketAction(reply, () => {
      requireAdminToken(payload && payload.token);
      const code = normalizeCode(payload && payload.code);
      const quiz = getQuizOrThrow(code);
      const session = getSession(code);

      socket.join(roomName(code));
      socket.data.role = "admin";
      socket.data.code = code;

      return { ok: true, quiz: sanitizeQuizForAdmin(quiz), state: buildState(session) };
    });
  });

  socket.on("admin:start", (payload, reply) => {
    handleSocketAction(reply, () => {
      requireAdminToken(payload && payload.token);
      const code = normalizeCode(payload && payload.code);
      const quiz = getQuizOrThrow(code);
      const session = getSession(code);

      if (!quiz.published) {
        throw new Error("Publish the quiz before starting it.");
      }

      socket.join(roomName(code));
      resetSessionForNewRun(session);
      broadcastState(session);
      startQuestion(session, 0);

      return { ok: true };
    });
  });

  socket.on("admin:reset", (payload, reply) => {
    handleSocketAction(reply, () => {
      requireAdminToken(payload && payload.token);
      const code = normalizeCode(payload && payload.code);
      getQuizOrThrow(code);
      const session = getSession(code);

      socket.join(roomName(code));
      resetSessionForNewRun(session);
      broadcastState(session);

      return { ok: true };
    });
  });

  socket.on("admin:next", (payload, reply) => {
    handleSocketAction(reply, () => {
      requireAdminToken(payload && payload.token);
      const code = normalizeCode(payload && payload.code);
      getQuizOrThrow(code);
      const session = getSession(code);

      if (session.status === "question") {
        clearSessionTimers(session);
        finishQuestion(session);
      }
      return { ok: true };
    });
  });

  socket.on("admin:skip", (payload, reply) => {
    handleSocketAction(reply, () => {
      requireAdminToken(payload && payload.token);
      const code = normalizeCode(payload && payload.code);
      getQuizOrThrow(code);
      const session = getSession(code);

      if (session.status === "question" || session.status === "leaderboard") {
        clearSessionTimers(session);
        startQuestion(session, session.status === "question" ? session.currentIndex + 1 : session.currentIndex);
      }
      return { ok: true };
    });
  });

  socket.on("participant:join", (payload, reply) => {
    handleSocketAction(reply, () => {
      const code = normalizeCode(payload && payload.code);
      const quiz = getQuizOrThrow(code);

      if (!quiz.published) {
        throw new Error("This quiz is not published yet.");
      }

      const name = cleanText(payload && payload.name, 40);
      if (!name) {
        throw new Error("Enter your name to join the quiz.");
      }

      const participantId = cleanParticipantId(payload && payload.participantId);
      const avatar = cleanAvatar(payload && payload.avatar);
      const session = getSession(code);
      let participant = session.participants.get(participantId);

      if (!participant) {
        participant = {
          id: participantId,
          name,
          avatar,
          score: 0,
          socketIds: new Set()
        };
        session.participants.set(participantId, participant);
      }

      participant.name = name;
      participant.avatar = avatar;
      participant.socketIds.add(socket.id);
      socket.join(roomName(code));
      socket.data.role = "participant";
      socket.data.code = code;
      socket.data.participantId = participantId;

      broadcastState(session);

      return {
        ok: true,
        participantId,
        quiz: sanitizeQuizForParticipant(quiz),
        state: buildState(session)
      };
    });
  });

  socket.on("participant:answer", (payload, reply) => {
    handleSocketAction(reply, () => {
      const code = socket.data.code;
      const participantId = socket.data.participantId;

      if (!code || !participantId) {
        throw new Error("Join the quiz before answering.");
      }

      const session = sessions.get(code);
      const quiz = getQuizOrThrow(code);

      if (!session || session.status !== "question") {
        throw new Error("There is no active question right now.");
      }

      if (Date.now() > session.questionEndsAt) {
        throw new Error("Time is up for this question.");
      }

      if (session.answers.has(participantId)) {
        return { ok: true, accepted: false, message: "Your answer was already submitted." };
      }

      const question = quiz.questions[session.currentIndex];
      const selectedIndex = Number(payload && payload.selectedIndex);

      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= question.options.length) {
        throw new Error("Choose a valid option.");
      }

      session.answers.set(participantId, {
        selectedIndex,
        submittedAt: Date.now(),
        points: 0,
        bonus: 0,
        isCorrect: false
      });

      socket.emit("participant:answered", { selectedIndex });

      return { ok: true, accepted: true };
    });
  });

  socket.on("disconnect", () => {
    if (socket.data.role !== "participant" || !socket.data.code || !socket.data.participantId) {
      return;
    }

    const session = sessions.get(socket.data.code);
    if (!session) {
      return;
    }

    const participant = session.participants.get(socket.data.participantId);
    if (participant && participant.socketIds) {
      participant.socketIds.delete(socket.id);

      if (participant.socketIds.size === 0) {
        session.participants.delete(socket.data.participantId);
      }

      broadcastState(session);
    }
  });
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`Real-time quiz app running at http://${displayHost}:${PORT}`);
});

function loadStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(QUIZ_FILE)) {
    fs.writeFileSync(QUIZ_FILE, JSON.stringify({ quizzes: {} }, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(QUIZ_FILE, "utf8"));
    return {
      quizzes: parsed.quizzes || {},
      admins: parsed.admins || {}
    };
  } catch (error) {
    return { quizzes: {}, admins: {} };
  }
}

function saveStore() {
  fs.writeFileSync(QUIZ_FILE, JSON.stringify(store, null, 2));
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);

  if (!adminTokens.has(token)) {
    res.status(401).json({ ok: false, message: "Admin login required." });
    return;
  }

  next();
}

function getBearerToken(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function requireAdminToken(token) {
  if (!adminTokens.has(token)) {
    throw new Error("Admin login required.");
  }
}

function normalizeQuizPayload(payload) {
  const title = cleanText(payload && payload.title, 120);
  const timePerQuestion = Number(payload && payload.timePerQuestion);
  const questions = Array.isArray(payload && payload.questions) ? payload.questions : [];

  if (!title) {
    throw new Error("Quiz title is required.");
  }

  if (!Number.isInteger(timePerQuestion) || timePerQuestion < 5 || timePerQuestion > 120) {
    throw new Error("Time per question must be between 5 and 120 seconds.");
  }

  if (questions.length === 0) {
    throw new Error("Add at least one question.");
  }

  return {
    title,
    timePerQuestion,
    questions: questions.map((question, index) => normalizeQuestion(question, index))
  };
}

function normalizeQuestion(question, index) {
  const text = cleanText(question && question.text, 600);
  const rawOptions = Array.isArray(question && question.options) ? question.options : [];
  const cleanedOptions = rawOptions.map((option) => cleanText(option, 180));
  const options = [];
  const correctIndex = Number(question && question.correctIndex);
  let normalizedCorrectIndex = -1;

  if (!text) {
    throw new Error(`Question ${index + 1} is missing text.`);
  }

  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= rawOptions.length) {
    throw new Error(`Question ${index + 1} needs one correct option.`);
  }

  if (!cleanText(rawOptions[correctIndex], 180)) {
    throw new Error(`Question ${index + 1} has an empty correct option.`);
  }

  cleanedOptions.forEach((option, optionIndex) => {
    if (!option) {
      return;
    }

    if (optionIndex === correctIndex) {
      normalizedCorrectIndex = options.length;
    }

    options.push(option);
  });

  if (options.length < 2) {
    throw new Error(`Question ${index + 1} needs at least two options.`);
  }

  if (normalizedCorrectIndex < 0) {
    throw new Error(`Question ${index + 1} needs one correct option.`);
  }

  return {
    id: crypto.randomUUID(),
    text,
    options,
    correctIndex: normalizedCorrectIndex
  };
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanParticipantId(value) {
  const id = cleanText(value, 80);
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : crypto.randomUUID();
}

function cleanAvatar(value) {
  const avatar = cleanText(value, 24).toLowerCase();
  return AVATAR_KEYS.has(avatar) ? avatar : "blue";
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function createQuizCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = "";
    for (let index = 0; index < 6; index += 1) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
  } while (store.quizzes[code]);

  return code;
}

function getQuizOrThrow(code) {
  const quiz = store.quizzes[code];
  if (!quiz) {
    throw new Error("Quiz not found.");
  }
  return quiz;
}

function getSession(code) {
  let session = sessions.get(code);

  if (!session) {
    session = {
      code,
      status: "waiting",
      currentIndex: -1,
      participants: new Map(),
      answers: new Map(),
      questionStartedAt: null,
      questionEndsAt: null,
      leaderboardEndsAt: null,
      questionTimer: null,
      leaderboardTimer: null
    };
    sessions.set(code, session);
  }

  return session;
}

function resetSessionForNewRun(session) {
  clearSessionTimers(session);
  session.status = "waiting";
  session.currentIndex = -1;
  session.answers = new Map();
  session.questionStartedAt = null;
  session.questionEndsAt = null;
  session.leaderboardEndsAt = null;

  for (const participant of session.participants.values()) {
    participant.score = 0;
  }
}

function clearSessionTimers(session) {
  if (session.questionTimer) {
    clearTimeout(session.questionTimer);
  }
  if (session.leaderboardTimer) {
    clearTimeout(session.leaderboardTimer);
  }
  session.questionTimer = null;
  session.leaderboardTimer = null;
}

function startQuestion(session, index) {
  const quiz = getQuizOrThrow(session.code);

  if (index >= quiz.questions.length) {
    completeQuiz(session);
    return;
  }

  clearSessionTimers(session);
  session.status = "question";
  session.currentIndex = index;
  session.answers = new Map();
  session.questionStartedAt = Date.now();
  session.questionEndsAt = session.questionStartedAt + quiz.timePerQuestion * 1000;
  session.leaderboardEndsAt = null;

  broadcastState(session);

  session.questionTimer = setTimeout(() => finishQuestion(session), quiz.timePerQuestion * 1000 + 150);
}

function finishQuestion(session) {
  if (session.status !== "question") {
    return;
  }

  const quiz = getQuizOrThrow(session.code);
  const question = quiz.questions[session.currentIndex];
  const duration = quiz.timePerQuestion * 1000;

  clearSessionTimers(session);

  for (const [participantId, answer] of session.answers.entries()) {
    const participant = session.participants.get(participantId);
    if (!participant) {
      continue;
    }

    answer.isCorrect = answer.selectedIndex === question.correctIndex;

    if (answer.isCorrect) {
      const elapsed = Math.min(Math.max(answer.submittedAt - session.questionStartedAt, 0), duration);
      const remainingRatio = Math.max(0, (duration - elapsed) / duration);
      answer.bonus = Math.ceil(remainingRatio * 5);
      answer.points = 10 + answer.bonus;
      participant.score += answer.points;
    }
  }

  session.status = "leaderboard";
  session.leaderboardEndsAt = Date.now() + LEADERBOARD_MS;
  broadcastState(session);

  session.leaderboardTimer = setTimeout(() => {
    startQuestion(session, session.currentIndex + 1);
  }, LEADERBOARD_MS);
}

function completeQuiz(session) {
  clearSessionTimers(session);
  session.status = "completed";
  session.currentIndex = getQuizOrThrow(session.code).questions.length;
  session.questionStartedAt = null;
  session.questionEndsAt = null;
  session.leaderboardEndsAt = null;
  session.answers = new Map();
  broadcastState(session);
}

function broadcastState(session) {
  io.to(roomName(session.code)).emit("quiz:state", buildState(session));
}

function buildState(session) {
  const quiz = getQuizOrThrow(session.code);
  const question = quiz.questions[session.currentIndex];
  const state = {
    code: quiz.code,
    title: quiz.title,
    status: session.status,
    currentIndex: session.currentIndex,
    totalQuestions: quiz.questions.length,
    timePerQuestion: quiz.timePerQuestion,
    participantCount: session.participants.size,
    connectedCount: Array.from(session.participants.values()).filter((participant) => {
      return participant.socketIds && participant.socketIds.size > 0;
    }).length,
    leaderboard: getLeaderboard(session),
    serverTime: Date.now()
  };

  if (session.status === "question" && question) {
    state.question = {
      id: question.id,
      number: session.currentIndex + 1,
      total: quiz.questions.length,
      text: question.text,
      options: question.options,
      startedAt: session.questionStartedAt,
      endsAt: session.questionEndsAt
    };
  }

  if (session.status === "leaderboard" && question) {
    state.result = {
      number: session.currentIndex + 1,
      total: quiz.questions.length,
      questionText: question.text,
      options: question.options,
      correctIndex: question.correctIndex,
      correctAnswer: question.options[question.correctIndex],
      answersCount: session.answers.size,
      leaderboardEndsAt: session.leaderboardEndsAt
    };
  }

  return state;
}

function getLeaderboard(session) {
  return Array.from(session.participants.values())
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      avatar: participant.avatar || "blue",
      score: participant.score
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.name.localeCompare(b.name);
    })
    .map((participant, index) => ({
      rank: index + 1,
      id: participant.id,
      name: participant.name,
      avatar: participant.avatar,
      score: participant.score
    }));
}

async function formatAdminQuiz(req, quiz) {
  const link = quizLink(req, quiz.code);
  return {
    ...sanitizeQuizForAdmin(quiz),
    link,
    qrDataUrl: await QRCode.toDataURL(link, {
      margin: 1,
      width: 220,
      color: {
        dark: "#111827",
        light: "#ffffff"
      }
    })
  };
}

async function formatPublicQuiz(req, quiz) {
  return {
    ...sanitizeQuizForParticipant(quiz),
    link: quizLink(req, quiz.code)
  };
}

function sanitizeQuizForAdmin(quiz) {
  return {
    code: quiz.code,
    title: quiz.title,
    timePerQuestion: quiz.timePerQuestion,
    questions: quiz.questions,
    totalQuestions: quiz.questions.length,
    published: quiz.published,
    createdAt: quiz.createdAt,
    updatedAt: quiz.updatedAt
  };
}

function sanitizeQuizForParticipant(quiz) {
  return {
    code: quiz.code,
    title: quiz.title,
    timePerQuestion: quiz.timePerQuestion,
    totalQuestions: quiz.questions.length
  };
}

function quizLink(req, code) {
  const baseUrl = (process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${baseUrl}/?join=${code}`;
}

function roomName(code) {
  return `quiz:${code}`;
}

function handleSocketAction(reply, action) {
  try {
    const response = action();
    if (typeof reply === "function") {
      reply(response);
    }
  } catch (error) {
    if (typeof reply === "function") {
      reply({ ok: false, message: error.message });
    }
  }
}
