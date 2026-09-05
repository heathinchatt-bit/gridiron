import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin using GitHub secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!Object.keys(serviceAccount).length) {
  console.warn('FIREBASE_SERVICE_ACCOUNT not provided or empty — Firestore reads will likely fail in this run.');
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const COLLECTION = "gridironStore";

async function run() {
  try {
    // 1. Get current week metadata
    const metaDoc = await db.collection(COLLECTION).doc("gp-meta").get();
    if (!metaDoc.exists) return;
    const meta = metaDoc.data().value;
    const currentWeek = meta.currentWeek;
    const targetWeek = currentWeek > 1 ? currentWeek - 1 : currentWeek;

    // 2. Fetch games and check if graded
    const gamesDoc = await db.collection(COLLECTION).doc(`gp-games-${targetWeek}`).get();
    if (!gamesDoc.exists) return;
    const gamesData = gamesDoc.data().value;
    const games = Array.isArray(gamesData) ? gamesData : (gamesData.games || []);

    const gameWinner = (g) => {
      if (g.awayScore == null || g.homeScore == null) return null;
      if (g.awayScore > g.homeScore) return "away";
      if (g.homeScore > g.awayScore) return "home";
      return null;
    };

    const totalGames = games.length;
    const gamesGraded = games.filter((g) => gameWinner(g)).length;
    if (gamesGraded !== totalGames || totalGames === 0) {
      console.log(`Week ${targetWeek} is not fully graded. Skipping email.`);
      return;
    }

    // 3. Fetch participants and picks
    const participantsSnap = await db.collection(COLLECTION).doc("gp-participants").get();
    const participants = participantsSnap.exists ? participantsSnap.data().value : [];
    const picksDoc = await db.collection(COLLECTION).doc(`gp-picks-${targetWeek}`).get();
    const picks = picksDoc.exists ? picksDoc.data().value : {};

    // 4. Calculate scores
    const rows = {};
    participants.forEach(({ name }) => {
      const rec = picks[name] || { locked: false, answers: {} };
      const mine = rec.answers || {};
      let correct = 0;
      let attempted = 0;
      let scoreError = 0;

      games.forEach((g, index) => {
        const winner = gameWinner(g);
        if (!winner) return;
        const p = mine[g.id];
        if (p && p.side) {
          attempted += 1;
          if (p.side === winner) correct += 1;
        }
        if (index === 0) {
          if (p && p.awayScore != null && p.homeScore != null) {
            scoreError += Math.abs(p.awayScore - g.awayScore) + Math.abs(p.homeScore - g.homeScore);
          } else {
            scoreError += 50;
          }
        }
      });
      rows[name] = { correct, attempted, scoreError };
    });

    let best = -1;
    Object.values(rows).forEach((r) => {
      if (r.correct > best) best = r.correct;
    });
    const tied = Object.entries(rows).filter(([, r]) => r.correct === best);
    let winners = [];
    if (tied.length === 1) {
      winners = [tied[0][0]];
    } else if (tied.length > 1) {
      const bestError = Math.min(...tied.map(([, r]) => r.scoreError));
      winners = tied.filter(([, r]) => r.scoreError === bestError).map(([name]) => name);
    }

    const emails = participants.map(p => p.email).filter(Boolean);
    if (emails.length === 0) return;

    let leaderboardText = "";
    Object.entries(rows)
      .sort((a, b) => b[1].correct - a[1].correct || a[1].scoreError - b[1].scoreError)
      .forEach(([name, r], idx) => {
        const pct = r.attempted ? ((r.correct / r.attempted) * 100).toFixed(1) : "0.0";
        leaderboardText += `${idx + 1}. ${name} — ${r.correct}/${r.attempted} correct (${pct}%)\n`;
      });

    // Build email payload (previewable)
    const defaultTo = ['delivered@resend.dev']; // safe test recipient required by Resend until domain verified
    const testRecipient = process.env.TEST_RECIPIENT && process.env.TEST_RECIPIENT.trim() ? process.env.TEST_RECIPIENT.trim() : null;

    const payload = {
      from: 'Gridiron Picks <onboarding@resend.dev>',
      to: testRecipient ? [testRecipient] : defaultTo,
      // only BCC participants when not sending to a single test recipient
      bcc: testRecipient ? [] : emails,
      subject: `Gridiron Picks — Week ${targetWeek} Results & Standings`,
      text:
        `Gridiron Picks Weekly Results - Week ${targetWeek}\n\n` +
        `Week Winner(s): ${winners.length ? winners.join(", ") : "None"}\n\n` +
        `Leaderboard:\n${leaderboardText}`,
      html:
        `<p>Gridiron Picks Weekly Results - Week ${targetWeek}</p>` +
        `<p><strong>Week Winner(s):</strong> ${winners.length ? winners.join(", ") : "None"}</p>` +
        `<pre style="font-family: monospace;">${leaderboardText.replace(/</g, '&lt;')}</pre>`
    };

    // Print preview to logs
    console.log('=== Email payload preview ===');
    console.log(JSON.stringify(payload, null, 2));
    console.log('=== End preview ===');

    const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
    if (dry) {
      console.log('DRY_RUN enabled — skipping actual send.');
      return;
    }

    // 5. Send via Resend API
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    console.log('Email dispatch response:', data);
  } catch (err) {
    console.error('Automation error:', err);
    process.exit(1);
  }
}

run();
