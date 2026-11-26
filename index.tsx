/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Microphone, ScreenshareIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelRTCStore,
    ChannelStore,
    createRoot,
    FluxDispatcher,
    GuildMemberStore,
    PopoutActions,
    PopoutWindowStore,
    SelectedChannelStore,
    useEffect,
    useRef,
    UserStore,
    useState,
    useStateFromStores,
    VoiceStateStore
} from "@webpack/common";

const cl = classNameFactory("vc-voiceChannelPanel-");
const logger = new Logger("VoiceChannelPanel");

// ParticipantType.USER from Vencord's discord-types. That module declares it as a `const enum`,
// which esbuild cannot inline at runtime, so the value is spelled out here rather than imported.
const PARTICIPANT_TYPE_USER: number = 2;

const AVATAR_SIZE = 24;
// 16 is the smallest size at which the diagonal bar on the muted and deafened glyphs still reads as
// a separate mark; at 14 both slashed icons turned to mush against the unslashed ones.
const BADGE_ICON_SIZE = 16;
// Floating mode only: the stacking order the panel was tuned to against the live client.
const FLOATING_Z_INDEX = 1002;
// While dragging, keep at least this much of the panel on screen so it can always be grabbed again
// (horizontally on either edge, vertically below the top).
const DRAG_MIN_VISIBLE_X = 80;
const DRAG_MIN_VISIBLE_Y = 60;

const POPOUT_KEY = "VOICE_CHANNEL_PANEL";
const POPOUT_POLL_MS = 100;
const POPOUT_WAIT_MS = 3000;

/*
 * Vencord re-exports Discord's own icons in `@components/Icons`, but that set carries no headphone
 * and no camera glyph - only `Microphone` and `ScreenshareIcon`. These two are drawn here in the
 * same 24x24 filled style so all four badges sit at the same weight, rather than adding a dependency
 * for two shapes. Proportions were checked at the rendered size rather than by eye on the numbers.
 */
function HeadphonesIcon({ size }: { size: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M5.2 15V11.2a6.8 6.8 0 0 1 13.6 0V15h-2.6v-3.8a4.2 4.2 0 0 0-8.4 0V15z" />
            <rect x="2.6" y="13.2" width="4.2" height="7" rx="2.1" />
            <rect x="17.2" y="13.2" width="4.2" height="7" rx="2.1" />
        </svg>
    );
}

function VideoIcon({ size }: { size: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="2" y="6.5" width="13.8" height="11" rx="2.8" />
            <path d="M15.8 10.4 21.2 7.6v8.8l-5.4-2.8z" />
        </svg>
    );
}

function PopOutIcon({ size }: { size: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M14 3h7v7h-2.4V7.1l-7.2 7.2-1.7-1.7 7.2-7.2H14z" />
            <path d="M5 5.5h6V8H6.5v9.5H16V13h2.5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5z" />
        </svg>
    );
}

function PinIcon({ size }: { size: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6.6" y="3" width="10.8" height="4.4" rx="1.6" />
            <rect x="10" y="7.4" width="4" height="4" />
            <path d="M11.2 11.4h1.6v9.4h-1.6z" />
        </svg>
    );
}

function CloseIcon({ size }: { size: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6.4 4.6 12 10.2l5.6-5.6 1.8 1.8-5.6 5.6 5.6 5.6-1.8 1.8-5.6-5.6-5.6 5.6-1.8-1.8 5.6-5.6-5.6-5.6z" />
        </svg>
    );
}

// Vencord's own SpotifyControls renders its card as `<div id="vc-spotify-player">`, a sibling of
// Discord's account panel. Docking above it therefore means putting our node immediately before it
// in that column, so the sidebar lays the two out together instead of us floating over whatever is
// behind us. An id is far more stable than Discord's hashed class names.
const DOCK_ANCHOR_ID = "vc-spotify-player";
const MOUNT_CLASS = "vc-voiceChannelPanel-mount";
const MOUNT_DOCKED_CLASS = "vc-voiceChannelPanel-mount-docked";

/**
 * Where to dock, in order of preference:
 *
 * 1. The music card, so the panel sits directly above it while a track is playing.
 * 2. Otherwise Discord's own bottom-left stack, inserted above the account panel (its last child).
 *    That is the `[class*="panels"]` element Vencord's own gameActivityToggle and callTimer target.
 *    It matters because SpotifyControls' Player returns null unless a track is playing, so relying
 *    on the card alone would only ever dock the panel while music happened to be on.
 *
 * Returns null when neither exists, in which case the panel stays a floating overlay.
 */
function findDockTarget(): { anchor: HTMLElement; column: HTMLElement; } | null {
    const musicCard = document.getElementById(DOCK_ANCHOR_ID);
    if (musicCard?.parentElement) return { anchor: musicCard, column: musicCard.parentElement };

    for (const column of document.querySelectorAll<HTMLElement>('[class^="panels_"], [class*=" panels_"]')) {
        const accountPanel = column.lastElementChild;
        if (accountPanel instanceof HTMLElement && accountPanel !== container)
            return { anchor: accountPanel, column };
    }

    return null;
}

const settings = definePluginSettings({
    offsetLeft: {
        type: OptionType.NUMBER,
        description: "Distance from the left edge of the window, in pixels",
        default: 76
    },
    offsetBottom: {
        type: OptionType.NUMBER,
        description: "Distance from the bottom edge of the window, in pixels",
        default: 120
    },
    width: {
        type: OptionType.NUMBER,
        description: "Width of the panel, in pixels",
        default: 220
    },
    logSize: {
        type: OptionType.NUMBER,
        description: "How many join and leave entries to keep in the log",
        default: 8
    },
    showJoins: {
        type: OptionType.BOOLEAN,
        description: "Log when someone joins your voice channel",
        default: true
    },
    showLog: {
        type: OptionType.BOOLEAN,
        description: "Show the join and leave log below the member list",
        default: true
    },
    popoutAlwaysOnTop: {
        type: OptionType.BOOLEAN,
        description: "Keep the popped-out panel above other windows (the pin button toggles it while open)",
        default: true
    },
    popoutTransparent: {
        type: OptionType.BOOLEAN,
        description: "Give the popped-out panel a transparent window background. Applied when the window is opened, so reopen it to change this",
        default: true
    },
    popoutFrameless: {
        type: OptionType.BOOLEAN,
        description: "Open the popped-out panel without a window frame. Applied when the window is opened, so reopen it to change this",
        default: true
    }
});

interface VoiceStateChangeEvent {
    userId: string;
    channelId: string | null;
    oldChannelId: string | undefined;
    sessionId?: string;
}

interface LogEntry {
    id: number;
    channelId: string;
    text: string;
    kind: "join" | "leave";
}

interface DragStartEvent {
    clientX: number;
    clientY: number;
}

// The mute/deaf/stream/video flags, which voice-state objects and RTC participants both carry.
interface VoiceFlags {
    selfMute?: boolean;
    mute?: boolean;
    selfDeaf?: boolean;
    deaf?: boolean;
    selfStream?: boolean;
    stream?: boolean;
    selfVideo?: boolean;
}

// The slice of an RTC participant this plugin reads; the store's own typings do not expose it.
interface RtcParticipant {
    type: number;
    user?: NonNullable<ReturnType<typeof UserStore.getUser>>;
    userNick?: string;
    speaking?: boolean;
    voiceState?: VoiceFlags & { guildId?: string; };
}

interface MemberRow {
    userId: string;
    name: string;
    avatarUrl: string;
    speaking: boolean;
    mute: boolean;
    deaf: boolean;
    stream: boolean;
    video: boolean;
    isMe: boolean;
}

// `||`, not `??`: an empty string is just as unusable as undefined here, and some stores hand
// back "" for "no nickname" instead of null. `rtcNick` is the nickname Discord's participant list
// already resolved; it wins when present.
function displayName(userId: string, guildId: string | null | undefined, fallback: string, rtcNick?: string) {
    const user = UserStore.getUser(userId);
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : null;

    return rtcNick || nick || user?.globalName || user?.username || fallback;
}

function flagsOf(vs: VoiceFlags | undefined): Pick<MemberRow, "mute" | "deaf" | "stream" | "video"> {
    return {
        mute: !!(vs?.selfMute || vs?.mute),
        deaf: !!(vs?.selfDeaf || vs?.deaf),
        stream: !!(vs?.selfStream || vs?.stream),
        video: !!vs?.selfVideo
    };
}

function rowsEqual(a: MemberRow[], b: MemberRow[]) {
    return a.length === b.length && a.every((row, i) =>
        (Object.keys(row) as (keyof MemberRow)[]).every(key => row[key] === b[i][key]));
}

/**
 * Discord's own participant list for a voice channel. This is what the normal voice UI renders,
 * and it carries the resolved nickname (`userNick`) and the live `speaking` flag, so names here
 * cannot disagree with what Discord shows.
 */
function rowsFromRTC(channelId: string): MemberRow[] {
    const myId = UserStore.getCurrentUser()?.id;
    const guildId = ChannelStore.getChannel(channelId)?.guild_id;

    return ChannelRTCStore.getParticipants(channelId)
        .map(p => p as unknown as RtcParticipant)
        .filter((p): p is RtcParticipant & { user: NonNullable<RtcParticipant["user"]>; } =>
            p.type === PARTICIPANT_TYPE_USER && !!p.user)
        .map(p => {
            const vs = p.voiceState;
            const rowGuildId = vs?.guildId ?? guildId;

            return {
                userId: p.user.id,
                name: displayName(p.user.id, rowGuildId, "Unknown", p.userNick),
                avatarUrl: p.user.getAvatarURL(rowGuildId, AVATAR_SIZE),
                speaking: !!p.speaking,
                ...flagsOf(vs),
                isMe: p.user.id === myId
            };
        });
}

/** Fallback for when the RTC participant list is not populated: voice states straight from the store. */
function rowsFromVoiceStates(channelId: string): MemberRow[] {
    const myId = UserStore.getCurrentUser()?.id;
    const guildId = ChannelStore.getChannel(channelId)?.guild_id;

    return Object.values(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {})
        .filter(state => !!state?.userId)
        .map(state => {
            const { userId } = state;
            const user = UserStore.getUser(userId);

            return {
                userId,
                name: displayName(userId, guildId, "Unknown"),
                // A row with no resolvable user still renders, so a missing entity can never
                // silently empty the whole member list.
                avatarUrl: user?.getAvatarURL(guildId, AVATAR_SIZE) ?? "",
                speaking: false,
                ...flagsOf(state),
                isMe: userId === myId
            };
        });
}

function readRows(channelId: string): MemberRow[] {
    try {
        const rtc = rowsFromRTC(channelId);
        if (rtc.length) return rtc;
    } catch (err) {
        logger.error("Could not read the RTC participant list, falling back to voice states", err);
    }

    try {
        return rowsFromVoiceStates(channelId);
    } catch (err) {
        logger.error("Could not read voice states", err);
        return [];
    }
}

/** The name to log a join or leave under, preferring the nickname Discord itself would show. */
function nameForLog(userId: string, channelId: string, fallback: string) {
    let rtcNick: string | undefined;

    try {
        rtcNick = (ChannelRTCStore.getParticipant(channelId, userId) as unknown as RtcParticipant | undefined)?.userNick;
    } catch {
        // fall through to the store-based lookup below
    }

    return displayName(userId, ChannelStore.getChannel(channelId)?.guild_id, fallback, rtcNick);
}

/*
 * The join/leave log lives at module level rather than in Panel's state, so the popout window shows
 * the same entries. Panel (always mounted while the plugin runs) is still the only writer.
 */
let sharedLog: LogEntry[] = [];
const logListeners = new Set<(log: LogEntry[]) => void>();

function setLog(update: (prev: LogEntry[]) => LogEntry[]) {
    const next = update(sharedLog);
    if (next === sharedLog) return;
    sharedLog = next;
    logListeners.forEach(listener => listener(next));
}

function useLog() {
    const [log, setLocal] = useState(sharedLog);

    useEffect(() => {
        logListeners.add(setLocal);
        setLocal(sharedLog);
        return () => { logListeners.delete(setLocal); };
    }, []);

    return log;
}

function useVoiceRows() {
    const channelId = useStateFromStores(
        [SelectedChannelStore, VoiceStateStore],
        () => SelectedChannelStore.getVoiceChannelId()
    );

    const rows = useStateFromStores(
        [VoiceStateStore, UserStore, ChannelStore, ChannelRTCStore],
        () => (channelId ? readRows(channelId) : []),
        undefined,
        // readRows builds fresh objects every call; without this every store tick re-renders.
        rowsEqual
    );

    return { channelId, rows };
}

/** The member rows and the join/leave log, shared by the docked/floating panel and the popout. */
function PanelBody({ rows, log, showLog }: { rows: MemberRow[]; log: LogEntry[]; showLog: boolean; }) {
    return (
        <>
            <div className={cl("members")}>
                {rows.map(row => (
                    <div
                        key={row.userId}
                        className={[
                            cl("row"),
                            row.isMe && cl("me"),
                            row.speaking && cl("speaking"),
                            (row.mute || row.deaf) && cl("quiet")
                        ].filter(Boolean).join(" ")}
                    >
                        {row.avatarUrl
                            ? <img className={cl("avatar")} src={row.avatarUrl} alt="" />
                            : <span className={cl("avatar")} />}
                        <span className={cl("name")}>{row.name}</span>
                        <span className={cl("badges")}>
                            {row.mute && <span className={cl("badge-icon", "badge-slashed")} role="img" title="Muted" aria-label="Muted"><Microphone height={BADGE_ICON_SIZE} width={BADGE_ICON_SIZE} /></span>}
                            {row.deaf && <span className={cl("badge-icon", "badge-slashed")} role="img" title="Deafened" aria-label="Deafened"><HeadphonesIcon size={BADGE_ICON_SIZE} /></span>}
                            {row.stream && <span className={cl("badge-icon")} role="img" title="Streaming" aria-label="Streaming"><ScreenshareIcon height={BADGE_ICON_SIZE} width={BADGE_ICON_SIZE} /></span>}
                            {row.video && <span className={cl("badge-icon")} role="img" title="Camera on" aria-label="Camera on"><VideoIcon size={BADGE_ICON_SIZE} /></span>}
                        </span>
                    </div>
                ))}
            </div>
            {showLog && log.length > 0 && (
                <div className={cl("log")} role="log" aria-live="polite" aria-relevant="additions" aria-label="Join and leave activity">
                    {log.map(entry => (
                        <div key={entry.id} className={cl("log-entry", entry.kind)}>{entry.text}</div>
                    ))}
                </div>
            )}
        </>
    );
}

/*
 * The popout window gets a fresh document that style.css never reaches, so its whole look lives
 * here and is injected by openPopout(). Literal colours: Discord's theme variables are not defined
 * in that document. Everything is scoped under the popout root so it cannot leak.
 */
export const POPOUT_CSS = `
.vc-voiceChannelPanel-popout { box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; height: 100vh; padding: 8px 12px; overflow: hidden; font-family: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 12px; color: #fff; background: #1e1f22; border-radius: 10px; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-header { display: flex; align-items: center; gap: 4px; padding: 2px 4px; color: #b5bac1; font-weight: 600; user-select: none; -webkit-app-region: drag; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-count { flex: 0 0 auto; color: #b5bac1; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-icon-button { display: inline-flex; padding: 4px; margin: -4px; border: 0; border-radius: 4px; background: none; color: #b5bac1; cursor: pointer; -webkit-app-region: no-drag; transition: color 120ms ease, background-color 120ms ease; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-icon-button:hover, .vc-voiceChannelPanel-popout .vc-voiceChannelPanel-icon-button[aria-pressed="true"] { color: #fff; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-icon-button:hover { background-color: #383a40; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-icon-button:focus-visible { outline: 2px solid #00a8fc; outline-offset: 1px; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-members { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-row { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 4px; transition: background-color 120ms ease; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-row:hover { background: rgb(255 255 255 / 6%); }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-me { font-weight: 600; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-avatar { width: 20px; height: 20px; border-radius: 50%; flex: 0 0 auto; background: #3f4147; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-speaking .vc-voiceChannelPanel-avatar { box-shadow: 0 0 0 2px #23a55a; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-quiet .vc-voiceChannelPanel-avatar { opacity: 0.55; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fff; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-speaking .vc-voiceChannelPanel-name { font-weight: 600; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-quiet .vc-voiceChannelPanel-name { color: #b5bac1; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-badges { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; color: #b5bac1; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-badge-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; color: inherit; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-badge-slashed::after { content: ""; position: absolute; left: 50%; top: 50%; width: 2px; height: 132%; border-radius: 1px; background: currentcolor; box-shadow: 0 0 0 1.6px #1e1f22; transform: translate(-50%, -50%) rotate(-45deg); }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-log { display: flex; flex-direction: column; gap: 2px; flex: 0 1 auto; max-height: 35%; overflow-y: auto; padding-top: 4px; border-top: 1px solid #3f4147; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-log-entry { font-size: 11px; color: #b5bac1; }
.vc-voiceChannelPanel-popout .vc-voiceChannelPanel-leave { color: #ff8a8a; }
@media (prefers-reduced-motion: reduce) { .vc-voiceChannelPanel-popout .vc-voiceChannelPanel-icon-button, .vc-voiceChannelPanel-popout .vc-voiceChannelPanel-row { transition: none; } }
`;

let popoutPoll: ReturnType<typeof setInterval> | undefined;

function stopPopoutPoll() {
    clearInterval(popoutPoll);
    popoutPoll = undefined;
}

function injectPopoutStyles(doc: Document) {
    const style = doc.createElement("style");
    style.textContent = POPOUT_CSS;
    doc.head.appendChild(style);
    doc.body.style.margin = "0";

    if (settings.store.popoutTransparent) {
        doc.documentElement.style.background = "transparent";
        doc.body.style.background = "transparent";
    }
}

function openPopout() {
    try {
        if (PopoutWindowStore.getWindowOpen(POPOUT_KEY)) return;

        PopoutActions.open(POPOUT_KEY, () => <PopoutPanel />, {
            width: 264, height: 300, defaultWidth: 264, defaultHeight: 300,
            frame: !settings.store.popoutFrameless,
            transparent: settings.store.popoutTransparent,
            alwaysOnTop: settings.store.popoutAlwaysOnTop,
            defaultAlwaysOnTop: settings.store.popoutAlwaysOnTop,
            movable: true, resizable: true, skipTaskbar: true,
            backgroundColor: settings.store.popoutTransparent ? "#00000000" : "#1e1f22"
        });
    } catch (err) {
        logger.error("Could not open the popout window", err);
        return;
    }

    stopPopoutPoll();
    const startedAt = Date.now();
    let seenOpen = false;

    popoutPoll = setInterval(() => {
        try {
            const isOpen = PopoutWindowStore.getWindowOpen(POPOUT_KEY);
            if (isOpen) seenOpen = true;
            else if (seenOpen) return stopPopoutPoll(); // closed again before its document showed up

            const doc = PopoutWindowStore.getWindow(POPOUT_KEY)?.document;
            if (doc?.head && doc.body) {
                injectPopoutStyles(doc);
                return stopPopoutPoll();
            }

            if (Date.now() - startedAt >= POPOUT_WAIT_MS) {
                stopPopoutPoll();
                if (!isOpen) console.warn("[VoiceChannelPanel] popout window did not open");
            }
        } catch (err) {
            stopPopoutPoll();
            logger.error("Could not style the popout window", err);
        }
    }, POPOUT_POLL_MS);
}

function PopoutPanel() {
    const { channelId, rows } = useVoiceRows();
    const log = useLog();
    const { showLog } = settings.use(["showLog"]);
    const [onTop, setOnTop] = useState(() => PopoutWindowStore.getIsAlwaysOnTop(POPOUT_KEY));
    const rootRef = useRef<HTMLDivElement>(null);

    const togglePin = () => {
        const next = !onTop;
        PopoutActions.setAlwaysOnTop(POPOUT_KEY, next);
        settings.store.popoutAlwaysOnTop = next;
        setOnTop(next);
    };

    // Discord may apply the alwaysOnTop flag just after the first read, so check once more.
    useEffect(() => {
        const timer = setTimeout(() => setOnTop(PopoutWindowStore.getIsAlwaysOnTop(POPOUT_KEY)), 400);
        return () => clearTimeout(timer);
    }, []);

    // Leaving or disconnecting from voice closes the window rather than leaving an empty list.
    useEffect(() => {
        if (channelId) return;
        try {
            PopoutActions.close(POPOUT_KEY);
        } catch (err) {
            logger.error("Could not close the popout window", err);
        }
    }, [channelId]);

    // Escape closes the window, unless the key is meant for a text field. Listen on the popout's own
    // document, which is not the global one.
    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (!doc) return;
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (event.key !== "Escape" || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
            try {
                PopoutActions.close(POPOUT_KEY);
            } catch (err) {
                logger.error("Could not close the popout window", err);
            }
        };
        doc.addEventListener("keydown", onKeyDown);
        return () => doc.removeEventListener("keydown", onKeyDown);
    }, []);

    const channel = channelId ? ChannelStore.getChannel(channelId) : undefined;

    return (
        <div className={cl("popout")} ref={rootRef}>
            <div className={cl("header")}>
                <span className={cl("title")}>{channel?.name ?? "Voice"}</span>
                <span className={cl("count")}>{rows.length}</span>
                <button
                    type="button"
                    className={cl("icon-button")}
                    aria-label="Keep on top"
                    title="Keep on top"
                    aria-pressed={onTop}
                    onClick={togglePin}
                >
                    <PinIcon size={BADGE_ICON_SIZE} />
                </button>
                <button
                    type="button"
                    className={cl("icon-button")}
                    aria-label="Close voice panel window"
                    title="Close voice panel window"
                    onClick={() => PopoutActions.close(POPOUT_KEY)}
                >
                    <CloseIcon size={BADGE_ICON_SIZE} />
                </button>
            </div>
            <PanelBody rows={rows} log={log.filter(entry => entry.channelId === channelId)} showLog={showLog} />
        </div>
    );
}

function Panel() {
    const { channelId, rows } = useVoiceRows();

    const { offsetLeft, offsetBottom, width, showLog } = settings.use([
        "offsetLeft", "offsetBottom", "width", "showLog"
    ]);

    const inVoice = !!channelId;

    const log = useLog();
    const [docked, setDocked] = useState(false);
    const dockColumn = useRef<HTMLElement | null>(null);
    const dragCleanup = useRef<(() => void) | null>(null);

    /**
     * Docking. The panel floats until there is something in Discord's bottom-left stack to sit
     * above - the music card while a track is playing, otherwise the account panel - at which point
     * it moves into that column and stops positioning itself. With neither, it stays floating at
     * the offsets in its settings.
     */
    useEffect(() => {
        // Nothing is rendered outside a call, so there is nothing to place - and no reason to
        // watch every DOM mutation in the client.
        if (!inVoice) return;

        let frame = 0;

        const applyDock = () => {
            if (!container) return;

            const target = findDockTarget();

            if (target) {
                if (container.parentElement !== target.column || container.nextElementSibling !== target.anchor)
                    target.column.insertBefore(container, target.anchor);

                dockColumn.current = target.column;
            } else if (dockColumn.current?.isConnected) {
                // Docked already and the anchor is gone (the track stopped): stay exactly where we
                // are, rather than dumping ourselves back out as a floating overlay.
                if (container.parentElement !== dockColumn.current)
                    dockColumn.current.insertBefore(container, dockColumn.current.lastElementChild);
            } else {
                dockColumn.current = null;
                container.classList.remove(MOUNT_DOCKED_CLASS);
                if (container.parentElement !== document.body) document.body.appendChild(container);

                setDocked(current => current ? false : current);
                return;
            }

            container.classList.add(MOUNT_DOCKED_CLASS);
            setDocked(current => current || true);
        };

        const schedule = () => {
            if (frame) return;

            frame = requestAnimationFrame(() => {
                frame = 0;
                applyDock();
            });
        };

        applyDock();

        // The music card comes and goes with playback and Discord re-renders that column often
        // (React will not preserve a node it does not own), so re-check on every DOM change -
        // throttled to one pass per frame and idempotent, so it cannot loop on its own writes.
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });

        window.addEventListener("resize", schedule);

        return () => {
            observer.disconnect();
            window.removeEventListener("resize", schedule);
            if (frame) cancelAnimationFrame(frame);
            container?.classList.remove(MOUNT_DOCKED_CLASS);
            dockColumn.current = null;
        };
    }, [inVoice]);

    // Entries are tagged with their channel and filtered at render, so the previous channel's log
    // never shows for the frame before this effect clears it.
    useEffect(() => {
        setLog(prev => prev.length ? [] : prev);
    }, [channelId]);

    useEffect(() => {
        if (!channelId) return;

        const handler = (e: { voiceStates: VoiceStateChangeEvent[]; }) => {
            try {
                const myId = UserStore.getCurrentUser()?.id;

                for (const state of e.voiceStates) {
                    if (state.userId === myId) continue;

                    const left = state.oldChannelId === channelId && state.channelId !== channelId;
                    const joined = state.channelId === channelId && state.oldChannelId !== channelId;

                    if (!left && !(joined && settings.store.showJoins)) continue;

                    const kind: LogEntry["kind"] = left ? "leave" : "join";
                    const name = nameForLog(state.userId, channelId, "Someone");
                    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
                    const text = `${name} ${kind === "leave" ? "left" : "joined"} - ${time}`;

                    setLog(prev => [{ id: Date.now() + Math.random(), channelId, text, kind }, ...prev].slice(0, settings.store.logSize));
                }
            } catch (err) {
                logger.error("Failed to handle a voice state update", err);
            }
        };

        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", handler);
        return () => FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", handler);
    }, [channelId]);

    useEffect(() => () => {
        dragCleanup.current?.();
    }, []);

    const onHeaderMouseDown = (e: DragStartEvent) => {
        // A docked panel is laid out by the sidebar column, so there is nothing to drag.
        if (docked) return;

        dragCleanup.current?.();

        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = settings.store.offsetLeft;
        const startBottom = settings.store.offsetBottom;

        let frame = 0;

        const onMove = (moveEvent: MouseEvent) => {
            // Coalesce to one write per frame: every assignment to settings.store is
            // persisted to disk over IPC, so unthrottled mousemove writes flood it.
            if (frame) return;

            frame = requestAnimationFrame(() => {
                frame = 0;

                const maxLeft = window.innerWidth - DRAG_MIN_VISIBLE_X;
                const minLeft = DRAG_MIN_VISIBLE_X - settings.store.width;
                const left = Math.min(Math.max(startLeft + (moveEvent.clientX - startX), minLeft), maxLeft);
                const bottom = Math.min(Math.max(startBottom - (moveEvent.clientY - startY), 0), window.innerHeight - DRAG_MIN_VISIBLE_Y);

                settings.store.offsetLeft = left;
                settings.store.offsetBottom = bottom;
            });
        };

        const stopDrag = () => {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", stopDrag);
            dragCleanup.current = null;
        };

        dragCleanup.current = stopDrag;
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", stopDrag);
    };

    if (!channelId) return null;

    const channel = ChannelStore.getChannel(channelId);
    const visibleLog = log.filter(entry => entry.channelId === channelId);

    return (
        <div
            role="region"
            aria-label={`${channel?.name ?? "Voice"} members`}
            className={[cl("panel"), docked && cl("docked")].filter(Boolean).join(" ")}
            style={docked ? undefined : {
                position: "fixed",
                left: `${offsetLeft}px`,
                bottom: `${offsetBottom}px`,
                width: `${width}px`,
                zIndex: FLOATING_Z_INDEX
            }}
        >
            <div className={cl("header")} onMouseDown={onHeaderMouseDown}>
                <span className={cl("title")}>{channel?.name ?? "Voice"}</span>
                <span className={cl("actions")}>
                    <span className={cl("count")}>{rows.length}</span>
                    <button
                        type="button"
                        className={cl("icon-button")}
                        aria-label="Pop out voice panel"
                        title="Pop out voice panel"
                        // Keep the click from starting a drag of the floating panel.
                        onMouseDown={e => e.stopPropagation()}
                        onClick={openPopout}
                    >
                        <PopOutIcon size={BADGE_ICON_SIZE} />
                    </button>
                </span>
            </div>
            <PanelBody rows={rows} log={visibleLog} showLog={showLog} />
        </div>
    );
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const PanelWithErrorBoundary = ErrorBoundary.wrap(Panel);

export default definePlugin({
    name: "VoiceChannelPanel",
    description: "Shows a live member list of your current voice channel above the user area, with a join and leave log",
    tags: ["Voice", "Utility"],
    authors: [{ name: "Akash", id: 0n }],
    settings,

    start() {
        container = document.createElement("div");
        container.className = MOUNT_CLASS;
        document.body.appendChild(container);
        root = createRoot(container);
        root.render(<PanelWithErrorBoundary />);
    },

    stop() {
        stopPopoutPoll();
        try {
            if (PopoutWindowStore.getWindowOpen(POPOUT_KEY)) PopoutActions.close(POPOUT_KEY);
        } catch (err) {
            logger.error("Could not close the popout window", err);
        }
        sharedLog = [];
        root?.unmount();
        root = null;
        container?.remove();
        container = null;
    }
});
