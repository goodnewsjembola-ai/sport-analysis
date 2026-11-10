import { NextResponse } from "next/server";

export const revalidate = 1800;

const BASE = "https://api.goal-api.com/v1";
const NPFL_ID = "cmr77dxdp00urrx06pmkuqz1e";

async function goalApi(path, key) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    next: { revalidate: 1800 },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `GOAL API returned HTTP ${response.status}`);
  }
  return body;
}

function unwrap(body) {
  return body?.data ?? body;
}

function findTeam(teams, wanted) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = normalize(wanted);
  return (Array.isArray(teams) ? teams : []).find((team) => {
    const name = normalize(team?.name || team?.teamName || team?.team_name);
    return name === target || (name.length > 4 && target.length > 4 && (name.includes(target) || target.includes(name)));
  }) || null;
}

export async function GET() {
  const key = process.env.GOAL_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, error: "GOAL_API_KEY is missing from the server environment." }, { status: 503 });
  }

  try {
    const [leagueBody, teamsBody] = await Promise.all([
      goalApi(`/leagues/${NPFL_ID}`, key),
      goalApi(`/leagues/${NPFL_ID}/teams`, key),
    ]);

    const league = unwrap(leagueBody);
    const teamsPayload = unwrap(teamsBody);
    const teams = Array.isArray(teamsPayload) ? teamsPayload : teamsPayload?.teams || teamsPayload?.items || [];
    const home = findTeam(teams, "Sporting Lagos");
    const away = findTeam(teams, "Rivers United");

    const result = {
      ok: true,
      provider: "GOAL API",
      league: {
        id: league?.id || NPFL_ID,
        name: league?.name || league?.leagueName || "Nigeria NPFL",
        country: league?.country || league?.countryName || "Nigeria",
      },
      teamsReturned: teams.length,
      targetTeams: {
        sportingLagos: home ? { id: home.id || home.teamId, name: home.name || home.teamName } : null,
        riversUnited: away ? { id: away.id || away.teamId, name: away.name || away.teamName } : null,
      },
      sampleTeamFields: teams[0] ? Object.keys(teams[0]) : [],
      sampleTeam: teams[0] || null,
    };

    if (home && away) {
      const homeId = home.id || home.teamId;
      const awayId = away.id || away.teamId;
      const [homeResultsBody, awayResultsBody, h2hBody] = await Promise.all([
        goalApi(`/teams/${homeId}/results`, key),
        goalApi(`/teams/${awayId}/results`, key),
        goalApi(`/h2h/${homeId}/${awayId}/direct`, key),
      ]);
      const homeResults = unwrap(homeResultsBody);
      const awayResults = unwrap(awayResultsBody);
      const h2h = unwrap(h2hBody);
      const asArray = (value) => Array.isArray(value) ? value : value?.matches || value?.results || value?.items || [];
      const homeList = asArray(homeResults);
      const awayList = asArray(awayResults);
      const h2hList = asArray(h2h);
      result.recentResults = {
        sportingLagosCount: homeList.length,
        riversUnitedCount: awayList.length,
        sportingLagosSample: homeList.slice(0, 2),
        riversUnitedSample: awayList.slice(0, 2),
      };
      result.headToHead = {
        count: h2hList.length,
        sample: h2hList.slice(0, 3),
      };
    } else {
      result.note = "Both teams were not matched in the current NPFL team list, so team-result and H2H checks were skipped.";
      result.availableTeamNames = teams.map((team) => team?.name || team?.teamName).filter(Boolean);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GOAL API check failed:", error);
    return NextResponse.json({
      ok: false,
      provider: "GOAL API",
      error: error.message || "Provider request failed.",
    }, { status: 502 });
  }
}
