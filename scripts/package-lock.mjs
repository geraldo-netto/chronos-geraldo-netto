// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// The kernel releases flock when its holder exits. Keeping stdin open holds
// the helper alive; even an interrupted Node process closes that pipe. Never
// unlink the lock file: another writer could still hold its original inode.
export async function withPackageLock(output, action, launch = spawn) {
    await mkdir(path.dirname(output), { recursive: true });
    const child = launch("flock", ["--exclusive", "--nonblock", `${output}.lock`,
        "sh", "-c", "printf 'locked\\n'; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise((resolve) => child.once("close", resolve));
    const ready = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(
            `cannot acquire package lock for ${output} (flock exit ${code})`)));
        child.stdout.once("data", resolve);
    });
    try {
        await ready;
        return await action();
    } finally {
        child.stdin.end();
        await closed;
    }
}
