"use client";

import { useEffect, useMemo, useState } from "react";

const markets = ["All markets", "Match result", "Goals", "BTTS", "Corners", "Cards", "Correct score"];

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

export default function Home() {
  const [activeMarket, setActiveMarket] = useState("All markets");
  const [search, setSearch] = useState("");
  const [fixtures, setFixtures] = useState([]);
  const [loadingFixtures, setLoadingFixtures] = useState(true);
  const [fixturesError, setFixturesError] = useState("");
  const [fixtureDate, setFixtureDate] = useState("");
  const [openAnalysis, setOpenAnalysis] = useState(null);
  const [analysisByFixture, setAnalysisByFixture] = useState({});
  const [analysisLoading, setAnalysisLoading] = useState(null);
  const [analysisErrors, setAnalysisErrors] = useState({});

  useEffect(() => {
    let cancelled = false;

    async function loadFixtures() {
      setLoadingFixtures(true);
      setFixturesError("");

      try {
        const response = await fetch("/api/fixtures");
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Fixtures could not be loaded.");
        }

        if (!cancelled) {
          setFixtures(Array.isArray(data.fixtures) ? data.fixtures : []);
          setFixtureDate(data.date || "");
        }
      } catch (error) {
        if (!cancelled) {
          setFixturesError(error.message || "Unable to load fixtures.");
        }
      } finally {
        if (!cancelled) setLoadingFixtures(false);
      }
    }

    loadFixtures();

    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleAnalysis(fixtureId, force = false) {
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
    } catch (error) {
      setAnalysisErrors((current) => ({
        ...current,
        [fixtureId]: error.message || "Unable to load match analysis.",
      }));
    } finally {
      setAnalysisLoading(null);
    }
  }

  const visibleFixtures = useMemo(() => {
    const term = search.trim().toLowerCase();

    return fixtures.filter((fixture) => {
      const home = fixture.teams?.home?.name || "";
      const away = fixture.teams?.away?.name || "";
      const league = fixture.league?.name || "";
      const country = fixture.league?.country || "";

      return `${home} ${away} ${league} ${country}`.toLowerCase().includes(term);
    });
  }, [fixtures, search]);

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

          {!loadingFixtures && !fixturesError && visibleFixtures.map((fixture) => {
            const score = getScore(fixture);
            const fixtureId = fixture.fixture?.id;

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
                  onClick={() => toggleAnalysis(fixtureId)}
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
                          toggleAnalysis(fixtureId, true);
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

          {!loadingFixtures && !fixturesError && visibleFixtures.length === 0 && (
            <p className="empty-state">
              {fixtures.length === 0
                ? "No fixtures were returned for today. Try another date when date selection is added."
                : "No fixtures match that search."}
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
