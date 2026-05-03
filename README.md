# Real-Time Quiz Application

This is a simple web-based real-time quiz app with:

- Admin login for creating and starting quizzes
- Participant login through quiz code or generated link
- QR code generation for each quiz
- Server-controlled timer per question
- Automatic leaderboard after every question
- 10 points for correct answers plus speed bonus points

## Run

```powershell
npm.cmd install
npm.cmd start
```

Open the app. The server uses `PORT` when your host provides one, or `5000` locally by default:

```text
http://localhost:5000
```

Use **Admin Register** the first time you open the app, then log in with that account.

Quiz definitions and admin accounts are saved in `data/quizzes.json`. That file is ignored by Git so local quiz/admin data is not published.

## Deploy on Render

This repo includes `render.yaml` for a Render web service.

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`
- Runtime: Node.js

On Render, create a new Web Service from your GitHub repo or use Render Blueprints. Every push to the linked branch can automatically redeploy the app.

For participant QR/link generation on a custom domain, optionally add this Render environment variable:

```text
APP_BASE_URL=https://your-domain.example
```

## Deploy From GitHub

```powershell
git init
git add .
git commit -m "Initial deploy-ready quiz app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

Render services have an ephemeral filesystem unless you use a database or a paid persistent disk. This app can run as-is for demos, but saved admins/quizzes can be lost after redeploys on a free service.
