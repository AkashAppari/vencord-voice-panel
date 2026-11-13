export const store = {};

export function definePluginSettings(def) {
    for (const [key, value] of Object.entries(def)) store[key] = value.default;

    return {
        def,
        store,
        plain: store,
        use: (keys) => Object.fromEntries(keys.map(k => [k, store[k]]))
    };
}
