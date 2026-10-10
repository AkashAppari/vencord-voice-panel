import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// Self-locating: the harness, its stubs and its bundle all live in this one directory.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const STUBS = path.join(HERE, "stubs");

const esbuild = await import("esbuild").catch(() =>
    import(path.join(ROOT, ".build/vencord/node_modules/esbuild/lib/main.js")));

// 1. Bundle the real plugin source with the Vencord modules stubbed out.
//    react/react-dom and every stub stay external so the bundle and this harness share
//    one module instance - if esbuild inlines the stubs, the harness mutates a different
//    state object than the plugin reads and every check is meaningless.
const STUB_MAP = {
    "@webpack/common": "common.js",
    "@api/Settings": "settings.js",
    "@utils/types": "types.js",
    "@utils/css": "css.js",
    "@utils/Logger": "logger.js",
    "@components/ErrorBoundary": "errorboundary.js",
    "@components/Icons": "icons.js"
};

const OUT = path.join(HERE, "bundle.mjs");

const externalStubs = {
    name: "external-stubs",
    setup(build) {
        for (const [specifier, file] of Object.entries(STUB_MAP)) {
            build.onResolve({ filter: new RegExp(`^${specifier.replace(/[/@]/g, m => "\\" + m)}$`) }, () => ({
                path: "./stubs/" + file,
                external: true
            }));
        }
    }
};

await esbuild.build({
    entryPoints: [path.join(ROOT, "index.tsx")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: OUT,
    jsx: "automatic",
    jsxImportSource: "react",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    loader: { ".css": "empty" },
    plugins: [externalStubs]
});

// 2. A DOM for React to render into.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://discord.com", pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.MutationObserver = window.MutationObserver;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const common = await import(path.join(STUBS, "common.js"));
const plugin = (await import(OUT)).default;

const results = [];
function check(name, condition, detail = "") {
    results.push({ name, ok: !!condition });
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "   <- " + detail}`);
}

const text = () => document.body.textContent ?? "";
const html = () => document.body.innerHTML ?? "";
const rowNames = () => [...document.querySelectorAll(".vc-voiceChannelPanel-row")].map(r => r.textContent.trim());
// The plugin always appends ONE container div to body; "nothing rendered" means no panel inside it.
const panelEl = () => document.querySelector(".vc-voiceChannelPanel-panel");
const logLines = () => [...document.querySelectorAll(".vc-voiceChannelPanel-log-entry")].map(r => r.textContent.trim());

const me = { id: "me", username: "akash", globalName: "Akash", getAvatarURL: () => "me.png" };
function voiceState(userId, channelId, oldChannelId) {
    return {
        userId, channelId, oldChannelId, sessionId: "s1",
        selfMute: false, mute: false, selfDeaf: false, deaf: false,
        selfStream: false, stream: false, selfVideo: false
    };
}

// ---- plugin contract
check("plugin is named VoiceChannelPanel", plugin.name === "VoiceChannelPanel", plugin.name);
check("plugin declares no patches", plugin.patches === undefined, String(plugin.patches));

// ---- not connected to voice: nothing renders
common.state.myChannelId = undefined;
await act(async () => { plugin.start(); });
check("renders nothing while not in a voice channel", panelEl() === null && text().trim() === "", html().slice(0, 160));
await act(async () => { plugin.stop(); });
check("stop() removes its container", document.body.children.length === 0, String(document.body.children.length));

// ---- connected, three members
common.state.myChannelId = "chan1";
common.state.channels = { chan1: { id: "chan1", name: "Game Night", guild_id: "g1" } };
common.state.nicks = { alice: "Alice (nick)" };
common.state.users = {
    me,
    alice: { id: "alice", username: "alice_main", globalName: "Alice", getAvatarURL: () => "a.png" },
    bob: { id: "bob", username: "bobby", globalName: null, getAvatarURL: () => "b.png" }
};
common.state.voiceStates = {
    me: voiceState("me", "chan1", undefined),
    alice: voiceState("alice", "chan1", undefined),
    bob: voiceState("bob", "chan1", undefined)
};

await act(async () => { plugin.start(); });
check("header shows the channel name", text().includes("Game Night"), text());
check("header shows the member count", text().includes("3"), text());
check("nickname is preferred over globalName and username", rowNames().includes("Alice (nick)"), JSON.stringify(rowNames()));
check("falls back to username with no nick or globalName", rowNames().includes("bobby"), JSON.stringify(rowNames()));
check("my own row carries the me class", html().includes("vc-voiceChannelPanel-me"), "no me class");
check("no log section while the log is empty", !html().includes("vc-voiceChannelPanel-log"), html().slice(-300));

// ---- someone leaves
common.state.voiceStates = {
    me: voiceState("me", "chan1", undefined),
    alice: voiceState("alice", "chan1", undefined)
};
await act(async () => {
    common.FluxDispatcher.dispatch("VOICE_STATE_UPDATES", {
        voiceStates: [{ userId: "bob", channelId: null, oldChannelId: "chan1" }]
    });
});
check("leave logs name and HH:MM", /^bobby left - \d{2}:\d{2}$/.test(logLines()[0] ?? ""), JSON.stringify(logLines()));
check("member list drops the leaver", !rowNames().includes("bobby"), JSON.stringify(rowNames()));

// ---- someone joins
common.state.voiceStates = { ...common.state.voiceStates, carol: voiceState("carol", "chan1", undefined) };
common.state.users = {
    ...common.state.users,
    carol: { id: "carol", username: "carol", globalName: "Carol", getAvatarURL: () => "c.png" }
};
await act(async () => {
    common.FluxDispatcher.dispatch("VOICE_STATE_UPDATES", {
        voiceStates: [{ userId: "carol", channelId: "chan1", oldChannelId: undefined }]
    });
});
check("join is logged", /^carol joined - \d{2}:\d{2}$/i.test(logLines()[0] ?? ""), JSON.stringify(logLines()));
check("newest log entry is first", logLines().length === 2, JSON.stringify(logLines()));

// ---- my own transitions are ignored
const before = JSON.stringify(logLines());
await act(async () => {
    common.FluxDispatcher.dispatch("VOICE_STATE_UPDATES", {
        voiceStates: [{ userId: "me", channelId: "chan2", oldChannelId: "chan1" }]
    });
});
check("my own voice transitions are not logged", JSON.stringify(logLines()) === before, JSON.stringify(logLines()));

// ---- a muted member is marked
common.state.voiceStates = {
    me: voiceState("me", "chan1", undefined),
    alice: { ...voiceState("alice", "chan1", undefined), selfMute: true }
};
await act(async () => {
    common.FluxDispatcher.dispatch("VOICE_STATE_UPDATES", {
        voiceStates: [{ userId: "carol", channelId: null, oldChannelId: "chan1" }]
    });
});
const aliceRow = [...document.querySelectorAll(".vc-voiceChannelPanel-row")].find(r => r.textContent.includes("Alice"));
check("a self-muted member shows the mic badge", !!aliceRow?.querySelector('[data-icon="mic"]'), aliceRow?.innerHTML ?? "no alice row");

// ---- Discord's own participant list: resolved nicknames and the speaking indicator
common.state.rtcParticipants = [
    {
        type: 2, user: common.state.users.alice, userNick: "Alice (rtc)", speaking: true,
        voiceState: voiceState("alice", "chan1", undefined)
    },
    {
        type: 2, user: me, userNick: "Akash (rtc)", speaking: false,
        voiceState: { ...voiceState("me", "chan1", undefined), selfMute: true }
    },
    { type: 0, user: common.state.users.bob, userNick: "a stream participant" }
];
await act(async () => { plugin.stop(); });
await act(async () => { plugin.start(); });

check("participant nicknames from the RTC store are used", rowNames().some(n => n.includes("Alice (rtc)")), JSON.stringify(rowNames()));
check("stream participants are not listed as members", !rowNames().some(n => n.includes("a stream participant")), JSON.stringify(rowNames()));

const speakingRow = document.querySelector(".vc-voiceChannelPanel-speaking");
check("the speaking member is marked as speaking", !!speakingRow && speakingRow.textContent.includes("Alice (rtc)"), html().slice(-700));

const akashRow = [...document.querySelectorAll(".vc-voiceChannelPanel-row")].find(r => r.textContent.includes("Akash (rtc)"));
check("a member who is not speaking is not marked", !!akashRow && !akashRow.classList.contains("vc-voiceChannelPanel-speaking"), akashRow?.outerHTML ?? "no row");
check("mute coming from the RTC voice state is marked", !!akashRow?.classList.contains("vc-voiceChannelPanel-quiet") && !!akashRow?.querySelector('[data-icon="mic"]'), akashRow?.outerHTML ?? "no row");

// back to voice states for the remaining checks
common.state.rtcParticipants = [];
await act(async () => { plugin.stop(); });
await act(async () => { plugin.start(); });

// ---- dragging writes settings and stays on screen
const header = document.querySelector(".vc-voiceChannelPanel-header");
const settingsModule = await import(path.join(STUBS, "settings.js"));
const startLeft = settingsModule.store.offsetLeft;
await act(async () => {
    header.dispatchEvent(new window.MouseEvent("mousedown", { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 140, clientY: 60, bubbles: true }));
});
await act(async () => { await new Promise(r => setTimeout(r, 40)); });
check("drag updates offsetLeft", settingsModule.store.offsetLeft === startLeft + 40, String(settingsModule.store.offsetLeft));
check("drag updates offsetBottom", settingsModule.store.offsetBottom === 160, String(settingsModule.store.offsetBottom));
await act(async () => {
    window.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 99999, clientY: -99999, bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
});
check("drag is clamped inside the viewport",
    settingsModule.store.offsetLeft <= window.innerWidth - 80 && settingsModule.store.offsetBottom >= 0,
    `left=${settingsModule.store.offsetLeft} bottom=${settingsModule.store.offsetBottom} w=${window.innerWidth}`);

// ---- docking: sits in the sidebar column above the account panel / music card
// The music card only exists while a track is playing (SpotifyControls' Player returns null
// otherwise), so the panel has to dock when the column appears later, not only at startup.
await act(async () => { plugin.stop(); });
await act(async () => { plugin.start(); });
await act(async () => { await new Promise(r => setTimeout(r, 60)); });
check("floats while there is nothing to dock above", panelEl()?.style.position === "fixed", panelEl()?.getAttribute("style") ?? "(no style)");

// Discord's bottom-left stack, with the account panel as its last child
const accountPanel = document.createElement("div");
accountPanel.className = "panels_accountPanel";
const column = document.createElement("div");
column.className = "panels_a4d4d9";
column.appendChild(accountPanel);
document.body.appendChild(column);
await act(async () => { await new Promise(r => setTimeout(r, 60)); });

const mount = document.querySelector(".vc-voiceChannelPanel-mount");
check("docks when the sidebar column appears after startup", accountPanel.previousElementSibling === mount, String(accountPanel.previousElementSibling?.className));
check("the docked mount is flagged", !!mount?.classList.contains("vc-voiceChannelPanel-mount-docked"), mount?.className);
check("a docked panel stops positioning itself as an overlay", panelEl()?.style.position === "", panelEl()?.getAttribute("style") ?? "(no style attribute)");

const leftBeforeDockDrag = settingsModule.store.offsetLeft;
await act(async () => {
    document.querySelector(".vc-voiceChannelPanel-header").dispatchEvent(new window.MouseEvent("mousedown", { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 300, clientY: 40, bubbles: true }));
});
await act(async () => { await new Promise(r => setTimeout(r, 40)); });
window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
check("dragging a docked panel does not move it", settingsModule.store.offsetLeft === leftBeforeDockDrag, String(settingsModule.store.offsetLeft));

// a track starts: the card appears and the panel moves above it
const musicCard = document.createElement("div");
musicCard.id = "vc-spotify-player";
column.insertBefore(musicCard, accountPanel);
await act(async () => { await new Promise(r => setTimeout(r, 60)); });
check("moves above the music card once one exists", musicCard.previousElementSibling === mount, String(musicCard.previousElementSibling?.className));

// the track stops: the card goes, the panel stays docked instead of jumping back out
await act(async () => { musicCard.remove(); });
await act(async () => { await new Promise(r => setTimeout(r, 60)); });
check("stays docked when the music card goes away", mount?.parentElement === column && !!mount?.classList.contains("vc-voiceChannelPanel-mount-docked"), String(mount?.parentElement?.className));

// the whole column is torn down: back to the floating panel at the saved offsets
await act(async () => { column.remove(); });
await act(async () => { await new Promise(r => setTimeout(r, 60)); });
check("floats again when the dock column is gone", panelEl()?.style.position === "fixed" && document.body.contains(mount), panelEl()?.getAttribute("style") ?? "(no style attribute)");

// ---- disconnecting clears the panel and the log
common.state.myChannelId = undefined;
await act(async () => { plugin.stop(); });
await act(async () => { plugin.start(); });
check("panel disappears after disconnecting", panelEl() === null && text().trim() === "", html().slice(0, 160));
check("log is cleared with the panel", logLines().length === 0, JSON.stringify(logLines()));

await act(async () => { plugin.stop(); });
check("container removed at the end", document.body.children.length === 0, String(document.body.children.length));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
