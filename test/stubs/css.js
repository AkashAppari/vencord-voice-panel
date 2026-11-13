export const classNameFactory = (prefix = "") => (...args) =>
    args.filter(Boolean).map(a => prefix + a).join(" ");
