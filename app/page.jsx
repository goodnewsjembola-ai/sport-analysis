"use client";

import { useEffect, useMemo, useState } from "react";

const markets = ["All markets", "Match result", "Goals", "BTTS", "Corners", "Cards", "Correct score"];

function getLagosToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function formatKickoff(value) {
  if (!value) return "Kick-off time unavailable";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Kick-off time unavailable";

  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Lagos",
  }).format(date);
}

function getStatusLabel(status) {
  const labels = {
    TBD: "Time to be confirmed",
    NS: "Not started",
    "1H": "Live · First half",
    HT: "Half-time",
    "2H": "Live · Second half",
    ET: "Extra time",
    BT: "Break",
    P: "Penalties",
    FT: "Full-time",
    AET: "After extra time",
    PEN: "After penalties",
    PST: "Postponed",
    CANC: "Cancelled",
    ABD: "Abandoned",
    AWD: "Awarded",
    WO: "Walkover",
    SUSP: "Suspended",
    INT: "Interrupted",
  };

  return labels[status] || status || "Status unavailable";
}

function getScore(fixture) {
  const home = fixture.goals?.home;
  const away = fixture.goals?.away;

  if (home === null || home === undefined || away === null || away === undefined) {
    return null;
  }

  return `${home} - ${away}`;
}

function formatProviderLine(value) {
  if (value === null || value === undefined || value === "") return null;

  const text = String(value).trim();
  const match = text.match(/^([+-])\s*(\d+(?:\.\d+)?)$/);

  if (match) {
    return `${match[1] === "+" ? "Over" : "Under"} ${match[2]}`;
  }

  return text;
}

function explainProviderLine(value) {
  if (!value) return "No explanation available";

  const match = String(value).match(/^(Under|Over)\s+(\d+(?:\.\d+)?)$/i);
  if (!match) return "Provider estimate";

  const direction = match[1].toLowerCase();
  const line = Number(match[2]);
  const minimumWholeGoals = Math.floor(line) + 1;

  return direction === "under"
    ? `Fewer than ${minimumWholeGoals} goals`
    : `${minimumWholeGoals} or more goals`;
}

function getConfidence(percent) {
  const values = [percent.home, percent.draw, percent.away].map((value) => {
    if (value === null || value === undefined || value === "") return NaN;
    return Number.parseFloat(String(value).replace("%", "").trim());
  });

  if (values.some((value) => !Number.isFinite(value))) return null;

  const strongest = Math.max(...values);
  const level = strongest >= 70 ? "High" : strongest >= 55 ? "Medium" : "Low";

  return { level, strongest };
}

function formatResultDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    timeZone: "Africa/Lagos",
  }).format(date);
}

function getTeamResult(fixture, teamId) {
  const homeId = fixture.teams?.home?.id;
  const isHome = Number(homeId) === Number(teamId);
  const team = isHome ? fixture.teams?.home : fixture.teams?.away;
  const opponent = isHome ? fixture.teams?.away : fixture.teams?.home;
  const teamGoals = isHome ? fixture.goals?.home : fixture.goals?.away;
  const opponentGoals = isHome ? fixture.goals?.away : fixture.goals?.home;

  if (teamGoals === null || teamGoals === undefined || opponentGoals === null || opponentGoals === undefined) return null;

  const result = teamGoals > opponentGoals ? "W" : teamGoals < opponentGoals ? "L" : "D";
  return {
    result,
    teamName: team?.name || "Team",
    opponent: opponent?.name || "Opponent",
    score: `${teamGoals} - ${opponentGoals}`,
    date: formatResultDate(fixture.fixture?.date),
    homeAway: isHome ? "Home" : "Away",
  };
}

function getHeadToHeadResult(fixture) {
  const homeGoals = fixture.goals?.home;
  const awayGoals = fixture.goals?.away;
  if (homeGoals === null || homeGoals === undefined || awayGoals === null || awayGoals === undefined) return null;
  return {
    home: fixture.teams?.home?.name || "Home",
    away: fixture.teams?.away?.name || "Away",
    score: `${homeGoals} - ${awayGoals}`,
    date: formatResultDate(fixture.fixture?.date),
    result: homeGoals > awayGoals ? "Home win" : homeGoals < awayGoals ? "Away win" : "Draw",
  };
}

export default function Home() {
  const [activeMarket, setActiveMarket] = useState("All markets");
  const [search, setSearch] = useState("");
  const [fixtures, setFixtures] = useState([]);
  const [loadingFixtures, setLoadingFixtures] = useState(true);
  const [fixturesError, setFixturesError] = useState("");
  const [fixtureDate, setFixtureDate] = useState("");
  const [selectedDate, setSelectedDate] = useState(() => getLagosToday());
  const [selectedLeague, setSelectedLeague] = useState("All leagues");
  const [openAnalysis, setOpenAnalysis] = useState(null);
  const [analysisByFixture, setAnalysisByFixture] = useState({});
  const [analysisLoading, setAnalysisLoading] = useState(null);
  const [analysisErrors, setAnalysisErrors] = useState({});
  const [formByFixture, setFormByFixture] = useState({});
  const [formLoading, setFormLoading] = useState(null);
  const [formErrors, setFormErrors] = useState({});

  useEffect(() => {
    let cancelled = false;

    async function loadFixtures() {
      setLoadingFixtures(true);
      setFixturesError("");

      try {
        const response = await fetch("/api/fixtures?date=" + encodeURIComponent(selectedDate));
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Fixtures could not be loaded.");
        }

        if (!cancelled) {
          setFixtures(Array.isArray(data.fixtures) ? data.fixtures : []);
          setFixtureDate(data.date || selectedDate);
          setOpenAnalysis(null);
        }
      } catch (error) {
        if (!cancelled) {
          setFixturesError(error.message || "Unable to load fixtures.");
          setFixtures([]);
        }
      } finally {
        if (!cancelled) setLoadingFixtures(false);
      }
    }

    if (selectedDate) loadFixtures();

    return () => { cancelled = true; };
  }, [selectedDate]);

  async function toggleAnalysis(fixtureId, force = false, homeId = null, awayId = null, season = null, homeName = "", awayName = "", leagueName = "") {
    if (!fixtureId) return;

    if (openAnalysis === fixtureId && !force) {
      setOpenAnalysis(null);
      return;
    }

    setOpenAnalysis(fixtureId);
    if (analysisByFixture[fixtureId]) return;

    setAnalysisLoading(fixtureId);
    setAnalysisErrors((current) => ({ ...current, [fixtureId]: "" }));

    try {
      const response = await fetch(`/api/predictions?fixture=${fixtureId}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Match analysis could not be loaded.");
      }

      const result = data.predictions?.[0] || null;
      if (!result) {
        throw new Error("No prediction is available for this fixture yet.");
      }

      setAnalysisByFixture((current) => ({ ...current, [fixtureId]: result }));

      if (homeId && awayId) {
        setFormLoading(fixtureId);
        setFormErrors((current) => ({ ...current, [fixtureId]: "" }));
        try {
          const formParams = new URLSearchParams({
            homeName: String(homeName || ""),
            awayName: String(awayName || ""),
            league: String(leagueName || ""),
          });
          const formResponse = await fetch(`/api/team-form?${formParams.toString()}`);
          const formData = await formResponse.json();
          if (!formResponse.ok) {
            const details = Array.isArray(formData.details) ? formData.details.join(" · ") : "";
            throw new Error([formData.error || "Recent form could not be loaded.", details].filter(Boolean).join(" — "));
          }
          setFormByFixture((current) => ({ ...current, [fixtureId]: formData }));
        } catch (formError) {
          setFormErrors((current) => ({
            ...current,
            [fixtureId]: formError.message || "Unable to load recent form.",
          }));
        } finally {
          setFormLoading(null);
        }
      }
    } catch (error) {
      setAnalysisErrors((current) => ({
        ...current,
        [fixtureId]: error.message || "Unable to load match analysis.",
      }));
    } finally {
      setAnalysisLoading(null);
    }
  }

  const availableLeagues = useMemo(() => {
    const names = fixtures.map((fixture) => {
      const name = fixture.league?.name || "Other competitions";
      const country = fixture.league?.country || "";
      return country ? name + " · " + country : name;
    });
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }, [fixtures]);

  const visibleFixtures = useMemo(() => {
    const term = search.trim().toLowerCase();
    return fixtures.filter((fixture) => {
      const home = fixture.teams?.home?.name || "";
      const away = fixture.teams?.away?.name || "";
      const league = fixture.league?.name || "Other competitions";
      const country = fixture.league?.country || "";
      const leagueLabel = country ? league + " · " + country : league;
      const matchesSearch = (home + ' ' + away + ' ' + league + ' ' + country).toLowerCase().includes(term);
      const matchesLeague = selectedLeague === "All leagues" || leagueLabel === selectedLeague;
      return matchesSearch && matchesLeague;
    });
  }, [fixtures, search, selectedLeague]);

  const groupedFixtures = useMemo(() => {
    const groups = new Map();
    visibleFixtures.forEach((fixture) => {
      const name = fixture.league?.name || "Other competitions";
      const country = fixture.league?.country || "";
      const label = country ? name + " · " + country : name;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(fixture);
    });
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visibleFixtures]);

  return (
    <main>
      <div className="announcement">
        <span className="live-dot" /> FOOTBALL INTELLIGENCE. DATA-DRIVEN PREDICTIONS.
      </div>

      <header className="site-header">
        <a className="brand" href="#" aria-label="G Sport Analysis home">
          <span className="brand-mark">G</span>
          <span className="brand-name">G SPORT <b>ANALYSIS</b></span>
        </a>
        <nav>
          <a className="active" href="#matches">Matches</a>
          <a href="#markets">Markets</a>
          <a href="#method">Our method</a>
        </nav>
        <a className="header-cta" href="#matches">Explore analysis <span>↗</span></a>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span /> THE GAME, UNDERSTOOD</p>
          <h1>See beyond<br />the <em>scoreline.</em></h1>
          <p className="hero-description">
            Clear football insights powered by match data, team performance
            and statistical analysis. Make sense of the numbers before kick-off.
          </p>
          <div className="hero-actions">
            <a className="gold-button" href="#matches">Explore match analysis <span>↗</span></a>
            <a className="text-button" href="#method">How it works <span>↓</span></a>
          </div>
          <div className="hero-note"><span className="shield">✓</span> Free access · Transparent probabilities · No guaranteed outcomes</div>
        </div>
        <div className="hero-art" aria-label="Abstract football pitch graphic">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="pitch">
            <div className="pitch-line center-line" />
            <div className="center-circle" />
            <div className="pitch-box left-box" />
            <div className="pitch-box right-box" />
            <div className="pitch-dot" />
          </div>
          <div className="art-label label-top"><span className="mini-dot" /> DATA IN FOCUS</div>
          <div className="art-label label-bottom">ANALYSE THE GAME <b>01 / 90</b></div>
          <div className="floating-stat"><small>THE G SPORT APPROACH</small><strong>DATA <i>×</i> INSIGHT</strong><span>Every match has a story.</span></div>
        </div>
      </section>

      <section className="trust-strip">
        <div><strong>01</strong><span>Match intelligence</span></div>
        <div><strong>02</strong><span>Multiple prediction markets</span></div>
        <div><strong>03</strong><span>Worldwide coverage</span></div>
        <div><strong>04</strong><span>Free for everyone</span></div>
      </section>

      <section className="matches-section" id="matches">
        <div className="section-heading">
          <div><p className="eyebrow"><span /> YOUR DAILY FOOTBALL DESK</p><h2>Match <em>centre.</em></h2></div>
          <span className="section-date">{fixtureDate ? `FIXTURES · ${fixtureDate}` : "FIXTURES & ANALYSIS"}</span>
        </div>

        <div className="fixture-controls">
          <label className="fixture-control">
            <span>CHOOSE DATE</span>
            <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} aria-label="Choose fixture date" />
          </label>
          <label className="fixture-control">
            <span>CHOOSE LEAGUE</span>
            <select value={selectedLeague} onChange={(event) => setSelectedLeague(event.target.value)} aria-label="Filter fixtures by league">
              <option value="All leagues">All leagues</option>
              {availableLeagues.map((league) => <option key={league} value={league}>{league}</option>)}
            </select>
          </label>
        </div>

        <div className="match-toolbar">
          <div className="market-tabs" id="markets">
            {markets.map((market) => (
              <button key={market} className={activeMarket === market ? "selected" : ""} onClick={() => setActiveMarket(market)}>
                {market}
              </button>
            ))}
          </div>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search team or competition" aria-label="Search team or competition" />
        </div>

        <div className="match-list">
          {loadingFixtures && <p className="empty-state">Loading today's fixtures...</p>}

          {!loadingFixtures && fixturesError && (
            <div className="empty-state">
              <p>{fixturesError}</p>
              <p>Check the server API key configuration and try again later.</p>
            </div>
          )}

          {!loadingFixtures && !fixturesError && groupedFixtures.map(([leagueGroup, leagueFixtures]) => (
            <section className="league-group" key={leagueGroup}>
              <div className="league-group-heading">
                <h3>{leagueGroup}</h3>
                <span>{leagueFixtures.length} {leagueFixtures.length === 1 ? "MATCH" : "MATCHES"}</span>
              </div>
              {leagueFixtures.map((fixture) => {
            const score = getScore(fixture);
            const fixtureId = fixture.fixture?.id;
            const homeTeamId = fixture.teams?.home?.id;
            const awayTeamId = fixture.teams?.away?.id;
            const homeTeamName = fixture.teams?.home?.name || "Home team";
            const awayTeamName = fixture.teams?.away?.name || "Away team";

            return (
              <article className="match-card" key={fixtureId}>
                <div className="league-label">
                  <span className="league-icon">◈</span>
                  {fixture.league?.name || "Competition"}
                  {fixture.league?.country ? ` · ${fixture.league.country}` : ""}
                </div>
                <div className="teams">
                  <strong>{fixture.teams?.home?.name || "Home team"}</strong>
                  <span className="versus">{score || "VS"}</span>
                  <strong>{fixture.teams?.away?.name || "Away team"}</strong>
                </div>
                <div className="match-time">{formatKickoff(fixture.fixture?.date)}</div>
                <div className="match-status">{getStatusLabel(fixture.fixture?.status?.short)}</div>
                <button
                  className="analysis-button"
                  onClick={() => toggleAnalysis(fixtureId, false, fixture.teams?.home?.id, fixture.teams?.away?.id, fixture.league?.season, fixture.teams?.home?.name, fixture.teams?.away?.name, fixture.league?.name)}
                  aria-expanded={openAnalysis === fixtureId}
                >
                  {openAnalysis === fixtureId ? "Close analysis" : "View analysis"} <span>↗</span>
                </button>
                {openAnalysis === fixtureId && (
                  <div className="prediction-panel">
                    {analysisLoading === fixtureId && <p className="prediction-message">Preparing match analysis...</p>}
                    {analysisErrors[fixtureId] && (
                      <div className="prediction-message prediction-error">
                        <p>{analysisErrors[fixtureId]}</p>
                        <button onClick={() => {
                          setAnalysisByFixture((current) => {
                            const next = { ...current };
                            delete next[fixtureId];
                            return next;
                          });
                          setFormByFixture((current) => {
                            const next = { ...current };
                            delete next[fixtureId];
                            return next;
                          });
                          toggleAnalysis(fixtureId, true, fixture.teams?.home?.id, fixture.teams?.away?.id, fixture.league?.season, fixture.teams?.home?.name, fixture.teams?.away?.name, fixture.league?.name);
                        }}>Try again</button>
                      </div>
                    )}
                    {analysisByFixture[fixtureId] && (() => {
                      const item = analysisByFixture[fixtureId];
                      const prediction = item.predictions || {};
                      const percent = prediction.percent || {};
                      const goals = prediction.goals || {};
                      const homeGoals = formatProviderLine(goals.home);
                      const awayGoals = formatProviderLine(goals.away);
                      const goalsMarket = formatProviderLine(prediction.under_over);
                      const winner = prediction.winner || {};
                      return (
                        <div className="prediction-content">
                          <div className="prediction-heading">
                            <div>
                              <span className="prediction-kicker">PROVIDER MATCH PREDICTION</span>
                              <h3>Match intelligence</h3>
                            </div>
                            <span className="provider-tag">API-FOOTBALL</span>
                          </div>
                          <div className="prediction-stats">
                            <div className="prediction-stat">
                              <small>HOME WIN</small>
                              <strong>{percent.home || "—"}</strong>
                            </div>
                            <div className="prediction-stat">
                              <small>DRAW</small>
                              <strong>{percent.draw || "—"}</strong>
                            </div>
                            <div className="prediction-stat">
                              <small>AWAY WIN</small>
                              <strong>{percent.away || "—"}</strong>
                            </div>
                          </div>
                          <section className="probability-chart" aria-label="Home win, draw and away win probability comparison">
                            <div className="probability-chart-heading">
                              <div><small>1X2 PROBABILITY</small><strong>Outcome comparison</strong></div>
                              <span>PROVIDER DATA</span>
                            </div>
                            {[
                              ["Home win", percent.home, "home"],
                              ["Draw", percent.draw, "draw"],
                              ["Away win", percent.away, "away"],
                            ].map(([label, rawValue, type]) => {
                              const numericValue = Number.parseFloat(String(rawValue ?? "").replace("%", "").trim());
                              const valid = Number.isFinite(numericValue) && numericValue >= 0;
                              const value = valid ? Math.min(100, numericValue) : 0;
                              return (
                                <div className="probability-row" key={type}>
                                  <div className="probability-label"><span>{label}</span><strong>{valid ? `${numericValue}%` : "—"}</strong></div>
                                  <div className="probability-track">
                                    {valid && <span className={`probability-fill probability-${type}`} style={{ width: `${value}%` }} />}
                                  </div>
                                </div>
                              );
                            })}
                            <p>Percentages are the provider's estimated probabilities for the three match outcomes.</p>
                          </section>
                          {(() => {
                            const confidence = getConfidence(percent);
                            return (
                              <section className={`confidence-card ${confidence ? `confidence-${confidence.level.toLowerCase()}` : "confidence-unavailable"}`} aria-label="Match probability strength">
                                <div className="confidence-topline">
                                  <div><small>G SPORT INDICATOR</small><strong>Match confidence</strong></div>
                                  <span className="confidence-level">{confidence ? confidence.level.toUpperCase() : "UNAVAILABLE"}</span>
                                </div>
                                {confidence && (
                                  <div className="confidence-meter" role="img" aria-label={`Strongest outcome probability ${confidence.strongest}%`}>
                                    <span style={{ width: `${Math.max(0, Math.min(100, confidence.strongest))}%` }} />
                                  </div>
                                )}
                                <p>{confidence
                                  ? `Strongest outcome probability: ${confidence.strongest}%. This is a simple G Sport rating based on the provider's 1X2 percentages.`
                                  : "The provider has not supplied enough 1X2 probability data to calculate this indicator."}</p>
                              </section>
                            );
                          })()}
                          <div className="prediction-details">
                            <div className="prediction-detail-card"><small>Predicted winner</small><strong>{winner.name || "No clear favourite"}</strong>{winner.comment && <span>{winner.comment}</span>}</div>
                            <div className="prediction-detail-card"><small>Goals market</small><strong>{goalsMarket || "Not available"}</strong><span>Provider estimate</span></div>
                          </div>
                          <section className="team-goals-section" aria-label="Team goals estimates">
                            <div className="team-goals-heading">
                              <div><span className="goals-heading-mark">02</span><div><small>GOALS BREAKDOWN</small><h4>Team goals <em>estimates.</em></h4></div></div>
                              <span className="provider-estimate-label">PROVIDER DATA</span>
                            </div>
                            <div className="team-goals-grid">
                              <div className="team-goal-tile">
                                <span className="team-goal-side"><i className="team-goal-dot home-dot" /> HOME TEAM</span>
                                <strong>{homeGoals || "Not available"}</strong>
                                <span className="team-goal-caption">Home scoring estimate</span>
                                <span className="team-goal-explanation">{explainProviderLine(homeGoals)}</span>
                              </div>
                              <div className="team-goal-tile">
                                <span className="team-goal-side"><i className="team-goal-dot away-dot" /> AWAY TEAM</span>
                                <strong>{awayGoals || "Not available"}</strong>
                                <span className="team-goal-caption">Away scoring estimate</span>
                                <span className="team-goal-explanation">{explainProviderLine(awayGoals)}</span>
                              </div>
                            </div>
                          </section>

                          <section className="form-section" aria-label="Recent form and head to head">
                            <div className="form-section-heading">
                              <div><small>TEAM PERFORMANCE</small><h4>Recent form <em>& history.</em></h4></div>
                              <span>LAST 5 MATCHES</span>
                            </div>
                            {formLoading === fixtureId && <p className="form-message">Loading recent results and previous meetings...</p>}
                            {formErrors[fixtureId] && <div className="form-message form-error"><p>{formErrors[fixtureId]}</p>{formErrors[fixtureId].details?.map((detail, index) => <small key={index}>{detail}</small>)}</div>}
                            {formByFixture[fixtureId]?.formNotice && (
                              <p className="form-message">{formByFixture[fixtureId].formNotice}</p>
                            )}
                            {formByFixture[fixtureId]?.warnings?.length > 0 && (
                              <p className="form-message">Some recent-form information could not be retrieved. Available results are shown below.</p>
                            )}
                            {formByFixture[fixtureId] && (() => {
                              const form = formByFixture[fixtureId];
                              const homeResults = (form.homeRecent || []).map((match) => getTeamResult(match, homeTeamId)).filter(Boolean);
                              const awayResults = (form.awayRecent || []).map((match) => getTeamResult(match, awayTeamId)).filter(Boolean);
                              const meetings = (form.headToHead || []).map(getHeadToHeadResult).filter(Boolean);
                              const renderTeamForm = (name, results) => (
                                <div className="form-team-card">
                                  <h5>{name}</h5>
                                  {results.length ? (
                                    <div className="form-results">
                                      {results.map((match, index) => (
                                        <div className="form-result-row" key={`${match.date}-${index}`}>
                                          <span className={`form-result-badge result-${match.result.toLowerCase()}`}>{match.result}</span>
                                          <span className="form-opponent">{match.opponent}<small>{match.homeAway} · {match.date}</small></span>
                                          <strong>{match.score}</strong>
                                        </div>
                                      ))}
                                    </div>
                                  ) : <p className="form-message">No completed recent matches available.</p>}
                                </div>
                              );
                              return (
                                <>
                                  <div className="form-teams-grid">
                                    {renderTeamForm(homeTeamName, homeResults)}
                                    {renderTeamForm(awayTeamName, awayResults)}
                                  </div>
                                  <div className="h2h-block">
                                    <div className="h2h-title"><strong>Head-to-head</strong><span>PREVIOUS MEETINGS</span></div>
                                    {meetings.length ? meetings.map((meeting, index) => (
                                      <div className="h2h-row" key={`${meeting.date}-${index}`}>
                                        <span>{meeting.date}</span><strong>{meeting.home} <em>{meeting.score}</em> {meeting.away}</strong><small>{meeting.result}</small>
                                      </div>
                                    )) : <p className="form-message">No previous meetings found in the provider's data.</p>}
                                  </div>
                                </>
                              );
                            })()}
                          </section>
                          {prediction.advice && <p className="prediction-advice"><b>Provider advice:</b> {prediction.advice}</p>}
                          <p className="prediction-disclaimer">These are third-party statistical estimates, not guaranteed results. Availability and detail depend on the provider's data for this match.</p>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </article>
            );
          })}
            </section>
          ))}

          {!loadingFixtures && !fixturesError && visibleFixtures.length === 0 && (
            <p className="empty-state">
              {fixtures.length === 0
                ? 'No fixtures were found for ' + selectedDate + '. Choose another date to see that day’s matches.'
                : "No matches match your search or selected league. Try clearing the search or choosing All leagues."}
            </p>
          )}
        </div>
        <p className="data-notice">
          Live fixture data and match predictions are supplied by API-Football and displayed in Lagos time. Predictions are estimates, not guarantees.
        </p>
      </section>

      <section className="markets-section">
        <div className="section-heading">
          <div><p className="eyebrow"><span /> MORE THAN THE FINAL RESULT</p><h2>Explore the <em>markets.</em></h2></div>
          <p className="heading-aside">A wider view of the game, supported by available match data.</p>
        </div>
        <div className="market-grid">
          {[
            ["01", "Match result", "Home win, draw or away win."],
            ["02", "Goals", "Goal lines and scoring trends."],
            ["03", "Both teams to score", "Scoring patterns for both sides."],
            ["04", "Correct score", "Statistical scoreline probabilities."],
            ["05", "Corners", "Team and match corner trends."],
            ["06", "Cards", "Disciplinary and card patterns."]
          ].map(([number, title, description]) => (
            <div className="market-card" key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p><b>↗</b></div>
          ))}
        </div>
      </section>

      <section className="method-section" id="method">
        <div><p className="eyebrow"><span /> BUILT ON EVIDENCE</p><h2>Numbers first.<br /><em>Hype last.</em></h2></div>
        <div className="method-copy">
          <p>G SPORT ANALYSIS is being built to turn football data into understandable match insights. Our aim is to explain the factors behind each probability, not simply publish a prediction.</p>
          <div className="method-points"><span>01 / Team form & performance</span><span>02 / Match statistics & trends</span><span>03 / Probability-led predictions</span><span>04 / Results and accuracy tracking</span></div>
        </div>
      </section>

      <footer>
        <a className="brand" href="#"><span className="brand-mark">G</span><span className="brand-name">G SPORT <b>ANALYSIS</b></span></a>
        <p>Football intelligence. Made accessible.</p>
        <span className="footer-note">Predictions are estimates, not guarantees. Please enjoy football responsibly.</span>
        <small>© {new Date().getFullYear()} G SPORT ANALYSIS</small>
      </footer>
    </main>
  );
}
