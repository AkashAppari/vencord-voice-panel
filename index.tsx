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

function displayName(userId: string, guildId: string | null | undefined, fallback: string) {
    const user = UserStore.getUser(userId);
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : null;

    return nick ?? user?.globalName ?? user?.username ?? fallback;
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
        [VoiceStateStore, UserStore, ChannelStore],
        () => Object.values(VoiceStateStore.getVoiceStatesForChannel(channelId!) ?? {})
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
                const guildId = ChannelStore.getChannel(channelId)?.guild_id;

                for (const state of e.voiceStates) {
                    if (state.userId === myId) continue;

                    const left = state.oldChannelId === channelId && state.channelId !== channelId;
                    const joined = state.channelId === channelId && state.oldChannelId !== channelId;

                    if (!left && !(joined && settings.store.showJoins)) continue;

                    const kind: LogEntry["kind"] = left ? "leave" : "join";
                    const name = displayName(state.userId, guildId, "Someone");
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
    const guildId = channel?.guild_id;
    const myId = UserStore.getCurrentUser().id;

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
                {rows.map(state => {
                    const user = UserStore.getUser(state.userId);
                    if (!user) return null;

                    const isMe = state.userId === myId;

                    return (
                        <div key={state.userId} className={isMe ? `${cl("row")} ${cl("me")}` : cl("row")}>
                            <img className={cl("avatar")} src={user.getAvatarURL(guildId, 24)} alt="" />
                            <span className={cl("name")}>{displayName(state.userId, guildId, "Unknown")}</span>
                            <span className={cl("badges")}>
                                {(state.selfMute || state.mute) && <Microphone height={14} width={14} />}
                                {(state.selfDeaf || state.deaf) && <span className={cl("badge")}>D</span>}
                                {(state.selfStream || state.stream) && <ScreenshareIcon height={14} width={14} />}
                                {state.selfVideo && <span className={cl("badge")}>cam</span>}
                            </span>
                        </div>
                    );
                })}
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
