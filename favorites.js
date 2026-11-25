'use strict';

const STORAGE_KEY = 'favoriteSessionIds';

/**
 * Favorite session ids in VS Code's global extension storage: shared by all windows,
 * kept across extension updates, synced by Settings Sync.
 */
class Favorites {
    constructor(globalState) {
        this.globalState = globalState;
        globalState.setKeysForSync([STORAGE_KEY]);
    }

    has(sessionId) {
        return this.ids().includes(sessionId);
    }

    async add(sessionId) {
        if (!this.has(sessionId)) {
            await this.globalState.update(STORAGE_KEY, [...this.ids(), sessionId]);
        }
    }

    async remove(sessionId) {
        await this.globalState.update(STORAGE_KEY, this.ids().filter((id) => id !== sessionId));
    }

    ids() {
        return this.globalState.get(STORAGE_KEY, []);
    }
}

module.exports = { Favorites };
