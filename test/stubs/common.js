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
    dispatch(event, payload) { for (const fn of this.handlers[event] ?? []) fn(payload); }
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

export const useState = React.useState;
export const useEffect = React.useEffect;
export const useRef = React.useRef;
export { createRoot };

// The real hook subscribes to Flux stores and re-renders on their change events.
// This plugin only reads store data, so re-evaluating the mapper on every render
// (which the plugin's own setState / remount triggers) is enough here.
export const useStateFromStores = (_stores, mapper) => mapper();
