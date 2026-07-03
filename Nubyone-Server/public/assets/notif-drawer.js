(function () {
  let _drawer = null;
  let _overlay = null;

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function timeAgo(ts) {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 5) return "just now";
    if (d < 60) return d + "s ago";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return Math.floor(d / 86400) + "d ago";
  }

  function injectStyles() {
    if (document.getElementById("_ndCss")) return;
    const s = document.createElement("style");
    s.id = "_ndCss";
    s.textContent = `
      #_ndOv{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.28);opacity:0;transition:opacity .22s;pointer-events:none;}
      #_ndOv.open{opacity:1;pointer-events:all;}
      #_nd{position:fixed;top:0;right:0;width:300px;max-width:92vw;height:100vh;z-index:9999;
        background:linear-gradient(180deg,#071c34 0%,#081e38 100%);
        border-left:1px solid rgba(34,211,238,.14);
        box-shadow:-10px 0 36px rgba(0,0,0,.6);
        display:flex;flex-direction:column;
        transform:translateX(100%);transition:transform .22s cubic-bezier(.25,.8,.25,1);}
      #_nd.open{transform:translateX(0);}
      #_ndHead{display:flex;align-items:center;justify-content:space-between;
        padding:.8rem 1rem .6rem;border-bottom:1px solid rgba(34,211,238,.1);flex-shrink:0;}
      #_ndTitle{font-size:.88rem;font-weight:700;color:#e0f8ff;letter-spacing:.01em;}
      #_ndActs{display:flex;align-items:center;gap:.4rem;}
      .nd-ibtn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;
        width:29px;height:29px;display:inline-flex;align-items:center;justify-content:center;
        color:#93c5e8;cursor:pointer;font-size:.76rem;transition:all .15s;font-family:inherit;}
      .nd-ibtn:hover{background:rgba(34,211,238,.12);border-color:rgba(34,211,238,.35);color:#22d3ee;}
      .nd-ibtn.nd-on{background:rgba(34,211,238,.16);border-color:rgba(34,211,238,.55);color:#22d3ee;}
      #_ndList{flex:1;overflow-y:auto;padding:.5rem .7rem;display:flex;flex-direction:column;gap:.3rem;}
      #_ndList::-webkit-scrollbar{width:3px;}
      #_ndList::-webkit-scrollbar-thumb{background:rgba(34,211,238,.25);border-radius:99px;}
      .nd-item{display:flex;align-items:center;gap:.55rem;padding:.42rem .55rem;border-radius:8px;
        background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);}
      .nd-item.nd-unread{border-color:rgba(34,211,238,.14);background:rgba(34,211,238,.04);}
      .nd-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-top:1px;}
      .nd-dot.nd-on{background:#4ade80;box-shadow:0 0 5px rgba(74,222,128,.55);}
      .nd-dot.nd-off{background:#475569;}
      .nd-info{flex:1;min-width:0;}
      .nd-host{font-size:.75rem;font-weight:700;color:#e0f8ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .nd-meta{font-size:.67rem;color:#4d6a88;margin-top:.08rem;}
      .nd-empty{text-align:center;color:#2d4a6a;font-size:.78rem;padding:2.5rem 0;}
      #_ndFoot{padding:.5rem .7rem;border-top:1px solid rgba(255,255,255,.05);flex-shrink:0;}
      .nd-readall{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);
        border-radius:8px;padding:.38rem;color:#4d6a88;font-size:.73rem;font-family:inherit;cursor:pointer;
        transition:all .15s;}
      .nd-readall:hover{background:rgba(34,211,238,.07);border-color:rgba(34,211,238,.22);color:#93c5e8;}
    `;
    document.head.appendChild(s);
  }

  function buildDrawer() {
    injectStyles();

    _overlay = document.createElement("div");
    _overlay.id = "_ndOv";
    _overlay.onclick = window.closeNotifDrawer;
    document.body.appendChild(_overlay);

    _drawer = document.createElement("div");
    _drawer.id = "_nd";
    _drawer.innerHTML =
      '<div id="_ndHead">' +
        '<span id="_ndTitle">Activity</span>' +
        '<div id="_ndActs">' +
          '<button class="nd-ibtn" id="_ndMute" onclick="window._ndToggleMute()" title="Mute / unmute"></button>' +
          '<button class="nd-ibtn" onclick="window.closeNotifDrawer()" title="Close"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
      '</div>' +
      '<div id="_ndList"><div class="nd-empty">No recent activity</div></div>' +
      '<div id="_ndFoot"><button class="nd-readall" onclick="window._ndMarkRead()">Mark all as read</button></div>';
    document.body.appendChild(_drawer);
  }

  function syncMuteBtn() {
    const btn = document.getElementById("_ndMute");
    if (!btn) return;
    const on = localStorage.getItem("nubyone_notifications_enabled") !== "false";
    btn.className = "nd-ibtn" + (on ? " nd-on" : "");
    btn.innerHTML = '<i class="fa-solid fa-bell' + (on ? "" : "-slash") + '"></i>';
    btn.title = on ? "Mute notifications" : "Unmute notifications";
  }

  function renderList(events) {
    const list = document.getElementById("_ndList");
    if (!list) return;
    if (!events || !events.length) {
      list.innerHTML = '<div class="nd-empty">No recent activity</div>';
      return;
    }
    list.innerHTML = events.map(function (ev) {
      const on = ev.event === "connect";
      return '<div class="nd-item' + (ev.read ? "" : " nd-unread") + '">' +
        '<span class="nd-dot ' + (on ? "nd-on" : "nd-off") + '"></span>' +
        '<div class="nd-info">' +
          '<div class="nd-host">' + esc(ev.host || ev.clientId) + '</div>' +
          '<div class="nd-meta">' + (on ? "Connected" : "Disconnected") + " · " + timeAgo(ev.ts) + '</div>' +
        '</div></div>';
    }).join("");
  }

  async function loadHistory() {
    try {
      const res = await fetch("/api/notifications?limit=50");
      const data = await res.json();
      if (Array.isArray(data)) renderList(data);
    } catch (_) {}
  }

  window._ndToggleMute = function () {
    const on = localStorage.getItem("nubyone_notifications_enabled") !== "false";
    const next = !on;
    localStorage.setItem("nubyone_notifications_enabled", next ? "true" : "false");
    if (typeof applyBellState === "function") applyBellState(next);
    syncMuteBtn();
  };

  window._ndMarkRead = async function () {
    try { await fetch("/api/notifications/mark-read", { method: "POST" }); } catch (_) {}
    if (typeof updateBadge === "function") updateBadge(0);
    document.querySelectorAll(".nd-item.nd-unread").forEach(function (el) {
      el.classList.remove("nd-unread");
    });
  };

  window.openNotifDrawer = function () {
    if (!_drawer) buildDrawer();
    syncMuteBtn();
    loadHistory();
    _drawer.classList.add("open");
    _overlay.classList.add("open");
    setTimeout(window._ndMarkRead, 600);
  };

  window.closeNotifDrawer = function () {
    if (_drawer) _drawer.classList.remove("open");
    if (_overlay) _overlay.classList.remove("open");
  };

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && _drawer && _drawer.classList.contains("open")) {
      window.closeNotifDrawer();
    }
  });

  // ── Live real-time injection via own WebSocket ─────────────────────────────
  (function startNotifWs() {
    try {
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      var ws = new WebSocket(proto + "//" + location.host + "/api/notifications/ws");
      ws.onmessage = function (e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type !== "client_event") return;
          // Only inject visually if the drawer is currently open
          if (_drawer && _drawer.classList.contains("open")) {
            var list = document.getElementById("_ndList");
            if (list) {
              var empty = list.querySelector(".nd-empty");
              if (empty) empty.remove();
              var on = msg.event === "connect";
              var item = document.createElement("div");
              item.className = "nd-item nd-unread";
              item.innerHTML =
                '<span class="nd-dot ' + (on ? "nd-on" : "nd-off") + '"></span>' +
                '<div class="nd-info">' +
                  '<div class="nd-host">' + esc(msg.host || msg.clientId) + '</div>' +
                  '<div class="nd-meta">' + (on ? "Connected" : "Disconnected") + " \xb7 just now</div>" +
                '</div>';
              list.insertBefore(item, list.firstChild);
            }
          }
        } catch (_) {}
      };
      ws.onclose = function () { setTimeout(startNotifWs, 3000); };
    } catch (_) {}
  })();
})();
