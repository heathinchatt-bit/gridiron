import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin using GitHub secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const COLLECTION = "gridironStore";

async function run() {
  try {
    // 1. Get current week metadata
    const metaDoc = await db.collection(COLLECTION).doc("gp-meta").get();
    if (!metaDoc.exists) {
      console.log("Meta document not found.");
      return;
    }
    const meta = metaDoc.data().value;
    const currentWeek = meta.currentWeek;
    const targetWeek = currentWeek > 1 ? currentWeek - 1 : currentWeek;
    console.log(`Processing Week ${targetWeek} (Current week is ${currentWeek})...`);

    // 2. Fetch games from Firestore
    const gamesDocRef = db.collection(COLLECTION).doc(`gp-games-${targetWeek}`);
    const gamesDoc = await gamesDocRef.get();
    if (!gamesDoc.exists) {
      console.log(`Games document gp-games-${targetWeek} not found.`);
      return;
    }
    const gamesData = gamesDoc.data().value;
    let games = Array.isArray(gamesData) ? gamesData : (gamesData.games || []);

    // 3. Automatically fetch latest scores from ESPN API
    try {
      console.log(`Fetching latest scores from ESPN for Week ${targetWeek}...`);
      const espnRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?week=${targetWeek}&seasontype=2&limit=300`);
      const espnData = await espnRes.json();
      
      if (espnData && espnData.events) {
        let scoresUpdated = false;
        
        games = games.map(game => {
          const matchingEvent = espnData.events.find(event => {
            const competition = event.competitions[0];
            const homeCompetitor = competition.competitors.find(c => c.homeAway === 'home');
            const awayCompetitor = competition.competitors.find(c => c.homeAway === 'away');
            
            const homeName = homeCompetitor.team.displayName.toLowerCase();
            const awayName = awayCompetitor.team.displayName.toLowerCase();
            const homeShort = homeCompetitor.team.shortDisplayName.toLowerCase();
            const awayShort = awayCompetitor.team.shortDisplayName.toLowerCase();
            
            const gHome = (game.homeTeam || "").toLowerCase();
            const gAway = (game.awayTeam || "").toLowerCase();
            
            return (gHome.includes(homeName) || homeName.includes(gHome) || gHome.includes(homeShort)) &&
                   (gAway.includes(awayName) || awayName.includes(gAway) || gAway.includes(awayShort));
          });

          if (matchingEvent) {
            const competition = matchingEvent.competitions[0];
            const homeCompetitor = competition.competitors.find(c => c.homeAway === 'home');
            const awayCompetitor = competition.competitors.find(c => c.homeAway === 'away');
            
            const homeScore = parseInt(homeCompetitor.score, 10);
            const awayScore = parseInt(awayCompetitor.score, 10);
            const isFinal = competition.status.type.completed;

            if (!isNaN(homeScore) && !isNaN(awayScore) && (isFinal || homeScore > 0 || awayScore > 0)) {
              if (game.homeScore !== homeScore || game.awayScore !== awayScore) {
                game.homeScore = homeScore;
                game.awayScore = awayScore;
                scoresUpdated = true;
              }
            }
          }
          return game;
        });

        if (scoresUpdated) {
          const updatedValue = Array.isArray(gamesData) ? games : { ...gamesData, games };
          await gamesDocRef.set({ value: updatedValue }, { merge: true });
          console.log("Successfully synced latest ESPN scores to Firestore.");
        }
      }
    } catch (espnErr) {
      console.warn("Could not fetch from ESPN API, falling back to existing Firestore scores:", espnErr.message);
    }

    // 4. Verify if target week is fully graded
    const gameWinner = (g) => {
      if (g.awayScore == null || g.homeScore == null || isNaN(g.awayScore) || isNaN(g.homeScore)) return null;
      if (g.awayScore > g.homeScore) return "away";
      if (g.homeScore > g.awayScore) return "home";
      return null;
    };

    const totalGames = games.length;
    const gamesGraded = games.filter((g) => gameWinner(g)).length;
    console.log(`Graded games: ${gamesGraded}/${totalGames}`);
    
    if (gamesGraded !== totalGames || totalGames === 0) {
      console.log(`Week ${targetWeek} is not fully graded yet. Skipping email.`);
      return;
    }

    // 5. Fetch participants and picks
    const participantsSnap = await db.collection(COLLECTION).doc("gp-participants").get();
    const participants = participantsSnap.exists ? participantsSnap.data().value : [];
    
    const picksDoc = await db.collection(COLLECTION).doc(`gp-picks-${targetWeek}`).get();
    const picks = picksDoc.exists ? picksDoc.data().value : {};

    // 6. Calculate scores and determine winner(s)
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
            scoreError += Math.abs(Number(p.awayScore) - Number(g.awayScore)) + Math.abs(Number(p.homeScore) - Number(g.homeScore));
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
    if (emails.length === 0) {
      console.log("No recipient emails found.");
      return;
    }

    let leaderboardText = "";
    Object.entries(rows)
      .sort((a, b) => b[1].correct - a[1].correct || a[1].scoreError - b[1].scoreError)
      .forEach(([name, r], idx) => {
        const pct = r.attempted ? ((r.correct / r.attempted) * 100).toFixed(1) : "0.0";
        leaderboardText += `${idx + 1}. ${name} — ${r.correct}/${r.attempted} correct (${pct}%)\n`;
      });

    // 7. Send via Resend API
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'Gridiron Picks <onboarding@resend.dev>',
        to: ['delivered@resend.dev'], // Switch to participants when your domain is verified in Resend
        bcc: emails,
        subject: `Gridiron Picks — Week ${targetWeek} Results & Standings`,
        text: `Gridiron Picks Weekly Results - Week ${targetWeek}\n\n` +
              `Week Winner(s): ${winners.length ? winners.join(", ") : "None"}\n\n` +
              `Leaderboard:\n${leaderboardText}`
      })
    });

    const data = await res.json();
    console.log("Email dispatch response:", data);
  } catch (err) {
    console.error("Automation error:", err);
    process.exit(1);
  }
}

run();
