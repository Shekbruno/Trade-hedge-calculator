(() => {
  "use strict";

  /*
    PROP + HEDGE CALCULATOR — V2 CORE ENGINE

    Core rules:
    1. Static maximum DD is measured from the original account balance.
    2. Previous losses reduce the remaining DD room.
    3. Previous profits DO NOT reset the static DD ceiling.
       Example:
         Start = $6,000
         Static DD = 10%
         Current P&L = -1%
         Remaining overall loss room = 9%.
         Current P&L = +2%
         Remaining loss room = 12%.
    4. Daily loss limit = 5%.
    5. Effective loss room for a trade = min(daily remaining room,
       overall remaining room).
    6. Once a branch becomes invalid, that branch terminates immediately.
    7. Hedge is a separate recovery ledger. Hedge has no prop DD rule.
    8. Hedge capital/recovery is tracked independently from Prop P&L.
  */

  const $ = (id) => document.getElementById(id);
  const qa = (selector) => [...document.querySelectorAll(selector)];

  let scenarios = [];
  let selectedScenario = null;

  const IDS = [
    "account",
    "risk",
    "p1",
    "p2",
    "daily",
    "maxdd",
    "rr",
    "maxTrades",
    "fee",
    "hedgePerPct",
    "hedgePerLot",
    "share",
    "reward",
    "securePct"
  ];

  function getConfig() {
    const c = {};

    IDS.forEach((id) => {
      const el = $(id);
      if (!el) return;

      if (el.tagName === "SELECT") {
        c[id] = parseFloat(el.value);
      } else {
        c[id] = parseFloat(el.value);
      }
    });

    return c;
  }

  function money(value) {
    return "$" + Number(value || 0).toFixed(2);
  }

  function rrText(rr) {
    return "1:" + Number(rr).toFixed(2).replace(/\.00$/, "");
  }

  function validConfig(c) {
    if (!(c.account > 0)) return false;
    if (!(c.risk > 0)) return false;
    if (!(c.p1 > 0)) return false;
    if (!(c.p2 > 0)) return false;
    if (!(c.daily > 0)) return false;
    if (!(c.maxdd > 0)) return false;

    // Static DD must not be smaller than daily limit in this model.
    if (c.maxdd < c.daily) return false;

    if (!(c.rr > 0)) return false;
    if (!(c.maxTrades >= 1 && c.maxTrades <= 12)) return false;

    if (!(c.fee >= 0)) return false;
    if (!(c.hedgePerPct >= 0)) return false;
    if (!(c.hedgePerLot > 0)) return false;

    if (!(c.share >= 0 && c.share <= 100)) return false;
    if (!(c.reward >= 0)) return false;
    if (!(c.securePct >= 0)) return false;

    return true;
  }

  /*
    Convert percentages into R.

    Example:
      Risk = 1%
      10% DD = 10R
      5% daily = 5R
  */
  function ruleValues(c) {
    return {
      riskPct: c.risk,
      oneR: c.account * (c.risk / 100),

      phase1R: c.p1 / c.risk,
      phase2R: c.p2 / c.risk,

      dailyLossR: c.daily / c.risk,
      maxDrawdownR: c.maxdd / c.risk
    };
  }

  /*
    STATIC DD LOGIC

    The static DD floor never moves upward.

    Starting balance = account
    DD floor = account - maxDD amount

    If current prop P&L is -1%:
      remaining loss room = 10% - 1% = 9%

    If current prop P&L is +2%:
      remaining loss room = 10% + 2% = 12%

    But daily loss can still limit a single day to 5%.
  */
  function remainingOverallLossR(currentR, rules) {
    return rules.maxDrawdownR + currentR;
  }

  function effectiveLossRoomR(currentR, currentDayR, rules) {
    const overallRemaining = remainingOverallLossR(currentR, rules);

    const dailyRemaining = rules.dailyLossR + currentDayR;

    return Math.min(overallRemaining, dailyRemaining);
  }

  function violatesLossRules(nextR, nextDayR, rules) {
    const overallRemainingAfterTrade =
      rules.maxDrawdownR + nextR;

    const dailyRemainingAfterTrade =
      rules.dailyLossR + nextDayR;

    return (
      overallRemainingAfterTrade <= 0 ||
      dailyRemainingAfterTrade <= 0
    );
  }

  /*
    Hedge model

    Important:
    We deliberately keep hedge separate from Prop DD.

    The hedge side does NOT have the 5% / 10% prop DD rules.

    Current hedge allocation:
      initial hedge capital
      + recovery allocation from previous hedge profit

    The existing UI gives us:
      fee
      hedgePerPct
      hedgePerLot

    We use hedgePerPct as the configurable synchronization
    factor for positive prop progress.

    Exact broker-side hedge P&L is NOT assumed.
  */
  function calculateHedgeState(c, previousHedgeProfit, propR) {
    const initialCapital = c.fee;

    /*
      Recovery allocation from previous hedge profit.

      V2 uses the entire previously realized hedge profit
      as available recovery capital.

      If later you want only e.g. 30%, 50%, etc.,
      we can add a dedicated input without changing
      the Prop engine.
    */
    const recoveryAllocation = Math.max(
      0,
      previousHedgeProfit
    );

    const baseAllocation =
      initialCapital + recoveryAllocation;

    /*
      Additional synchronization amount based on
      positive prop progress.

      This is NOT counted as Prop P&L.
    */
    const progressPct = Math.max(
      0,
      propR * c.risk
    );

    const synchronizedAmount =
      progressPct * c.hedgePerPct;

    const hedgeCapitalRequired =
      Math.max(
        baseAllocation,
        initialCapital + synchronizedAmount
      );

    const hedgeLot =
      hedgeCapitalRequired / c.hedgePerLot;

    return {
      initialCapital,
      recoveryAllocation,
      progressPct,
      synchronizedAmount,
      hedgeCapitalRequired,
      hedgeLot
    };
  }

  /*
    Build one scenario branch.

    Each branch is evaluated trade-by-trade.

    W = +RR
    L = -1R

    If invalid:
      immediately record the branch
      DO NOT generate further children.
  */
  function buildScenarios(c) {
    const rules = ruleValues(c);
    const results = [];

    function walk({
      path,
      stage,
      currentR,
      dayR,
      trades,
      hedgeProfit,
      hedgeInvested,
      hedgeRecovered,
      events
    }) {

      /*
        FUNDED = terminal state.
      */
      if (stage === 3) {
        results.push({
          path,
          stage: "FUNDED",
          status: "FUNDED",
          r: currentR,
          trades,
          hedgeProfit,
          hedgeInvested,
          hedgeRecovered,
          events
        });

        return;
      }

      /*
        Trade horizon reached before target.
      */
      if (trades.length >= c.maxTrades) {
        results.push({
          path,
          stage:
            stage === 1
              ? "Phase 1"
              : "Phase 2",
          status: "HORIZON",
          r: currentR,
          trades,
          hedgeProfit,
          hedgeInvested,
          hedgeRecovered,
          events
        });

        return;
      }

      /*
        Generate only two immediate children.
        Each child is validated before recursion.
      */
      ["W", "L"].forEach((result) => {

        const tradeNumber = trades.length + 1;

        const tradeR =
          result === "W"
            ? c.rr
            : -1;

        const nextR =
          currentR + tradeR;

        const nextDayR =
          dayR + tradeR;

        /*
          IMPORTANT:
          If a winning trade occurs, the daily loss
          counter should not become a "loss limit reset".

          We keep the current day's net result.

          For a future real-calendar implementation,
          days will be explicit rather than inferred.
        */

        const invalid =
          violatesLossRules(
            nextR,
            nextDayR,
            rules
          );

        /*
          Hedge state is evaluated for this trade
          independently of Prop DD.
        */
        const hedgeState =
          calculateHedgeState(
            c,
            hedgeProfit,
            nextR
          );

        /*
          For V2, the hedge amount is treated as
          deployed recovery capital, NOT Prop P&L.
        */
        const nextHedgeInvested =
          hedgeState.hedgeCapitalRequired;

        /*
          We model the recovery ledger separately.

          IMPORTANT:
          This is a ledger placeholder based on the
          configured hedge capital relationship.
          It does NOT claim a real broker return.
        */
        let nextHedgeProfit =
          hedgeProfit;

        let nextHedgeRecovered =
          hedgeRecovered;

        /*
          On a Prop loss:
          hedge is considered the recovery side.

          On a Prop win:
          hedge remains the opposing/recovery ledger.

          The actual hedge P&L multiplier must be supplied
          once the exact hedge instrument is locked.
        */
        const hedgeEvent = {
          trade: tradeNumber,
          propResult: result,
          hedgeCapital:
            hedgeState.hedgeCapitalRequired,
          hedgeLot:
            hedgeState.hedgeLot,
          recoveryBefore:
            hedgeProfit,
          recoveryAllocation:
            hedgeState.recoveryAllocation,
          recoveredBefore:
            hedgeRecovered
        };

        /*
          Invalid branch:
          STOP IMMEDIATELY.

          No additional W/L children.
        */
        if (invalid) {

          results.push({
            path: path + result,
            stage:
              stage === 1
                ? "Phase 1"
                : "Phase 2",
            status: "DD STOP",
            invalidAtTrade: tradeNumber,

            r: nextR,
            trades: [
              ...trades,
              {
                number: tradeNumber,
                result,
                r: nextR,
                tradeR,
                dayR: nextDayR,
                overallRemainingR:
                  Math.max(
                    0,
                    rules.maxDrawdownR + nextR
                  ),
                dailyRemainingR:
                  Math.max(
                    0,
                    rules.dailyLossR + nextDayR
                  ),
                effectiveLossRoomR:
                  Math.max(
                    0,
                    effectiveLossRoomR(
                      currentR,
                      dayR,
                      rules
                    )
                  ),
                hedge:
                  hedgeState
              }
            ],

            hedgeProfit:
              nextHedgeProfit,

            hedgeInvested:
              nextHedgeInvested,

            hedgeRecovered:
              nextHedgeRecovered,

            events: [
              ...events,
              {
                type: "INVALID",
                trade: tradeNumber,
                reason:
                  "Daily loss or static maximum drawdown breached.",
                hedge:
                  hedgeEvent
              }
            ]
          });

          return;
        }

        /*
          Trade is valid.
        */
        const nextTrade = {
          number: tradeNumber,
          result,
          r: nextR,
          tradeR,
          dayR: nextDayR,

          overallRemainingR:
            Math.max(
              0,
              rules.maxDrawdownR + nextR
            ),

          dailyRemainingR:
            Math.max(
              0,
              rules.dailyLossR + nextDayR
            ),

          effectiveLossRoomR:
            Math.max(
              0,
              effectiveLossRoomR(
                currentR,
                dayR,
                rules
              )
            ),

          propPnl:
            nextR * rules.oneR,

          hedge:
            hedgeState
        };

        const nextTrades = [
          ...trades,
          nextTrade
        ];

        const nextEvents = [
          ...events,
          {
            type: "TRADE",
            trade: tradeNumber,
            result,
            hedge:
              hedgeEvent
          }
        ];

        /*
          Phase target check.
        */
        if (
          stage === 1 &&
          nextR >= rules.phase1R
        ) {

          /*
            Phase 1 passed.

            Reset Phase 2 progress to zero,
            but this does NOT reset the account's
            static overall DD ceiling.
          */
          walk({
            path: path + result,
            stage: 2,
            currentR: 0,
            dayR: 0,
            trades: nextTrades,
            hedgeProfit: nextHedgeProfit,
            hedgeInvested: nextHedgeInvested,
            hedgeRecovered: nextHedgeRecovered,
            events: [
              ...nextEvents,
              {
                type: "PHASE_PASS",
                phase: 1,
                trade: tradeNumber
              }
            ]
          });

          return;
        }

        /*
          Phase 2 target check.
        */
        if (
          stage === 2 &&
          nextR >= rules.phase2R
        ) {

          /*
            Funded terminal state.
          */
          results.push({
            path: path + result,
            stage: "FUNDED",
            status: "FUNDED",
            r: nextR,

            trades: nextTrades,

            hedgeProfit:
              nextHedgeProfit,

            hedgeInvested:
              nextHedgeInvested,

            hedgeRecovered:
              nextHedgeRecovered,

            events: [
              ...nextEvents,
              {
                type: "FUNDED",
                trade: tradeNumber
              }
            ]
          });

          return;
        }

        /*
          Continue branch.
        */
        walk({
          path: path + result,
          stage,
          currentR: nextR,
          dayR: nextDayR,
          trades: nextTrades,
          hedgeProfit: nextHedgeProfit,
          hedgeInvested: nextHedgeInvested,
          hedgeRecovered: nextHedgeRecovered,
          events: nextEvents
        });
      });
    }

    walk({
      path: "",
      stage: 1,
      currentR: 0,
      dayR: 0,
      trades: [],
      hedgeProfit: 0,
      hedgeInvested: c.fee,
      hedgeRecovered: 0,
      events: []
    });

    return results;
  }

  function renderMetrics(c, results) {
    const funded =
      results.filter(
        x => x.status === "FUNDED"
      ).length;

    const ddStopped =
      results.filter(
        x => x.status === "DD STOP"
      ).length;

    const horizon =
      results.filter(
        x => x.status === "HORIZON"
      ).length;

    const rules = ruleValues(c);

    $("metrics").innerHTML = [
      ["Branches", results.length],
      ["Funded", funded],
      ["DD stopped", ddStopped],
      ["1R", money(rules.oneR)]
    ]
      .map(
        ([label, value]) =>
          `<div class="metric">
            <small>${label}</small>
            <strong>${value}</strong>
          </div>`
      )
      .join("");

    $("branchCount").textContent =
      `${results.length} terminal branches`;

    $("validation").textContent =
      `V2 • ${funded} funded / ${ddStopped} DD stop / ${horizon} horizon`;
  }

  function renderRows() {
    const filter = $("filter").value;
    const search =
      $("search").value
        .trim()
        .toUpperCase();

    const filtered =
      scenarios.filter((s) => {

        const filterOK =
          filter === "all" ||
          s.status === filter;

        const searchOK =
          !search ||
          s.path.includes(search);

        return filterOK && searchOK;
      });

    $("scenarioRows").innerHTML =
      filtered
        .slice(0, 300)
        .map((s) => {

          const index =
            scenarios.indexOf(s);

          const lastTrade =
            s.trades.length
              ? s.trades[s.trades.length - 1]
              : null;

          const hedge =
            lastTrade?.hedge;

          return `
            <tr data-index="${index}">
              <td>${index + 1}</td>
              <td>${s.path || "—"}</td>
              <td>${s.trades.length}</td>
              <td>${Number(s.r).toFixed(2)}R</td>
              <td>${s.stage}</td>
              <td>${s.status}</td>
              <td>${money(
                hedge?.hedgeCapital ||
                s.hedgeInvested ||
                0
              )}</td>
            </tr>
          `;
        })
        .join("") ||
      `<tr>
        <td colspan="7">
          No matching scenarios.
        </td>
      </tr>`;

    qa("#scenarioRows tr[data-index]")
      .forEach((row) => {
        row.addEventListener(
          "click",
          () =>
            selectScenario(
              Number(row.dataset.index)
            )
        );
      });
  }

  function selectScenario(index) {
    selectedScenario =
      scenarios[index];

    if (!selectedScenario) return;

    $("scenarioDetail")
      .classList.remove("hidden");

    $("scenarioDetail").innerHTML = `
      <strong>
        Selected: ${selectedScenario.path || "—"}
      </strong>

      <div class="status">
        ${selectedScenario.status}
        • ${selectedScenario.stage}
        • ${Number(selectedScenario.r).toFixed(2)}R
        • ${selectedScenario.trades.length} trades
      </div>
    `;

    buildTimeline(
      selectedScenario,
      getConfig()
    );
  }

  function buildTimeline(scenario, c) {

    $("timelineEmpty")
      .classList.add("hidden");

    $("timelineContent")
      .classList.remove("hidden");

    const rules =
      ruleValues(c);

    const funded =
      scenario.status === "FUNDED";

    /*
      Illustrative funded payout framework.

      This is NOT a claim that this is the firm's
      exact payout calculation.
    */
    const secureProfit =
      c.account *
      (c.securePct / 100);

    const rewardShare =
      secureProfit *
      (c.share / 100);

    const illustrativeRecovery =
      rewardShare +
      c.reward +
      c.fee;

    $("timelineSummary").innerHTML = [
      ["Path", scenario.path || "—"],
      [
        "Prop result",
        money(
          scenario.r *
          rules.oneR
        )
      ],
      [
        "Hedge deployed",
        money(
          scenario.hedgeInvested
        )
      ],
      [
        "Capital framework",
        money(
          illustrativeRecovery
        )
      ]
    ]
      .map(
        ([label, value]) =>
          `<div class="metric">
            <small>${label}</small>
            <strong>${value}</strong>
          </div>`
      )
      .join("");

    $("timelineRows").innerHTML =
      scenario.trades
        .map((trade) => {

          const h =
            trade.hedge || {};

          return `
            <tr>
              <td>${trade.number}</td>

              <td>
                <strong>${trade.result}</strong>
              </td>

              <td>
                ${trade.number <= scenario.trades.length
                  ? scenario.stage
                  : ""}
              </td>

              <td>
                ${Number(trade.r).toFixed(2)}R
              </td>

              <td>
                ${money(trade.propPnl)}
              </td>

              <td>
                ${money(
                  h.hedgeCapital || 0
                )}
              </td>

              <td>
                ${Number(
                  h.hedgeLot || 0
                ).toFixed(4)}
              </td>
            </tr>
          `;
        })
        .join("") ||
      `<tr>
        <td colspan="7">
          No trades.
        </td>
      </tr>`;
  }

  function runEngine() {

    const c =
      getConfig();

    if (!validConfig(c)) {

      $("validation").textContent =
        "Check inputs";

      return;
    }

    scenarios =
      buildScenarios(c);

    renderMetrics(
      c,
      scenarios
    );

    renderRows();

    /*
      Move user automatically to
      Scenario tab after calculation.
    */
    activateTab("scenarios");
  }

  function activateTab(tabName) {

    qa(".tab")
      .forEach(
        button =>
          button.classList.toggle(
            "active",
            button.dataset.tab === tabName
          )
      );

    qa(".panel")
      .forEach(
        panel =>
          panel.classList.toggle(
            "active",
            panel.id === tabName
          )
      );
  }

  /*
    UI
  */

  qa(".tab")
    .forEach(
      button =>
        button.addEventListener(
          "click",
          () =>
            activateTab(
              button.dataset.tab
            )
        )
    );

  $("run")
    ?.addEventListener(
      "click",
      runEngine
    );

  $("filter")
    ?.addEventListener(
      "change",
      renderRows
    );

  $("search")
    ?.addEventListener(
      "input",
      renderRows
    );

  $("demo")
    ?.addEventListener(
      "click",
      () => {

        $("rr").value = "2.5";
        $("maxTrades").value = "4";

        runEngine();
      }
    );

  /*
    PWA
  */

  if (
    "serviceWorker" in navigator
  ) {
    navigator.serviceWorker
      .register("sw.js")
      .catch(() => {});
  }

  let deferredInstall = null;

  window.addEventListener(
    "beforeinstallprompt",
    (event) => {

      event.preventDefault();

      deferredInstall =
        event;

      $("installBtn")
        ?.classList
        .remove("hidden");
    }
  );

  $("installBtn")
    ?.addEventListener(
      "click",
      async () => {

        if (!deferredInstall)
          return;

        deferredInstall.prompt();

        await deferredInstall
          .userChoice;

        deferredInstall = null;

        $("installBtn")
          ?.classList
          .add("hidden");
      }
    );

  /*
    Initial state.
  */

  if (
    $("validation")
  ) {
    $("validation").textContent =
      "V2 ready";
  }

})();
