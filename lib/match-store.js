import { neon } from "@neondatabase/serverless";

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|afc|club|football club|town)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function toVerifiedRow(match, sourceNames) {
  const fixture = match?.fixture || {};
  const home = match?.teams?.home || {};
  const away = match?.teams?.away || {};
  const homeGoals = Number(match?.goals?.home);
  const awayGoals = Number(match?.goals?.away);
  const timestamp = Number(fixture.timestamp) || Math.floor(Date.parse(fixture.date || "") / 1000);
  const status = String(fixture.status?.short || "").toUpperCase();

  if (!home.name || !away.name || !Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)
      || homeGoals < 0 || awayGoals < 0 || !timestamp
      || !["FT", "FINISHED", "FULL_TIME", "STATUS_FINAL"].includes(status)) return null;

  const playedAt = new Date(timestamp * 1000).toISOString();
  const homeKey = normalizeName(home.name);
  const awayKey = normalizeName(away.name);
  const fingerprint = [playedAt.slice(0, 10), homeKey, awayKey, homeGoals, awayGoals].join("|");

  return {
    fingerprint,
    providerFixtureId: fixture.id == null ? null : String(fixture.id),
    competition: match.league?.name || null,
    competitionCountry: match.league?.country || null,
    season: match.league?.season == null ? null : String(match.league.season),
    playedAt,
    homeTeam: home.name,
    homeTeamKey: homeKey,
    awayTeam: away.name,
    awayTeamKey: awayKey,
    homeGoals,
    awayGoals,
    sourceNames,
    rawMatch: match,
  };
}

/**
 * Store completed, score-verified match records in G SPORT's own database.
 * Providers supply factual records only; G SPORT calculates all predictions.
 */
export async function saveVerifiedMatches(matches, sourceNames = []) {
  if (!process.env.DATABASE_URL) {
    return { enabled: false, saved: 0, reason: "DATABASE_URL is not configured." };
  }

  const sql = neon(process.env.DATABASE_URL);
  const sources = [...new Set((sourceNames || []).filter(Boolean))];
  const rows = [...new Map((matches || [])
    .map((match) => toVerifiedRow(match, sources))
    .filter(Boolean)
    .map((row) => [row.fingerprint, row])).values()];

  if (!rows.length) return { enabled: true, saved: 0 };

  let saved = 0;
  for (const row of rows) {
    await sql\`
      INSERT INTO verified_matches (
        fingerprint, provider_fixture_id, competition, competition_country, season,
        played_at, home_team, home_team_key, away_team, away_team_key,
        home_goals, away_goals, source_names, raw_match, updated_at
      ) VALUES (
        \${row.fingerprint}, \${row.providerFixtureId}, \${row.competition},
        \${row.competitionCountry}, \${row.season}, \${row.playedAt},
        \${row.homeTeam}, \${row.homeTeamKey}, \${row.awayTeam}, \${row.awayTeamKey},
        \${row.homeGoals}, \${row.awayGoals}, \${JSON.stringify(row.sourceNames)}::jsonb,
        \${JSON.stringify(row.rawMatch)}::jsonb, NOW()
      )
      ON CONFLICT (fingerprint) DO UPDATE SET
        source_names = (
          SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
          FROM jsonb_array_elements(verified_matches.source_names || EXCLUDED.source_names)
        ),
        raw_match = EXCLUDED.raw_match,
        updated_at = NOW()
    \`;
    saved += 1;
  }

  return { enabled: true, saved };
}
