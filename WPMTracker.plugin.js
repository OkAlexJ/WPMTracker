/**
 * @name WPMTracker
 * @author astricxzs
 * @description Estimates the typing speed (WPM) and typing time of everyone you see typing, using Discord's typing indicators and message timing. Shows a badge on messages (WPM, seconds, or both — click it to cycle), a live counter while you type, and per-user stats.
 * @version 1.1.0
 * @source https://github.com/OkAlexJ/WPMTracker
 */

/*
 * How it works
 * ------------
 * Discord never sends other people's keystrokes, only a TYPING_START event when they
 * begin typing (re-sent roughly every 10s while they keep going). So for other users:
 *
 *     time ≈ first TYPING_START of the burst → message arrives
 *     WPM  ≈ (characters / 5) / time
 *
 * For yourself the plugin sees real keystrokes, so it knows two times:
 *     typing time = time actually spent typing (pauses longer than 2s are capped)
 *     total time  = first keystroke → message sent
 *
 * Results that are implausibly fast (pasted text, drafts typed elsewhere) are discarded.
 */

const DEFAULTS = {
    showBadges: true,
    badgeMode: "both",      // "wpm" | "time" | "both"
    timeSource: "typing",   // "typing" = active typing time, "total" = first keystroke → sent
    colorBadges: true,
    showLive: true,
    showToasts: false,
    trackSelf: true,
    ignoreBots: true,
    wordMode: "standard",   // "standard" = chars / 5, "words" = whitespace-separated words
    minSeconds: 1.5,
    maxWpm: 250,
};

const BADGE_MODES = ["wpm", "time", "both"];
const TYPING_GAP_MS = 15000;    // a typing burst ends if no TYPING_START arrives for this long
const SELF_IDLE_CAP_MS = 2000;  // longest pause between your own keystrokes that counts as typing
const SESSION_TTL_MS = 120000;  // drop sessions that never turned into a message
const LIVE_HIDE_MS = 3000;      // hide the live counter after this long without a keystroke
const HISTORY_LEN = 50;
const BADGE_CACHE = 2000;
const BADGE_PERSIST = 500;      // badges kept across restarts

const CSS = `
.wpmt-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    vertical-align: middle;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted, #949ba4);
    background: var(--background-modifier-accent, rgba(78, 80, 88, 0.48));
    user-select: none;
    cursor: pointer;
}
.wpmt-badge:hover { filter: brightness(1.2); }
.wpmt-badge.wpmt-slow   { color: #b5bac1; }
.wpmt-badge.wpmt-ok     { color: #fff; background: rgba(35, 165, 90, 0.55); }
.wpmt-badge.wpmt-fast   { color: #fff; background: rgba(88, 101, 242, 0.65); }
.wpmt-badge.wpmt-blazing{ color: #fff; background: rgba(235, 69, 158, 0.65); }
.wpmt-live {
    position: fixed;
    z-index: 1000;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-normal, #dbdee1);
    background: var(--background-floating, #111214);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    pointer-events: none;
    transition: opacity 0.2s;
}
.wpmt-panel { color: var(--text-normal, #dbdee1); font-size: 14px; }
.wpmt-panel h3 { margin: 16px 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--header-secondary, #b5bac1); }
.wpmt-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
.wpmt-row input[type="number"], .wpmt-row select, .wpmt-search {
    background: var(--input-background, #1e1f22); color: var(--text-normal, #dbdee1);
    border: none; border-radius: 4px; padding: 6px 8px; font-size: 14px;
}
.wpmt-row input[type="number"] { width: 80px; }
.wpmt-hint { color: var(--text-muted, #949ba4); font-size: 12px; margin: -2px 0 4px; }
.wpmt-search { width: 100%; box-sizing: border-box; margin-bottom: 8px; }
.wpmt-table { width: 100%; border-collapse: collapse; }
.wpmt-table th, .wpmt-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--background-modifier-accent, #3f4147); }
.wpmt-table th { font-size: 12px; color: var(--header-secondary, #b5bac1); cursor: pointer; }
.wpmt-table td.num, .wpmt-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.wpmt-empty { color: var(--text-muted, #949ba4); padding: 12px 0; }
.wpmt-btn {
    margin-top: 12px; padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer;
    background: var(--button-danger-background, #da373c); color: #fff; font-weight: 500;
}
`;

const formatTime = ms => {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
};

const speedClass = wpm => wpm >= 100 ? "wpmt-blazing" : wpm >= 70 ? "wpmt-fast" : wpm >= 40 ? "wpmt-ok" : "wpmt-slow";

module.exports = class WPMTracker {
    constructor(meta) {
        this.meta = meta;
        this.api = new BdApi(meta.name);
        this.sessions = new Map(); // `${channelId}:${userId}` -> { start, last, active, keys, pasted }
        this.badges = new Map();   // messageId or nonce -> { wpm, typingMs, totalMs, chars }
        this.onTyping = this.onTyping.bind(this);
        this.onMessage = this.onMessage.bind(this);
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onPaste = this.onPaste.bind(this);
        this.onBadgeClick = this.onBadgeClick.bind(this);
    }

    start() {
        const { Webpack } = this.api;
        this.UserStore = Webpack.getStore("UserStore");
        this.SelectedChannelStore = Webpack.getStore("SelectedChannelStore");
        this.Dispatcher = this.UserStore?._dispatcher ?? Webpack.getByKeys("subscribe", "unsubscribe", "dispatch");
        if (!this.UserStore || !this.SelectedChannelStore || !this.Dispatcher) {
            this.api.UI.showToast("WPMTracker: couldn't find Discord internals", { type: "error" });
            return;
        }

        this.settings = Object.assign({}, DEFAULTS, this.api.Data.load("settings"));
        this.stats = this.api.Data.load("stats") ?? {};
        for (const [id, b] of Object.entries(this.api.Data.load("badges") ?? {})) this.badges.set(id, b);

        this.Dispatcher.subscribe("TYPING_START", this.onTyping);
        this.Dispatcher.subscribe("MESSAGE_CREATE", this.onMessage);
        document.addEventListener("keydown", this.onKeyDown, true);
        document.addEventListener("paste", this.onPaste, true);
        document.addEventListener("click", this.onBadgeClick, true);
        this.api.DOM.addStyle(CSS);
        this.purgeTimer = setInterval(() => this.purgeSessions(), 30000);
        this.started = true;
        this.scheduleBadges();
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.Dispatcher.unsubscribe("TYPING_START", this.onTyping);
        this.Dispatcher.unsubscribe("MESSAGE_CREATE", this.onMessage);
        document.removeEventListener("keydown", this.onKeyDown, true);
        document.removeEventListener("paste", this.onPaste, true);
        document.removeEventListener("click", this.onBadgeClick, true);
        clearInterval(this.purgeTimer);
        cancelAnimationFrame(this.badgeFrame);
        this.badgeFrame = null;
        this.hideLive(true);
        this.flushSave();
        this.api.DOM.removeStyle();
        document.querySelectorAll(".wpmt-badge").forEach(el => el.remove());
        this.sessions.clear();
        this.badges.clear();
    }

    selfId() {
        return this.UserStore.getCurrentUser()?.id;
    }

    selfKey() {
        const channelId = this.SelectedChannelStore.getChannelId();
        const userId = this.selfId();
        return channelId && userId ? `${channelId}:${userId}` : null;
    }

    // Other users: Discord tells us when they start typing.
    onTyping({ channelId, userId }) {
        if (!channelId || !userId || userId === this.selfId()) return; // self is measured from keystrokes
        if (this.settings.ignoreBots && this.UserStore.getUser(userId)?.bot) return;

        const key = `${channelId}:${userId}`;
        const now = Date.now();
        let s = this.sessions.get(key);
        if (!s || now - s.last > TYPING_GAP_MS) s = { start: now, last: now, active: 0 };
        s.last = now;
        this.sessions.set(key, s);
    }

    // Yourself: count real keystrokes in the message box.
    onKeyDown(e) {
        if (!this.settings.trackSelf) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Enter" && !e.shiftKey) return; // that's the send, handled by MESSAGE_CREATE
        if (e.key.length !== 1 && e.key !== "Backspace" && e.key !== "Enter") return;
        const textbox = e.target?.closest?.('[role="textbox"]');
        if (!textbox) return;

        const key = this.selfKey();
        if (!key) return;

        const now = Date.now();
        let s = this.sessions.get(key);
        if (!s) {
            s = { start: now, last: now, active: 0, keys: 0, pasted: false };
            this.sessions.set(key, s);
        } else {
            s.active += Math.min(now - s.last, SELF_IDLE_CAP_MS);
            s.last = now;
        }
        if (e.key.length === 1) s.keys++;

        // Read the box after the keystroke has landed.
        if (this.settings.showLive) setTimeout(() => this.updateLive(textbox, s), 0);
    }

    onPaste(e) {
        if (!this.settings.trackSelf || !e.target?.closest?.('[role="textbox"]')) return;
        const key = this.selfKey();
        const s = key && this.sessions.get(key);
        if (s) s.pasted = true;
        else if (key) this.sessions.set(key, { start: Date.now(), last: Date.now(), active: 0, keys: 0, pasted: true });
    }

    countWords(text) {
        return this.settings.wordMode === "words" ? (text.match(/\S+/g)?.length ?? 0) : text.length / 5;
    }

    updateLive(textbox, s) {
        if (!this.started || !textbox.isConnected) return this.hideLive();
        const text = textbox.textContent.trim();
        if (!text) return this.hideLive();

        if (!this.liveEl) {
            this.liveEl = document.createElement("div");
            this.liveEl.className = "wpmt-live";
            document.body.appendChild(this.liveEl);
        }
        const ms = Math.max(s.active, 1);
        const wpm = Math.round(this.countWords(text) / (ms / 60000));
        const parts = [];
        if (s.pasted) parts.push("pasted");
        else if (ms >= 1000 && wpm <= this.settings.maxWpm) parts.push(`${wpm} WPM`);
        else parts.push("— WPM");
        parts.push(formatTime(this.settings.timeSource === "total" ? Date.now() - s.start : s.active));
        this.liveEl.textContent = parts.join(" · ");

        const rect = (textbox.closest("form") ?? textbox).getBoundingClientRect();
        this.liveEl.style.top = `${Math.max(rect.top - 28, 4)}px`;
        this.liveEl.style.right = `${Math.max(window.innerWidth - rect.right + 12, 4)}px`;
        this.liveEl.style.opacity = "1";

        clearTimeout(this.liveTimer);
        this.liveTimer = setTimeout(() => this.hideLive(), LIVE_HIDE_MS);
    }

    hideLive(remove = false) {
        clearTimeout(this.liveTimer);
        if (!this.liveEl) return;
        if (remove) { this.liveEl.remove(); this.liveEl = null; }
        else this.liveEl.style.opacity = "0";
    }

    onMessage({ channelId, message }) {
        const author = message?.author;
        if (!author || !channelId) return;

        const key = `${channelId}:${author.id}`;
        const s = this.sessions.get(key);
        if (!s) {
            // Server echo of our own optimistic message: carry the badge over to the real id.
            if (message.nonce && this.badges.has(message.nonce)) {
                this.setBadge(message.id, this.badges.get(message.nonce));
                this.saveSoon();
                this.scheduleBadges();
            }
            return;
        }
        this.sessions.delete(key);

        const isSelf = author.id === this.selfId();
        if (isSelf) this.hideLive();
        const now = Date.now();
        if (!isSelf && now - s.last > TYPING_GAP_MS) return; // they sat on a draft; timing is meaningless

        const content = (message.content ?? "")
            .replace(/<a?:\w+:\d+>/g, ":e:")       // custom emoji
            .replace(/<[@#][!&]?\d+>/g, "@user")   // mentions
            .replace(/<t:\d+(:\w)?>/g, "time")     // timestamps
            .trim();
        if (!content) return;

        // Pasted, or far more text than keys pressed (autocomplete, drafts restored).
        if (isSelf && (s.pasted || content.length > s.keys * 1.3 + 10)) return;

        const totalMs = now - s.start;
        const typingMs = isSelf ? s.active + Math.min(now - s.last, SELF_IDLE_CAP_MS) : totalMs;
        if (typingMs < this.settings.minSeconds * 1000) return;

        const wpm = this.countWords(content) / (typingMs / 60000);
        if (!Number.isFinite(wpm) || wpm > this.settings.maxWpm) return; // probably pasted

        this.record(author, wpm, typingMs);

        const badge = { wpm: Math.round(wpm), typingMs, totalMs, chars: content.length, self: isSelf };
        this.setBadge(message.id, badge);
        if (message.nonce) this.setBadge(message.nonce, badge);
        this.scheduleBadges();

        if (this.settings.showToasts && !isSelf && channelId === this.SelectedChannelStore.getChannelId()) {
            this.api.UI.showToast(`${this.displayName(author)}: ${this.badgeText(badge)}`, { type: "info" });
        }
    }

    displayName(author) {
        return author.globalName ?? author.global_name ?? author.username ?? author.id;
    }

    record(author, wpm, ms) {
        const st = this.stats[author.id] ??= { samples: 0, sum: 0, best: 0, history: [] };
        st.name = this.displayName(author);
        st.username = author.username;
        st.samples++;
        st.sum += wpm;
        st.sumMs = (st.sumMs ?? 0) + ms;
        st.msSamples = (st.msSamples ?? 0) + 1;
        st.best = Math.max(st.best, wpm);
        st.last = wpm;
        st.lastAt = Date.now();
        st.history.push(Math.round(wpm));
        if (st.history.length > HISTORY_LEN) st.history.shift();
        this.saveSoon();
    }

    setBadge(id, badge) {
        this.badges.set(id, badge);
        if (this.badges.size > BADGE_CACHE) this.badges.delete(this.badges.keys().next().value);
    }

    // Older saves stored a bare number.
    normalizeBadge(b) {
        return typeof b === "number" ? { wpm: b } : b;
    }

    badgeTime(b) {
        const ms = this.settings.timeSource === "total" ? b.totalMs ?? b.typingMs : b.typingMs ?? b.totalMs;
        return ms == null ? null : formatTime(ms);
    }

    badgeText(b) {
        b = this.normalizeBadge(b);
        const time = this.badgeTime(b);
        const mode = time == null ? "wpm" : this.settings.badgeMode;
        if (mode === "time") return time;
        if (mode === "both") return `${b.wpm} WPM · ${time}`;
        return `${b.wpm} WPM`;
    }

    badgeTitle(b) {
        b = this.normalizeBadge(b);
        const lines = [`${b.wpm} WPM`];
        if (b.typingMs != null) {
            if (b.self) {
                lines.push(`Typing time: ${formatTime(b.typingMs)}`, `Total time to send: ${formatTime(b.totalMs)}`);
            } else {
                lines.push(`Time to send: ${formatTime(b.totalMs)} (estimated from typing indicator)`);
            }
        }
        if (b.chars != null) lines.push(`${b.chars} characters`);
        lines.push("", "Click to switch: WPM / seconds / both");
        return lines.join("\n");
    }

    onBadgeClick(e) {
        if (!e.target?.classList?.contains("wpmt-badge")) return;
        e.preventDefault();
        e.stopPropagation();
        const i = BADGE_MODES.indexOf(this.settings.badgeMode);
        this.settings.badgeMode = BADGE_MODES[(i + 1) % BADGE_MODES.length];
        this.saveSettings();
        this.refreshBadges();
    }

    purgeSessions() {
        const now = Date.now();
        for (const [key, s] of this.sessions) if (now - s.last > SESSION_TTL_MS) this.sessions.delete(key);
    }

    saveSoon() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flushSave(), 2000);
    }

    flushSave() {
        clearTimeout(this.saveTimer);
        this.api.Data.save("stats", this.stats);
        // Only real message ids (snowflakes) are worth keeping; nonces are temporary.
        const entries = [...this.badges].filter(([id, b]) => /^\d{17,20}$/.test(id) && typeof b === "object");
        this.api.Data.save("badges", Object.fromEntries(entries.slice(-BADGE_PERSIST)));
    }

    saveSettings() {
        this.api.Data.save("settings", this.settings);
    }

    // BetterDiscord calls this for every DOM mutation; re-attach badges after React re-renders.
    observer() {
        if (this.started && this.settings.showBadges && this.badges.size) this.scheduleBadges();
    }

    scheduleBadges() {
        if (this.badgeFrame || !this.settings.showBadges) return;
        this.badgeFrame = requestAnimationFrame(() => {
            this.badgeFrame = null;
            this.renderBadges();
        });
    }

    refreshBadges() {
        document.querySelectorAll(".wpmt-badge").forEach(el => el.remove());
        this.scheduleBadges();
    }

    renderBadges() {
        for (const el of document.querySelectorAll('[id^="message-content-"]')) {
            if (el.querySelector(".wpmt-badge") || el.closest('[id^="message-reply-context"]')) continue;
            const b = this.badges.get(el.id.slice("message-content-".length));
            if (b == null) continue;
            const badge = document.createElement("span");
            badge.className = "wpmt-badge";
            if (this.settings.colorBadges) badge.classList.add(speedClass(this.normalizeBadge(b).wpm));
            badge.textContent = this.badgeText(b);
            badge.title = this.badgeTitle(b);
            el.appendChild(badge);
        }
    }

    getSettingsPanel() {
        const el = (tag, props = {}, ...children) => {
            const node = Object.assign(document.createElement(tag), props);
            node.append(...children);
            return node;
        };
        const panel = el("div", { className: "wpmt-panel" });

        const toggle = (key, label, onChange) => {
            const input = el("input", { type: "checkbox", checked: this.settings[key] });
            input.addEventListener("change", () => {
                this.settings[key] = input.checked;
                this.saveSettings();
                onChange?.(input.checked);
            });
            return el("label", { className: "wpmt-row" }, label, input);
        };
        const number = (key, label, step) => {
            const input = el("input", { type: "number", value: this.settings[key], step, min: 0 });
            input.addEventListener("change", () => {
                const v = parseFloat(input.value);
                if (Number.isFinite(v) && v >= 0) { this.settings[key] = v; this.saveSettings(); }
            });
            return el("label", { className: "wpmt-row" }, label, input);
        };
        const select = (key, label, options, onChange) => {
            const input = el("select", {}, ...options.map(([value, text]) => el("option", { value, textContent: text })));
            input.value = this.settings[key];
            input.addEventListener("change", () => {
                this.settings[key] = input.value;
                this.saveSettings();
                onChange?.(input.value);
            });
            // Not a <label>: the label re-dispatches the click to the <select>, which closes it instantly.
            return el("div", { className: "wpmt-row" }, label, input);
        };
        const refresh = () => this.refreshBadges();

        panel.append(
            el("h3", { textContent: "Badges" }),
            toggle("showBadges", "Show badge on messages", on => on ? this.scheduleBadges() : document.querySelectorAll(".wpmt-badge").forEach(b => b.remove())),
            select("badgeMode", "Badge shows", [
                ["wpm", "WPM only"],
                ["time", "Seconds only"],
                ["both", "WPM + seconds"],
            ], refresh),
            el("div", { className: "wpmt-hint", textContent: "Tip: click any badge in chat to cycle between these." }),
            select("timeSource", "Seconds measure", [
                ["typing", "Time spent typing"],
                ["total", "Total time until sent"],
            ], refresh),
            el("div", { className: "wpmt-hint", textContent: "Only differs for your own messages (pauses are excluded from typing time). For others, both are estimated from the typing indicator." }),
            toggle("colorBadges", "Color badges by speed", refresh),

            el("h3", { textContent: "Tracking" }),
            toggle("showLive", "Show live WPM / timer while I type", on => { if (!on) this.hideLive(); }),
            toggle("trackSelf", "Track my own typing speed"),
            toggle("showToasts", "Toast when someone in the current channel sends a message"),
            toggle("ignoreBots", "Ignore bots"),
            select("wordMode", "Word counting", [
                ["standard", "Standard (5 characters = 1 word)"],
                ["words", "Actual words"],
            ]),
            number("minSeconds", "Ignore messages typed faster than (seconds)", 0.5),
            number("maxWpm", "Discard results above (WPM, likely pasted)", 10),
        );

        // Stats table
        const search = el("input", { className: "wpmt-search", placeholder: "Search users…" });
        const body = el("tbody");
        let sortKey = "avg";
        const columns = [["name", "User"], ["avg", "Avg"], ["best", "Best"], ["last", "Last"], ["avgMs", "Avg time"], ["samples", "Msgs"]];
        const head = el("tr", {}, ...columns.map(([key, label]) => {
            const th = el("th", { className: key === "name" ? "" : "num", textContent: label });
            th.addEventListener("click", () => { sortKey = key; renderRows(); });
            return th;
        }));
        const table = el("table", { className: "wpmt-table" }, el("thead", {}, head), body);
        const empty = el("div", { className: "wpmt-empty", textContent: "No data yet. Stats appear once people type and send messages while the plugin is running." });

        const renderRows = () => {
            const q = search.value.trim().toLowerCase();
            const rows = Object.entries(this.stats)
                .map(([id, st]) => ({ id, ...st, avg: st.sum / st.samples, avgMs: st.msSamples ? st.sumMs / st.msSamples : -1 }))
                .filter(r => !q || r.name?.toLowerCase().includes(q) || r.username?.toLowerCase().includes(q))
                .sort((a, b) => sortKey === "name" ? (a.name ?? "").localeCompare(b.name ?? "") : b[sortKey] - a[sortKey]);
            body.replaceChildren(...rows.map(r => el("tr", {},
                el("td", { textContent: r.name ?? r.id, title: r.username ? `@${r.username}` : r.id }),
                el("td", { className: "num", textContent: Math.round(r.avg) }),
                el("td", { className: "num", textContent: Math.round(r.best) }),
                el("td", { className: "num", textContent: Math.round(r.last) }),
                el("td", { className: "num", textContent: r.avgMs >= 0 ? formatTime(r.avgMs) : "—" }),
                el("td", { className: "num", textContent: r.samples }),
            )));
            table.style.display = rows.length ? "" : "none";
            empty.style.display = rows.length ? "none" : "";
        };
        search.addEventListener("input", renderRows);

        const reset = el("button", { className: "wpmt-btn", textContent: "Reset all stats" });
        reset.addEventListener("click", () => {
            this.api.UI.showConfirmationModal("Reset WPM stats", "Delete all recorded typing speeds?", {
                danger: true,
                confirmText: "Reset",
                onConfirm: () => {
                    this.stats = {};
                    this.badges.clear();
                    this.flushSave();
                    document.querySelectorAll(".wpmt-badge").forEach(b => b.remove());
                    renderRows();
                },
            });
        });

        panel.append(el("h3", { textContent: "Typing speeds" }), search, table, empty, reset);
        renderRows();
        return panel;
    }
};
