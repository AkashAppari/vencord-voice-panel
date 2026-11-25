import * as React from "react";
import { createRoot } from "react-dom/client";

export const state = {
    myChannelId: "chan1",
    voiceStates: {},
    rtcParticipants: [],
    users: {},
    nicks: {},
    channels: {}
};

export const FluxDispatcher = {
    handlers: {},
    subscribe(event, fn) { (this.handlers[event] ??= []).push(fn); },
    unsubscribe(event, fn) { this.handlers[event] = (this.handlers[event] ?? []).filter(f => f !== fn); },
    dispatch(event, payload) {
        for (const fn of this.handlers[event] ?? []) fn(payload);
        for (const notify of storeSubscribers) notify();
    }
};

export const SelectedChannelStore = {
    getVoiceChannelId: () => state.myChannelId,
    addChangeListener() {}, removeChangeListener() {}
};

export const VoiceStateStore = {
    getVoiceStatesForChannel: (channelId) =>
        Object.fromEntries(Object.entries(state.voiceStates).filter(([, s]) => s.channelId === channelId)),
    addChangeListener() {}, removeChangeListener() {}
};

export const ChannelRTCStore = {
    // Mirrors ChannelRTCStore.getParticipants / getParticipant: the participant list Discord's
    // own voice UI renders, carrying `user`, the resolved `userNick` and the `speaking` flag.
    getParticipants: (_channelId) => state.rtcParticipants,
    getParticipant: (_channelId, participantId) =>
        state.rtcParticipants.find(p => p.user?.id === participantId) ?? null,
    addChangeListener() {}, removeChangeListener() {}
};

export const UserStore = {
    getUser: (id) => state.users[id],
    getCurrentUser: () => state.users.me,
    addChangeListener() {}, removeChangeListener() {}
};

export const ChannelStore = {
    getChannel: (id) => state.channels[id],
    addChangeListener() {}, removeChangeListener() {}
};

export const GuildMemberStore = {
    getNick: (guildId, userId) => state.nicks[userId] ?? null,
    addChangeListener() {}, removeChangeListener() {}
};

// Records every call so the harness can assert on them. `window` is what getWindow hands back while
// the harness has the popout marked open; leave it null to simulate a window that never appears.
export const popout = { calls: [], open: false, alwaysOnTop: true, window: null };

export const PopoutActions = {
    open(key, render, features) { popout.calls.push({ fn: "open", key, render, features }); },
    close(key) { popout.calls.push({ fn: "close", key }); popout.open = false; },
    setAlwaysOnTop(key, value) { popout.calls.push({ fn: "setAlwaysOnTop", key, value }); popout.alwaysOnTop = value; }
};

export const PopoutWindowStore = {
    getWindow: () => (popout.open ? popout.window ?? undefined : undefined),
    getWindowOpen: () => popout.open,
    getIsAlwaysOnTop: () => popout.alwaysOnTop,
    addChangeListener() {}, removeChangeListener() {}
};

export const useState = React.useState;
export const useEffect = React.useEffect;
export const useRef = React.useRef;
export { createRoot };

// The real hook subscribes to Flux stores and re-renders on their change events. The stubbed stores
// keep their data in `state` and never emit, so every dispatch notifies these subscribers instead -
// that is what makes a live update (a mute toggled, someone joining) reach the rendered output
// rather than only appearing when the plugin's own state happens to change.
const storeSubscribers = new Set();

export function useStateFromStores(_stores, mapper) {
    const [, forceRender] = React.useReducer(count => count + 1, 0);

    React.useEffect(() => {
        storeSubscribers.add(forceRender);
        return () => { storeSubscribers.delete(forceRender); };
    }, []);

    return mapper();
}
