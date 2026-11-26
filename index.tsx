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

const OVERLAY_THROTTLE_MS = 400;

// Icon geometry from Material Symbols (Apache-2.0, google/material-design-icons),
// except the microphone and screen-share glyphs which come from Discord's own set.
function HeadphonesIcon({ size }: { size: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 1a9 9 0 0 0-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7a9 9 0 0 0-9-9z" />
        </svg>
    );
}

function VideoIcon({ size }: { size: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
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
    overlaySnapshot: {
        type: OptionType.BOOLEAN,
        description: "Write the panel state to settings for the desktop overlay to read",
        default: false
    },
    // The JSON the desktop overlay reads. CUSTOM so it is persisted but never shown in the settings UI.
    overlay: {
        type: OptionType.CUSTOM,
        default: ""
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
 * The join/leave log lives at module level rather than in Panel's state, so stop() can clear it.
 * Panel (always mounted while the plugin runs) is the only writer.
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

/** The member rows and the join/leave log, rendered by the docked/floating panel. */
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
            {showLog && (
                <div className={cl("log")} role="log" aria-live="polite" aria-relevant="additions" aria-label="Join and leave activity">
                    {log.map(entry => (
                        <div key={entry.id} className={cl("log-entry", entry.kind)}>{entry.text}</div>
                    ))}
                </div>
            )}
        </>
    );
}

const EMPTY_OVERLAY = { channel: null, count: 0, members: [], log: [] };
let lastOverlay = ""; // the snapshot body last written, without its timestamp; "" = nothing written yet
let lastOverlayAt = 0;
let overlayTimer: ReturnType<typeof setTimeout> | undefined;

/** Throttled and deduplicated: at most one write per OVERLAY_THROTTLE_MS, none for an unchanged state. */
function writeOverlay(data: object, force = false) {
    clearTimeout(overlayTimer);
    overlayTimer = undefined;

    const body = JSON.stringify(data);
    if (body === lastOverlay) return;

    const wait = lastOverlayAt + OVERLAY_THROTTLE_MS - Date.now();
    if (wait > 0 && !force) {
        overlayTimer = setTimeout(() => writeOverlay(data), wait);
        return;
    }

    try {
        settings.store.overlay = JSON.stringify({ t: Date.now(), ...data });
        lastOverlay = body;
        lastOverlayAt = Date.now();
    } catch (err) {
        logger.error("Could not write the overlay snapshot", err);
    }
}

function Panel() {
    const { channelId, rows } = useVoiceRows();

    const { offsetLeft, offsetBottom, width, showLog, overlaySnapshot } = settings.use([
        "offsetLeft", "offsetBottom", "width", "showLog", "overlaySnapshot"
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

    useEffect(() => {
        // Off and never written: leave the settings file alone. Switched off after writing: clear it.
        if (!overlaySnapshot && !lastOverlay) return;
        if (!overlaySnapshot || !channelId) return writeOverlay(EMPTY_OVERLAY);

        writeOverlay({
            channel: ChannelStore.getChannel(channelId)?.name ?? "Voice",
            count: rows.length,
            members: rows.map(r => ({ name: r.name, mute: r.mute, deaf: r.deaf, screen: r.stream, cam: r.video, speaking: r.speaking })),
            log: log.filter(e => e.channelId === channelId).map(e => ({ text: e.text, kind: e.kind }))
        });
    }, [overlaySnapshot, channelId, rows, log]);

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
        if (lastOverlay) writeOverlay(EMPTY_OVERLAY, true);
        clearTimeout(overlayTimer);
        lastOverlay = "";
        lastOverlayAt = 0;
        sharedLog = [];
        root?.unmount();
        root = null;
        container?.remove();
        container = null;
    }
});
