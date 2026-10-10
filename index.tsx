/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
    useState,
    useStateFromStores,
    UserStore,
    VoiceStateStore
} from "@webpack/common";

import "./style.css";

const cl = classNameFactory("vc-voiceChannelPanel-");
const logger = new Logger("VoiceChannelPanel");

// ParticipantType.USER from Vencord's discord-types. That module declares it as a `const enum`,
// which esbuild cannot inline at runtime, so the value is spelled out here rather than imported.
const PARTICIPANT_TYPE_USER: number = 2;

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
    text: string;
    kind: "join" | "leave";
}

interface DragStartEvent {
    clientX: number;
    clientY: number;
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
// back "" for "no nickname" instead of null.
function displayName(userId: string, guildId: string | null | undefined, fallback: string) {
    const user = UserStore.getUser(userId);
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : null;

    return nick || user?.globalName || user?.username || fallback;
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
        .map(p => p as any)
        .filter(p => p.type === PARTICIPANT_TYPE_USER && !!p.user)
        .map(p => {
            const vs = p.voiceState;
            const rowGuildId = vs?.guildId ?? guildId;

            return {
                userId: p.user.id,
                name: p.userNick || displayName(p.user.id, rowGuildId, "Unknown"),
                avatarUrl: p.user.getAvatarURL(rowGuildId, 24),
                speaking: !!p.speaking,
                mute: !!(vs?.selfMute || vs?.mute),
                deaf: !!(vs?.selfDeaf || vs?.deaf),
                stream: !!(vs?.selfStream || vs?.stream),
                video: !!vs?.selfVideo,
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
            const userId = state.userId;
            const user = UserStore.getUser(userId);

            return {
                userId,
                name: displayName(userId, guildId, "Unknown"),
                // A row with no resolvable user still renders, so a missing entity can never
                // silently empty the whole member list.
                avatarUrl: user?.getAvatarURL(guildId, 24) ?? "",
                speaking: false,
                mute: !!(state.selfMute || state.mute),
                deaf: !!(state.selfDeaf || state.deaf),
                stream: !!(state.selfStream || state.stream),
                video: !!state.selfVideo,
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
    try {
        const participant = ChannelRTCStore.getParticipant(channelId, userId) as any;
        if (participant?.userNick) return participant.userNick;
    } catch {
        // fall through to the store-based lookup below
    }

    return displayName(userId, ChannelStore.getChannel(channelId)?.guild_id, fallback);
}

function Panel() {
    const channelId = useStateFromStores(
        [SelectedChannelStore, VoiceStateStore],
        () => SelectedChannelStore.getVoiceChannelId()
    );

    const { offsetLeft, offsetBottom, width, showLog } = settings.use([
        "offsetLeft", "offsetBottom", "width", "showLog"
    ]);

    const rows = useStateFromStores(
        [VoiceStateStore, UserStore, ChannelStore, ChannelRTCStore],
        () => (channelId ? readRows(channelId) : [])
    );

    const [log, setLog] = useState<LogEntry[]>([]);
    const dragCleanup = useRef<(() => void) | null>(null);

    useEffect(() => {
        setLog([]);
    }, [channelId]);

    useEffect(() => {
        if (!channelId) return;

        const handler = (e: { voiceStates: VoiceStateChangeEvent[]; }) => {
            try {
                const myId = UserStore.getCurrentUser().id;

                for (const state of e.voiceStates) {
                    if (state.userId === myId) continue;

                    const left = state.oldChannelId === channelId && state.channelId !== channelId;
                    const joined = state.channelId === channelId && state.oldChannelId !== channelId;

                    if (!left && !(joined && settings.store.showJoins)) continue;

                    const kind: LogEntry["kind"] = left ? "leave" : "join";
                    const name = nameForLog(state.userId, channelId, "Someone");
                    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
                    const text = `${name} ${kind === "leave" ? "left" : "joined"} - ${time}`;

                    setLog(prev => [{ id: Date.now() + Math.random(), text, kind }, ...prev].slice(0, settings.store.logSize));
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

                const maxLeft = window.innerWidth - 80;
                const minLeft = 80 - settings.store.width;
                const left = Math.min(Math.max(startLeft + (moveEvent.clientX - startX), minLeft), maxLeft);
                const bottom = Math.min(Math.max(startBottom - (moveEvent.clientY - startY), 0), window.innerHeight - 60);

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

    return (
        <div
            className={cl("panel")}
            style={{
                position: "fixed",
                left: `${offsetLeft}px`,
                bottom: `${offsetBottom}px`,
                width: `${width}px`,
                zIndex: 1002
            }}
        >
            <div className={cl("header")} onMouseDown={onHeaderMouseDown}>
                <span className={cl("title")}>{channel?.name ?? "Voice"}</span>
                <span className={cl("count")}>{rows.length}</span>
            </div>
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
                            {row.mute && <Microphone height={14} width={14} />}
                            {row.deaf && <span className={cl("badge")}>D</span>}
                            {row.stream && <ScreenshareIcon height={14} width={14} />}
                            {row.video && <span className={cl("badge")}>cam</span>}
                        </span>
                    </div>
                ))}
            </div>
            {showLog && log.length > 0 && (
                <div className={cl("log")}>
                    {log.map(entry => (
                        <div key={entry.id} className={cl("log-entry", entry.kind)}>{entry.text}</div>
                    ))}
                </div>
            )}
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
        document.body.appendChild(container);
        root = createRoot(container);
        root.render(<PanelWithErrorBoundary />);
    },

    stop() {
        root?.unmount();
        root = null;
        container?.remove();
        container = null;
    }
});
