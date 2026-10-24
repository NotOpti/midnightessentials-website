/* MidnightEssentials website
   - smooth scrolling (Lenis), sticky nav, mobile menu
   - reads the addon's GitHub releases so the version, download link and
     patch notes stay current without editing this site */

(function () {
  "use strict";

  var REPO = "NotOpti/MidnightEssentials";
  var API = "https://api.github.com/repos/" + REPO + "/releases?per_page=100";
  var RELEASES_PAGE = "https://github.com/" + REPO + "/releases";
  var LATEST_ZIP = "https://github.com/" + REPO + "/releases/latest/download/MidnightEssentials.zip";
  var CACHE_KEY = "me-releases-v2";
  // Always ask GitHub. The saved copy is sent as an ETag, so when nothing changed
  // GitHub answers "304 Not Modified" quickly and it doesn't count against its hourly limit.
  // The saved copy is only shown when GitHub can't be reached.
  var CACHE_FRESH_MS = 0;

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.classList.add("js");

  /* ------------------------------------------------------------ helpers */

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null");
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }

  function cmpVersion(a, b) {
    var pa = String(a).replace(/^v/i, "").split("."), pb = String(b).replace(/^v/i, "").split(".");
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  var dateFmt = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });
  var shortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  function fmtDate(d, short) { return d ? (short ? shortFmt : dateFmt).format(d) : ""; }
  function ago(d) {
    if (!d) return "";
    var days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return days + " days ago";
    if (days < 30) { var w = Math.floor(days / 7); return w === 1 ? "last week" : w + " weeks ago"; }
    if (days < 365) { var m = Math.max(1, Math.floor(days / 30)); return m === 1 ? "last month" : m + " months ago"; }
    return "over a year ago";
  }
  function slug(v) { return "v" + String(v).replace(/[^\w]+/g, "-"); }

  /* ------------------------------------------------------------ GitHub releases */

  function parseReleases(list) {
    if (!Array.isArray(list)) throw new Error("Unexpected reply from GitHub");
    var out = [];
    list.forEach(function (r) {
      if (!r || r.draft || r.prerelease) return;
      var tag = String(r.tag_name || "").replace(/^v/i, "");
      if (!tag) return;
      var zip = null, size = 0;
      (r.assets || []).forEach(function (a) {
        if (String(a.name).toLowerCase() === "midnightessentials.zip") { zip = a.browser_download_url; size = a.size; }
        else if (!zip && /\.zip$/i.test(a.name)) { zip = a.browser_download_url; size = a.size; }
      });
      out.push({
        tag: tag,
        title: r.name || "",
        body: r.body || "",
        url: r.html_url || RELEASES_PAGE,
        zip: zip,
        size: size,
        date: r.published_at ? new Date(r.published_at) : (r.created_at ? new Date(r.created_at) : null)
      });
    });
    out.sort(function (a, b) { return cmpVersion(b.tag, a.tag) || ((b.date || 0) - (a.date || 0)); });
    return out;
  }

  var releasesPromise = null;
  function getReleases() {
    if (releasesPromise) return releasesPromise;
    var cached = store(CACHE_KEY);
    if (cached && cached.data && Date.now() - cached.time < CACHE_FRESH_MS) {
      releasesPromise = Promise.resolve(parseReleases(cached.data));
      return releasesPromise;
    }
    var headers = { Accept: "application/vnd.github+json" };
    // An unchanged list answers 304, which doesn't count against GitHub's hourly limit.
    if (cached && cached.etag) headers["If-None-Match"] = cached.etag;

    // Give up after 8 s so a blocked or hanging request shows a message instead of an empty page.
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    releasesPromise = fetch(API, { headers: headers, signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (res.status === 304 && cached) {
          cached.time = Date.now();
          store(CACHE_KEY, cached);
          return cached.data;
        }
        if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub's hourly limit was reached" : "GitHub answered " + res.status);
        var etag = res.headers.get("ETag");
        return res.json().then(function (data) {
          store(CACHE_KEY, { time: Date.now(), etag: etag, data: data });
          return data;
        });
      })
      .then(parseReleases)
      .catch(function (err) {
        // Offline or rate limited: an older copy is better than nothing.
        if (cached && cached.data) { var list = parseReleases(cached.data); list.stale = true; return list; }
        if (err && err.name === "AbortError") err = new Error("GitHub took too long to answer");
        else if (err instanceof TypeError) err = new Error("GitHub couldn't be reached");
        throw err;
      })
      .finally(function () { if (timer) clearTimeout(timer); });
    return releasesPromise;
  }

  /* ------------------------------------------------------------ release notes Markdown
     The same subset the Updater understands: ### headings, **bold** lines as headings,
     bullets (nested), paragraphs, `code`, **bold**, [links](url), rules. */

  function sectionOf(h) {
    h = h.toLowerCase();
    if (/\bfix|bug/.test(h)) return "fix";
    if (/\bnew\b|add|feature/.test(h)) return "new";
    if (/chang|improv|updat|tweak|remov/.test(h)) return "change";
    return "other";
  }

  function inline(s) {
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    var links = [];
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_, t, u) { links.push([t, u]); return "\u0001" + (links.length - 1) + "\u0001"; });
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
    s = esc(s);
    // "Module: what changed" -> the module name stands out
    var lead = /^([A-Z][\w+&'/().,\- ]{0,38}?):\s+/.exec(s);
    if (lead && lead[1].indexOf(". ") < 0 && s.indexOf("**") !== 0) s = "<strong>" + lead[1] + ":</strong> " + s.slice(lead[0].length);
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, function (_, a, b) { return "<strong>" + (a || b) + "</strong>"; });
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, "$1$2");
    s = s.replace(/\\([*_`#\[\]()\\-])/g, "$1");
    s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) {
      var l = links[+i];
      return '<a href="' + esc(l[1]) + '" target="_blank" rel="noopener">' + esc(l[0]) + "</a>";
    });
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return "<code>" + esc(codes[+i]) + "</code>"; });
    return s;
  }

  function renderNotes(body, tag) {
    var lines = String(body || "").replace(/\r\n?/g, "\n").split("\n");
    var blocks = [], open = null, fence = false;
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      if (/^\s*```/.test(line)) { fence = !fence; open = null; return; }
      if (fence) { blocks.push({ k: "p", raw: "`" + line.trim() + "`" }); return; }
      var t = line.trim().replace(/<!--.*?-->/g, "").trim();
      if (!t) { open = null; return; }
      var m;
      if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(t))) { blocks.push({ k: "h", raw: m[2] }); open = null; return; }
      if (/^(-\s*){3,}$|^(\*\s*){3,}$|^(_\s*){3,}$/.test(t)) { blocks.push({ k: "hr" }); open = null; return; }
      if ((m = /^(\*\*|__)([^*_]{1,40}?)(\*\*|__)\s*:?\s*$/.exec(t))) { blocks.push({ k: "h", raw: m[2].replace(/[:\s]+$/, "") }); open = null; return; }
      if ((m = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line))) {
        var depth = Math.min(3, Math.floor(m[1].replace(/\t/g, "    ").length / 2));
        open = { k: "li", d: depth, raw: m[3].trim() };
        blocks.push(open);
        return;
      }
      if (t.charAt(0) === ">") t = t.replace(/^>+\s*/, "");
      if (open) { open.raw += " " + t; return; }
      open = { k: "p", raw: t };
      blocks.push(open);
    });

    // A title that only repeats the version is already shown above the notes.
    while (blocks.length && (blocks[0].k === "h" || blocks[0].k === "p")) {
      var plain = blocks[0].raw.replace(/[*_`#]/g, "").trim();
      if (/^(MidnightEssentials)?\s*v?\d+(\.\d+)+\s*$/i.test(plain) ||
          (blocks[0].k === "h" && /MidnightEssentials/i.test(plain) && /\d+\.\d+/.test(plain))) blocks.shift();
      else break;
    }

    var html = "", sec = "other", depth = -1, counts = [], headIdx = -1;
    function closeTo(d) { while (depth > d) { html += "</li></ul>"; depth--; } }
    blocks.forEach(function (b) {
      if (b.k !== "li") closeTo(-1);
      if (b.k === "h") {
        sec = sectionOf(b.raw);
        headIdx = counts.length; counts.push(0);
        html += '<h4 data-sec="' + sec + '">' + inline(b.raw.replace(/[*_`]/g, "").replace(/:$/, "")) + ' <span class="count">\u0002' + headIdx + "\u0002</span></h4>";
      } else if (b.k === "hr") {
        html += "<hr>";
      } else if (b.k === "p") {
        html += "<p>" + inline(b.raw) + "</p>";
      } else {
        if (b.d > depth) { while (depth < b.d) { html += '<ul><li data-sec="' + sec + '">'; depth++; } }
        else { closeTo(b.d); html += '</li><li data-sec="' + sec + '">'; }
        html += inline(b.raw);
        if (b.d === 0 && headIdx >= 0) counts[headIdx]++;
      }
    });
    closeTo(-1);
    html = html.replace(/\u0002(\d+)\u0002/g, function (_, i) { return counts[+i] ? counts[+i] : ""; });
    return html || '<p class="small">No notes were posted for this release.</p>';
  }

  // First few bullets of a release, for the home page.
  function excerpt(body, max) {
    var wrap = document.createElement("div");
    wrap.innerHTML = renderNotes(body);
    var shown = 0;
    $$("ul", wrap).forEach(function (ul) {
      if (ul.parentElement !== wrap) return;
      $$(":scope > li", ul).forEach(function (li) {
        if (shown >= max) li.remove(); else shown++;
      });
      if (!ul.children.length) ul.remove();
    });
    $$("h4", wrap).forEach(function (h) {
      var next = h.nextElementSibling;
      if (!next || next.tagName === "H4") h.remove();
      else { var c = $(".count", h); if (c) c.remove(); }
    });
    $$("p", wrap).forEach(function (p, i) { if (i > 0) p.remove(); });
    return wrap.innerHTML;
  }

  /* ------------------------------------------------------------ fill version bits everywhere */

  function applyLatest(list) {
    var latest = list[0];
    if (!latest) return;
    $$("[data-version]").forEach(function (el) { el.textContent = latest.tag; });
    $$("[data-version-label]").forEach(function (el) { el.textContent = el.getAttribute("data-version-label").replace("{v}", latest.tag); });
    $$("[data-download]").forEach(function (a) { a.href = latest.zip || LATEST_ZIP; });
    $$("[data-release-date]").forEach(function (el) { el.textContent = fmtDate(latest.date); });
    $$("[data-release-ago]").forEach(function (el) { el.textContent = ago(latest.date); });
    $$("[data-release-url]").forEach(function (a) { a.href = latest.url; });
    $$("[data-latest-only]").forEach(function (el) { el.hidden = false; });

    var meta = $("#hero-meta");
    if (meta) {
      meta.innerHTML = "Free. Works on Retail and WoW Forever. Version " + esc(latest.tag) +
        " came out " + esc(ago(latest.date)) + ', see <a href="patch-notes.html#' + slug(latest.tag) + '">what changed</a>.';
    }
    var ex = $("#latest-notes");
    if (ex) {
      ex.innerHTML = excerpt(latest.body, 7) +
        '<p class="notes-more"><a class="text-link" href="patch-notes.html#' + slug(latest.tag) + '">Read the full notes for ' + esc(latest.tag) + "</a></p>";
    }
  }

  /* ------------------------------------------------------------ patch notes page */

  function buildPatchNotes(list) {
    var main = $("#pn-list"), side = $("#pn-side");
    if (!main) return;
    if (!list.length) {
      main.innerHTML = '<div class="empty"><h2>No releases yet</h2><p>When a version is published on GitHub it shows up here.</p></div>';
      return;
    }
    var html = "", nav = '<h2>Versions</h2>';
    list.forEach(function (r, i) {
      var id = slug(r.tag);
      html += '<article class="release" id="' + id + '">' +
        '<div class="release-head"><h2>' + esc(r.tag) + "</h2>" + (i === 0 ? '<span class="pill">Latest</span>' : "") + "</div>" +
        '<div class="release-meta"><span>' + esc(fmtDate(r.date)) + "</span>" +
        '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">View on GitHub</a>' +
        (r.zip ? '<a href="' + esc(r.zip) + '">Download this version</a>' : "") + "</div>" +
        '<div class="notes">' + renderNotes(r.body, r.tag) + "</div></article>";
      nav += '<a href="#' + id + '" data-id="' + id + '">' + esc(r.tag) + "<small>" + esc(fmtDate(r.date, true).replace(/, \d{4}$/, "")) + "</small></a>";
    });
    main.innerHTML = html;
    if (side) side.innerHTML = nav;
    if (list.stale) {
      main.insertAdjacentHTML("afterbegin", '<p class="small" style="margin-bottom:32px">GitHub couldn\'t be reached just now, so this is the last copy your browser saved.</p>');
    }
    var count = $("#pn-count");
    if (count) count.textContent = list.length === 1 ? "1 release" : list.length + " releases";

    // Jump to a version from the URL once the list exists.
    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) setTimeout(function () { scrollToEl(target, true); }, 60);
    }

    // Highlight the version you're reading.
    if (side && "IntersectionObserver" in window) {
      var links = {};
      $$("a", side).forEach(function (a) { links[a.getAttribute("data-id")] = a; });
      var current = null;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            if (current) current.classList.remove("on");
            current = links[e.target.id];
            if (current) current.classList.add("on");
          }
        });
      }, { rootMargin: "-30% 0px -60% 0px" });
      $$(".release", main).forEach(function (el) { io.observe(el); });
    }
  }

  function patchNotesError(err) {
    var main = $("#pn-list");
    if (!main) return;
    main.innerHTML = '<div class="empty"><h2>The patch notes didn\'t load</h2><p>' + esc(err && err.message ? err.message : "GitHub couldn't be reached") +
      '. The same notes are on GitHub, or try again in a minute.</p><a class="btn btn-ghost" href="' + RELEASES_PAGE + '" target="_blank" rel="noopener">Open the releases on GitHub</a></div>';
  }

  /* ------------------------------------------------------------ smooth scrolling */

  var lenis = null;
  if (!reduceMotion && window.Lenis) {
    lenis = new window.Lenis({
      autoRaf: true,
      lerp: 0.11,
      wheelMultiplier: 1,
      smoothWheel: true,
      anchors: { offset: -72 },
      prevent: function (node) { return node.closest && node.closest(".app-notes, .pn-side, .tour-nav"); }
    });
  }
  function scrollToEl(el, instant) {
    if (lenis) lenis.scrollTo(el, { offset: -72, immediate: !!instant });
    else el.scrollIntoView({ behavior: instant || reduceMotion ? "auto" : "smooth" });
  }

  /* ------------------------------------------------------------ nav */

  var nav = $(".nav");
  if (nav) {
    var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    var btn = $(".menu-btn", nav);
    if (btn) {
      btn.addEventListener("click", function () {
        var open = nav.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      $$(".nav-links a", nav).forEach(function (a) {
        a.addEventListener("click", function () { nav.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); });
      });
    }
  }

  /* ------------------------------------------------------------ settings window tour */

  var tour = $("#tour");
  if (tour) {
    var img = $("#tour-img"), capName = $("#tour-name"), capText = $("#tour-text");
    var buttons = $$("button[data-img]", tour);
    // Warm the cache so switching is instant.
    var preload = function () { buttons.forEach(function (b) { var i = new Image(); i.src = b.getAttribute("data-img"); }); };
    if ("requestIdleCallback" in window) requestIdleCallback(preload); else setTimeout(preload, 1500);

    var select = function (b) {
      if (b.getAttribute("aria-pressed") === "true") return;
      buttons.forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      var src = b.getAttribute("data-img");
      capName.textContent = b.getAttribute("data-title") || b.textContent;
      capText.textContent = b.getAttribute("data-desc") || "";
      img.classList.add("is-leaving");
      var next = new Image();
      next.onload = next.onerror = function () {
        setTimeout(function () {
          img.src = src;
          img.alt = "MidnightEssentials settings window, " + capName.textContent + " page";
          img.classList.remove("is-leaving");
        }, reduceMotion ? 0 : 140);
      };
      next.src = src;
    };
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () { select(b); });
      b.addEventListener("keydown", function (e) {
        var d = (e.key === "ArrowDown" || e.key === "ArrowRight") ? 1 : (e.key === "ArrowUp" || e.key === "ArrowLeft") ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = buttons[(i + d + buttons.length) % buttons.length];
        n.focus(); select(n);
      });
    });
  }

  /* ------------------------------------------------------------ Unlock Mode switch */

  var us = $("#unlock-switch");
  if (us) {
    var ub = $$("button", us), shots = $$("#unlock-shot img");
    ub.forEach(function (b, i) {
      b.addEventListener("click", function () {
        ub.forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        shots.forEach(function (s, j) { s.hidden = j !== i; });
      });
    });
  }

  /* ------------------------------------------------------------ the Updater window */

  var app = $("#app");
  if (app) {
    var tabs = $$(".app-tab", app), pages = $$("[data-page]", app);
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.setAttribute("aria-selected", x === t ? "true" : "false"); });
        pages.forEach(function (p) { p.hidden = p.getAttribute("data-page") !== t.getAttribute("data-tab"); });
      });
    });
    var sub = $$(".app-subtabs button", app), grid = $(".app-grid", app), log = $(".app-log", app);
    var showLog = function (on) {
      sub[0].setAttribute("aria-selected", on ? "false" : "true");
      sub[1].setAttribute("aria-selected", on ? "true" : "false");
      grid.hidden = on; log.hidden = !on;
    };
    sub[0].addEventListener("click", function () { showLog(false); });
    sub[1].addEventListener("click", function () { showLog(true); });
    $(".app-link", app).addEventListener("click", function () { tabs[1].click(); });

    var head = $("#app-head"), subline = $("#app-sub"), btn2 = $("#app-btn"), bar = $(".app-prog i", app);
    var state = { installed: "9.0.2", latest: null, size: "" };
    var now = function () { var d = new Date(); return d.toTimeString().slice(0, 8); };
    var addLog = function (text, color) {
      var row = document.createElement("div");
      row.innerHTML = "<time>" + now() + '</time><span style="color:' + (color || "var(--c-dim)") + '">' + esc(text) + "</span>";
      log.appendChild(row);
      while (log.children.length > 7) log.removeChild(log.firstChild);
    };
    var setIdle = function () {
      if (!state.latest) {
        head.textContent = "Update available";
        subline.textContent = state.installed + " installed";
        btn2.textContent = "Update";
        return;
      }
      if (cmpVersion(state.installed, state.latest.tag) < 0) {
        head.textContent = "Update available";
        subline.textContent = state.installed + " installed, " + state.latest.tag + " released " + ago(state.latest.date) + (state.size ? ", " + state.size : "");
        btn2.textContent = "Update to " + state.latest.tag;
        btn2.classList.remove("secondary");
        $(".app-link", app).textContent = "What's new in " + state.latest.tag;
      } else {
        head.textContent = "You're up to date";
        subline.textContent = "MidnightEssentials " + state.installed + ", released " + ago(state.latest.date);
        btn2.textContent = "Reinstall";
        btn2.classList.add("secondary");
      }
    };
    addLog("Updater 2.0 ready.", "var(--c-muted)");

    btn2.addEventListener("click", function () {
      if (app.classList.contains("busy")) return;
      var target = state.latest ? state.latest.tag : "the latest release";
      app.classList.add("busy");
      btn2.disabled = true; btn2.textContent = "Working…";
      showLog(true);
      head.textContent = "Updating to " + target;
      var steps = [
        [0, "Downloading…", "Downloading MidnightEssentials " + target + "…"],
        [0.35, "Downloading…", null],
        [0.75, "Unpacking…", "Download checked."],
        [0.92, "Replacing folders…", "Swapping only the MidnightEssentials folders in AddOns."],
        [1, "Cleaning up…", null]
      ];
      var i = 0;
      var tick = function () {
        if (i >= steps.length) {
          app.classList.remove("busy");
          bar.style.width = "0";
          btn2.disabled = false;
          if (state.latest) state.installed = state.latest.tag;
          addLog("Done. MidnightEssentials " + state.installed + " is installed.", "var(--good)");
          head.textContent = "Updated to " + state.installed;
          subline.textContent = "Start the game, or type /reload if it's already running.";
          btn2.textContent = "Reinstall";
          btn2.classList.add("secondary");
          setTimeout(function () { if (!app.classList.contains("busy")) setIdle(); }, 6000);
          return;
        }
        var s = steps[i++];
        bar.style.width = (s[0] * 100) + "%";
        subline.textContent = s[1];
        if (s[2]) addLog(s[2]);
        setTimeout(tick, reduceMotion ? 120 : 520);
      };
      tick();
    });

    app._fill = function (list) {
      if (!list.length) return;
      state.latest = list[0];
      if (list[0].size) state.size = (list[0].size / 1048576).toFixed(1) + " MB";
      // Pretend the reader is one version behind, so the window shows an update.
      state.installed = list[1] ? list[1].tag : list[0].tag;
      setIdle();
      addLog("Latest release on GitHub: " + list[0].tag + ".");

      var vlist = $(".app-versions", app), notes = $(".app-notes", app);
      vlist.innerHTML = "";
      var show = function (r, i) {
        notes.innerHTML = '<div class="app-notes-head"><b>' + esc(r.tag) + "</b>" + (i === 0 ? '<span class="pill">Latest</span>' : "") + "</div>" +
          '<div class="notes">' + renderNotes(r.body, r.tag) + "</div>";
        notes.scrollTop = 0;
      };
      list.slice(0, 6).forEach(function (r, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.setAttribute("aria-selected", i === 0 ? "true" : "false");
        b.innerHTML = "<b>" + esc(r.tag) + "</b><small>" + esc(fmtDate(r.date, true)) + "</small>";
        b.addEventListener("click", function () {
          $$("button", vlist).forEach(function (x) { x.setAttribute("aria-selected", x === b ? "true" : "false"); });
          show(r, i);
        });
        vlist.appendChild(b);
      });
      show(list[0], 0);
    };
  }

  /* ------------------------------------------------------------ image reveal (once, quiet) */

  var reveals = $$(".reveal");
  if (reveals.length && "IntersectionObserver" in window && !reduceMotion) {
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); rio.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { rio.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ------------------------------------------------------------ go */

  var needsReleases = $("[data-version], [data-download], #pn-list, #app, #latest-notes");
  if (needsReleases) {
    getReleases().then(function (list) {
      applyLatest(list);
      buildPatchNotes(list);
      if (app && app._fill) app._fill(list);
    }).catch(function (err) {
      patchNotesError(err);
      var ex = $("#latest-notes");
      if (ex) ex.innerHTML = '<p>The latest notes couldn\'t be loaded from GitHub right now. <a class="text-link" href="' + RELEASES_PAGE + '" target="_blank" rel="noopener">Read them on GitHub</a>.</p>';
      var meta = $("#hero-meta");
      if (meta) meta.textContent = "Free. Works on Retail and WoW Forever.";
      if (app) {
        var n = $(".app-notes", app);
        if (n) n.innerHTML = '<p style="color:var(--c-muted)">Couldn\'t load the release notes.</p>';
      }
    });
  }
})();
