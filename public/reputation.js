(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

  var TIER = {
    TRUSTED:   { c: "#34D399", bg: "rgba(52,211,153,.15)" },
    NEUTRAL:   { c: "#16C7C0", bg: "rgba(22,199,192,.15)" },
    WATCH:     { c: "#FBBF24", bg: "rgba(251,191,36,.15)" },
    HIGH_RISK: { c: "#ff5c6c", bg: "rgba(255,92,108,.15)" },
    UNKNOWN:   { c: "#8aa3a1", bg: "rgba(138,163,161,.12)" }
  };

  function animateTo(el, target) {
    if (!el) return;
    var start = 0, t0 = performance.now(), dur = 900;
    function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      el.textContent = String(Math.round(start + (target - start) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function loadStats() {
    fetch("/api/reputation?limit=15", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        animateTo($("#c-subjects"), d.totalSubjects || 0);
        animateTo($("#c-obs"), d.totalObservations || 0);
        animateTo($("#c-risk"), (d.highRisk || []).length);
        renderWatchlist(d.highRisk || []);
      })
      .catch(function () {
        $("#watchlist").innerHTML = '<div class="empty">Reputation network not reachable yet.</div>';
      });
  }

  function tierBadge(tier) {
    var t = TIER[tier] || TIER.UNKNOWN;
    return '<span class="badge" style="color:' + t.c + ';background:' + t.bg + '">' + esc(tier) + "</span>";
  }

  function renderWatchlist(list) {
    var el = $("#watchlist");
    if (!list.length) {
      el.innerHTML = '<div class="empty">No high-risk subjects yet — the network is clean (or just getting started). Route traffic through the guard to populate it.</div>';
      return;
    }
    var rows = list.map(function (r) {
      return "<tr><td class=\"subj\">" + esc(r.subject) + "</td>" +
        "<td>" + tierBadge(r.tier) + "</td>" +
        "<td style=\"font-family:var(--mono);color:#ff5c6c\">" + r.score + "</td>" +
        "<td style=\"color:var(--muted)\">" + r.observations + "</td>" +
        "<td style=\"color:var(--dim)\">" + esc(r.kind) + "</td></tr>";
    }).join("");
    el.innerHTML = '<table><tr><th>Subject</th><th>Tier</th><th>Score</th><th>Obs</th><th>Type</th></tr>' + rows + "</table>";
  }

  function paintGauge(score, tier) {
    var g = $("#gauge");
    var t = TIER[tier] || TIER.UNKNOWN;
    g.style.setProperty("--p", String(score));
    g.style.setProperty("--gc", t.c);
    $("#r-score").textContent = String(score);
    $("#r-score").style.color = t.c;
  }

  var lastResult = null;

  function check() {
    var q = $("#q").value.trim();
    if (!q) return;
    var btn = $("#go");
    btn.textContent = "Checking…"; btn.disabled = true;
    fetch("/api/reputation/" + encodeURIComponent(q), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        lastResult = d;
        paintGauge(d.score, d.tier);
        $("#r-subj").textContent = d.subject;
        var t = TIER[d.tier] || TIER.UNKNOWN;
        var tb = $("#r-tier");
        tb.textContent = d.tier; tb.style.color = t.c; tb.style.background = t.bg;
        $("#r-obs").textContent = d.observations + " observation" + (d.observations === 1 ? "" : "s") +
          " · " + d.reporters + " reporter" + (d.reporters === 1 ? "" : "s");
        $("#r-note").textContent = d.note || "";
        $("#result").classList.add("show");
      })
      .catch(function () {
        $("#r-subj").textContent = "Could not look up that subject.";
        $("#result").classList.add("show");
      })
      .finally(function () { btn.textContent = "Check trust"; btn.disabled = false; });
  }

  function shareText() {
    if (!lastResult) return "";
    return "x402 Scam Radar — " + lastResult.subject + ": trust score " + lastResult.score +
      "/100 (" + lastResult.tier + "). Check any agent or merchant at https://x402trustlayer.xyz/reputation";
  }

  function init() {
    $("#go").addEventListener("click", check);
    $("#q").addEventListener("keydown", function (e) { if (e.key === "Enter") check(); });
    $("#r-share").addEventListener("click", function () {
      var txt = shareText(); if (!txt) return;
      var done = function () { var b = $("#r-share"); b.textContent = "Copied ✓"; b.classList.add("copied"); setTimeout(function () { b.textContent = "Copy shareable result"; b.classList.remove("copied"); }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(done);
      else done();
    });
    // deep link: /reputation?q=...
    var m = new URLSearchParams(location.search).get("q");
    if (m) { $("#q").value = m; check(); }
    loadStats();
    setInterval(loadStats, 30000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
