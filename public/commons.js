(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  var TIER = {
    TRUSTED:{c:"#34D399",bg:"rgba(52,211,153,.15)"}, NEUTRAL:{c:"#16C7C0",bg:"rgba(22,199,192,.15)"},
    WATCH:{c:"#FBBF24",bg:"rgba(251,191,36,.15)"}, HIGH_RISK:{c:"#ff5c6c",bg:"rgba(255,92,108,.15)"},
    UNKNOWN:{c:"#8aa3a1",bg:"rgba(138,163,161,.12)"}
  };

  function loadNetworks() {
    fetch("/api/trust/networks", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var nets = (d && d.networks) || [];
        $("#nets").innerHTML = nets.map(function (n) {
          return '<div class="net"><div class="l">' + esc(n.label) + '</div><div class="k">' + esc(n.kind) + "</div></div>";
        }).join("");
      })
      .catch(function () { $("#nets").innerHTML = '<div class="net"><div class="l">Could not load networks.</div></div>'; });
  }

  function resolve() {
    var q = $("#q").value.trim();
    if (!q) return;
    var btn = $("#go"); btn.textContent = "Resolving…"; btn.disabled = true;
    fetch("/api/trust/resolve/" + encodeURIComponent(q), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var t = TIER[d.composite.tier] || TIER.UNKNOWN;
        $("#r-score").textContent = d.composite.score;
        $("#r-score").style.color = t.c;
        var tb = $("#r-tier"); tb.textContent = d.composite.tier; tb.style.color = t.c; tb.style.background = t.bg;
        $("#r-subj").textContent = d.subject;
        $("#r-meta").textContent = "confidence " + Math.round((d.composite.confidence || 0) * 100) + "% · " +
          d.sourcesCount + " source" + (d.sourcesCount === 1 ? "" : "s") + " · signed passport";
        $("#r-cov").innerHTML = (d.coverage || []).map(function (c) {
          return "<tr><td>" + esc(c.label) + "</td><td style=\"color:var(--muted)\">" + esc(c.kind) + "</td>" +
            "<td style=\"font-family:var(--mono)\">" + c.score + "</td>" +
            "<td style=\"font-family:var(--mono);color:var(--muted)\">" + (Math.round(c.weight * 100) / 100) + "</td></tr>";
        }).join("");
        $("#r-note").textContent = d.note || "";
        $("#res").classList.add("show");
      })
      .catch(function () { $("#r-subj").textContent = "Could not resolve that subject."; $("#res").classList.add("show"); })
      .finally(function () { btn.textContent = "Resolve"; btn.disabled = false; });
  }

  function init() {
    $("#go").addEventListener("click", resolve);
    $("#q").addEventListener("keydown", function (e) { if (e.key === "Enter") resolve(); });
    var m = new URLSearchParams(location.search).get("q");
    if (m) { $("#q").value = m; resolve(); }
    loadNetworks();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
