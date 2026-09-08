class PluginCancellable {
    constructor() {
        this.cancelled = false;
    }

    cancel() {
        this.cancelled = true;
    }

    is_cancelled() {
        return this.cancelled;
    }
}

const createCancellable = () => new PluginCancellable();

module.exports = { PluginCancellable, createCancellable };
