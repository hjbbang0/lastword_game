/* 끝말 헌터 — Vercel 배포용 플랫폼 어댑터
 * 1) askAI(kind, data): /api/judge 서버리스 함수로 판정 요청 (API 키는 서버에만 있음)
 * 2) makeRoomNs(cfg): Supabase Realtime Presence 위에 room API(join/presence/onPeers...)를 흉내 냄
 */

async function askAI(kind, data) {
  let r;
  try {
    r = await fetch("/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, ...data }),
    });
  } catch (e) {
    throw { code: "upstream_error", message: "network" };
  }
  if (r.status === 429) throw { code: "rate_limited", message: "too many requests" };
  if (r.status === 503) throw { code: "not_granted", message: "ai unavailable" }; // 키 만료·크레딧 소진 → 연습 모드로 전환
  if (!r.ok) throw { code: "upstream_error", message: "status " + r.status };
  return r.json();
}

function makeRoomNs(cfg) {
  if (!window.supabase || !window.supabase.createClient) return null;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    realtime: { params: { eventsPerSecond: 20 } },
  });
  return { join: (name) => joinRoom(sb, name) };
}

function joinRoom(sb, name) {
  return new Promise((resolve, reject) => {
    const myKey = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 16);
    const ch = sb.channel("kk-room:" + name, { config: { presence: { key: myKey } } });
    let mine = {};              // 내 presence (병합된 전체 객체)
    let peers = Object.freeze([]);
    let prev = new Map();
    let connected = false, left = false, settled = false;
    const peerHandlers = new Set(), connHandlers = new Set();
    let trackTimer = null, trackDirty = false;

    function rebuild() {
      const st = ch.presenceState();
      const list = [];
      for (const [key, metas] of Object.entries(st)) {
        const m = metas[metas.length - 1] || {};
        const old = prev.get(key);
        const pres = m.p || {};
        const same = old && JSON.stringify(old.presence) === JSON.stringify(pres);
        list.push(same ? old : Object.freeze({
          peer: key, by: null, isMe: key === myKey, sameTab: key === myKey,
          kind: "viewer", guest: false, presence: Object.freeze(pres), updatedAt: Date.now(),
        }));
      }
      const now = new Map(list.map((p) => [p.peer, p]));
      const joined = list.filter((p) => !prev.has(p.peer));
      const gone = [...prev.values()].filter((p) => !now.has(p.peer));
      const updated = list.filter((p) => prev.has(p.peer) && prev.get(p.peer) !== p);
      prev = now;
      peers = Object.freeze(list);
      const change = { peers, joined, left: gone, updated };
      peerHandlers.forEach((h) => { try { h(change); } catch (e) { console.error(e); } });
    }

    function flushTrack() {
      trackTimer = null;
      if (!trackDirty || left || !connected) return;
      trackDirty = false;
      ch.track({ p: mine }).catch(() => { trackDirty = true; });
    }
    function scheduleTrack() {
      trackDirty = true;
      if (!trackTimer) trackTimer = setTimeout(flushTrack, 60);
    }
    function setConn(v) {
      if (connected === v) return;
      connected = v;
      connHandlers.forEach((h) => { try { h(v); } catch (e) {} });
      if (v && Object.keys(mine).length) scheduleTrack();
    }

    ch.on("presence", { event: "sync" }, rebuild);

    const room = {
      name,
      presence(patch) {
        if (left) return Promise.reject({ code: "invalid_argument", message: "left" });
        for (const [k, v] of Object.entries(patch || {})) {
          if (v === null) delete mine[k]; else mine[k] = v;
        }
        scheduleTrack();
        return Promise.resolve();
      },
      peers: () => peers,
      onPeers(handler) {
        peerHandlers.add(handler);
        Promise.resolve().then(() => {
          if (peerHandlers.has(handler)) handler({ peers, joined: peers, left: [], updated: [] });
        });
        return () => peerHandlers.delete(handler);
      },
      connected: () => connected,
      onConnection(handler) {
        connHandlers.add(handler);
        Promise.resolve().then(() => connHandlers.has(handler) && handler(connected));
        return () => connHandlers.delete(handler);
      },
      emit() { return Promise.resolve(); },
      on() { return () => {}; },
      async leave() {
        if (left) return;
        left = true;
        clearTimeout(trackTimer);
        peerHandlers.clear(); connHandlers.clear();
        try { await ch.untrack(); } catch (e) {}
        try { await sb.removeChannel(ch); } catch (e) {}
      },
    };

    const failTimer = setTimeout(() => {
      if (!settled) { settled = true; try { sb.removeChannel(ch); } catch (e) {} reject({ code: "upstream_error", message: "timeout" }); }
    }, 10000);

    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setConn(true);
        if (!settled) { settled = true; clearTimeout(failTimer); resolve(room); }
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setConn(false);
        if (!settled && status !== "CLOSED") { settled = true; clearTimeout(failTimer); reject({ code: "upstream_error", message: status }); }
      }
    });
  });
}
