export class Logger {
    constructor(name) { this.name = name; }
    info(...a) { console.log(`[${this.name}]`, ...a); }
    warn(...a) { console.warn(`[${this.name}]`, ...a); }
    error(...a) { console.error(`[${this.name}]`, ...a); }
}
